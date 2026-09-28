#!/usr/bin/env node
'use strict';

/*
 * merge-policy.js — the mechanical half of /pr-review-loop auto mode.
 *
 *   node merge-policy.js <pr> --expect-head <sha> [--repo owner/name]
 *   node merge-policy.js --match <glob> <path>      # self-test helper
 *
 * Reads the policy from the PR's BASE branch (so a PR cannot loosen its own gate), measures the PR
 * with `gh`, and prints one JSON object:
 *
 *   {"decision":"ask"|"eligible","reasons":[...],"policy":{...},"policySource":"...",
 *    "changedFiles":n,"changedLines":n,"askMatches":[{"path":..,"glob":..}],
 *    "headRefOid":"...","mergeStateStatus":"...","checks":{...},"mergeCommand":[...]}
 *
 * "eligible" only means the mechanical rules pass (diff shape, merge state, checks, head pinned to
 * the reviewed SHA). The review-shaped rules (clean review, no declined findings) are judged by the
 * skill on top. Any error → decision "ask" (fail closed). `mergeCommand` is present only when
 * eligible; it pins --match-head-commit so a push after the check makes the merge fail instead of
 * merging unreviewed code. Exit code is 0 whenever JSON was printed.
 */

const { execFileSync } = require('child_process');

const POLICY_PATH = '.claude/pr-review-loop.json';
const DEFAULTS = { ask_paths: [], max_changed_lines: 1500, max_changed_files: 25, merge_method: 'squash' };
const MERGE_METHODS = ['squash', 'merge', 'rebase'];
const MERGEABLE_STATES = ['CLEAN', 'HAS_HOOKS'];
const MAX_GLOB_LENGTH = 512;
const MAX_ASK_PATHS = 500;
const MAX_BRACE_EXPANSIONS = 64;
const SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_RE = /^[0-9a-f]{40}$/;

// --- globs ------------------------------------------------------------------------------------
// `*` stays inside one path segment, `**` spans segments (`**/` at a segment start also matches
// nothing), `?` is one non-slash character, `{a,b}` alternates. Everything else is literal.
// Matching is a dynamic programme over (token, position) — linear in glob × path, so no pattern
// (however many stars) can backtrack catastrophically. Brace expansion is capped.

function expandBraces(glob, budget = { left: MAX_BRACE_EXPANSIONS }) {
  const m = glob.match(/^(.*?)\{([^{}]*)\}(.*)$/);
  if (!m) {
    if (--budget.left < 0) throw new Error(`glob expands to more than ${MAX_BRACE_EXPANSIONS} alternatives: ${glob.slice(0, 80)}`);
    return [glob];
  }
  const out = [];
  for (const alt of m[2].split(',')) out.push(...expandBraces(m[1] + alt + m[3], budget));
  return out;
}

const LIT = 0, ONE = 1, STAR = 2, ANY = 3, SEGS = 4;

function tokenize(glob) {
  const toks = [];
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        const atSegStart = i === 0 || glob[i - 1] === '/';
        if (atSegStart && glob[i + 2] === '/') { toks.push({ t: SEGS }); i += 2; continue; }
        while (glob[i + 1] === '*') i++;
        if (!toks.length || toks[toks.length - 1].t !== ANY) toks.push({ t: ANY });
        continue;
      }
      if (!toks.length || (toks[toks.length - 1].t !== STAR && toks[toks.length - 1].t !== ANY)) toks.push({ t: STAR });
    } else if (ch === '?') {
      toks.push({ t: ONE });
    } else {
      toks.push({ t: LIT, c: ch });
    }
  }
  return toks;
}

function matchOne(glob, path) {
  const toks = tokenize(glob);
  const n = path.length;
  // next[p] = does toks[k+1..] match path[p..]; cur[p] = same for toks[k..].
  let next = new Uint8Array(n + 1);
  next[n] = 1;
  for (let k = toks.length - 1; k >= 0; k--) {
    const tok = toks[k];
    const cur = new Uint8Array(n + 1);
    let seen = 0; // SEGS: some q >= p with path[q] === '/' and next[q + 1]
    for (let p = n; p >= 0; p--) {
      switch (tok.t) {
        case LIT: cur[p] = p < n && path[p] === tok.c && next[p + 1] ? 1 : 0; break;
        case ONE: cur[p] = p < n && path[p] !== '/' && next[p + 1] ? 1 : 0; break;
        case STAR: cur[p] = next[p] || (p < n && path[p] !== '/' && cur[p + 1]) ? 1 : 0; break;
        case ANY: cur[p] = next[p] || (p < n && cur[p + 1]) ? 1 : 0; break;
        case SEGS:
          if (p < n && path[p] === '/' && next[p + 1]) seen = 1;
          cur[p] = next[p] || seen ? 1 : 0;
          break;
      }
    }
    next = cur;
  }
  return next[0] === 1;
}

function matches(glob, path) {
  if (typeof glob !== 'string' || glob.length > MAX_GLOB_LENGTH) {
    throw new Error(`ask_paths entries must be strings of at most ${MAX_GLOB_LENGTH} characters`);
  }
  return expandBraces(glob).some((g) => matchOne(g, path));
}

// --- policy -----------------------------------------------------------------------------------

function validatePolicy(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${POLICY_PATH} must be a JSON object`);
  const policy = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) if (Object.prototype.hasOwnProperty.call(parsed, k)) policy[k] = parsed[k];
  if (!Array.isArray(policy.ask_paths) || policy.ask_paths.length > MAX_ASK_PATHS) {
    throw new Error(`ask_paths must be an array of at most ${MAX_ASK_PATHS} strings`);
  }
  for (const g of policy.ask_paths) {
    if (typeof g !== 'string' || !g || g.length > MAX_GLOB_LENGTH) throw new Error(`ask_paths entries must be non-empty strings of at most ${MAX_GLOB_LENGTH} characters`);
    expandBraces(g);
  }
  for (const k of ['max_changed_lines', 'max_changed_files']) {
    if (!Number.isInteger(policy[k]) || policy[k] < 0) throw new Error(`${k} must be a non-negative integer`);
  }
  if (!MERGE_METHODS.includes(policy.merge_method)) throw new Error(`merge_method must be one of ${MERGE_METHODS.join(', ')}`);
  return policy;
}

function summarizeChecks(rollup) {
  const out = { total: 0, failing: [], pending: [] };
  for (const c of Array.isArray(rollup) ? rollup : []) {
    out.total++;
    const name = c.name || c.context || '(unnamed check)';
    if (c.__typename === 'StatusContext' || (c.state && !c.status)) {
      if (c.state === 'SUCCESS') continue;
      if (c.state === 'PENDING' || c.state === 'EXPECTED') out.pending.push(name); else out.failing.push(name);
    } else {
      if (c.status !== 'COMPLETED') { out.pending.push(name); continue; }
      if (!['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(c.conclusion)) out.failing.push(name);
    }
  }
  return out;
}

// Pure decision function: everything gh returned goes in, the JSON verdict comes out.
function evaluate({ pr, repoFlag, info, files, policy, policySource, expectHead }) {
  const reasons = [];
  if (!policy) {
    reasons.push(`no ${POLICY_PATH} on the base branch — auto merge needs an explicit policy (see README)`);
    policy = { ...DEFAULTS };
  }
  const changedLines = info.additions + info.deletions;
  const changedFiles = Math.max(info.changedFiles, new Set(files.map((f) => f.path)).size);
  const askMatches = [];
  for (const f of files) {
    for (const path of [f.path, f.previous].filter(Boolean)) {
      if (path === POLICY_PATH) { askMatches.push({ path, glob: '(the policy file itself)' }); continue; }
      const glob = policy.ask_paths.find((g) => matches(g, path));
      if (glob) askMatches.push({ path, glob });
    }
  }
  const checks = summarizeChecks(info.statusCheckRollup);

  if (info.state !== 'OPEN') reasons.push(`PR is ${info.state}, not OPEN`);
  if (info.isDraft) reasons.push('PR is a draft');
  if (info.isCrossRepository) reasons.push('PR comes from a fork (auto merge only covers same-repo branches)');
  if (askMatches.length) reasons.push(`${askMatches.length} changed path(s) match ask_paths`);
  if (changedLines > policy.max_changed_lines) reasons.push(`${changedLines} changed lines > max_changed_lines ${policy.max_changed_lines}`);
  if (changedFiles > policy.max_changed_files) reasons.push(`${changedFiles} changed files > max_changed_files ${policy.max_changed_files}`);
  if (!MERGEABLE_STATES.includes(info.mergeStateStatus)) reasons.push(`mergeStateStatus is ${info.mergeStateStatus || 'missing'}, not CLEAN or HAS_HOOKS`);
  if (checks.failing.length) reasons.push(`failing checks: ${checks.failing.join(', ')}`);
  if (checks.pending.length) reasons.push(`pending checks: ${checks.pending.join(', ')}`);
  if (!expectHead) reasons.push('no --expect-head given (the reviewed SHA), so the merge cannot be pinned');
  else if (info.headRefOid !== expectHead) reasons.push(`PR head ${info.headRefOid} is not the reviewed SHA ${expectHead}`);

  const out = {
    decision: reasons.length ? 'ask' : 'eligible',
    reasons, policy, policySource, changedFiles, changedLines, askMatches,
    headRefOid: info.headRefOid, mergeStateStatus: info.mergeStateStatus, checks,
  };
  if (!reasons.length) {
    out.mergeCommand = ['gh', 'pr', 'merge', String(pr), ...(repoFlag ? ['--repo', repoFlag] : []),
      `--${policy.merge_method}`, '--match-head-commit', info.headRefOid];
  }
  return out;
}

// --- gh I/O -----------------------------------------------------------------------------------

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

function loadPolicy(slug, base) {
  let raw;
  try {
    raw = gh(['api', '-H', 'Accept: application/vnd.github.raw',
      `repos/${slug}/contents/${POLICY_PATH}?ref=${encodeURIComponent(base)}`]);
  } catch (e) {
    const msg = String((e.stderr || '') + (e.stdout || '') + e.message);
    if (/HTTP 404/.test(msg)) return { policy: null, source: 'none (no policy file on base)' };
    throw new Error(`could not read ${POLICY_PATH} from ${base}: ${msg.trim().split('\n')[0]}`);
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { throw new Error(`${POLICY_PATH} on ${base} is not valid JSON: ${e.message}`); }
  return { policy: validatePolicy(parsed), source: `${POLICY_PATH}@${base}` };
}

function listFiles(slug, pr) {
  const out = gh(['api', '--paginate', `repos/${slug}/pulls/${pr}/files?per_page=100`,
    '--jq', '.[] | {path: .filename, previous: .previous_filename}']);
  return out.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}

function parseArgs(argv) {
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : null;
  };
  return { pr: argv[0], repoFlag: flag('--repo'), expectHead: flag('--expect-head') };
}

function main(argv) {
  if (argv[0] === '--match') {
    const ok = matches(argv[1], argv[2]);
    console.log(ok ? 'match' : 'no-match');
    process.exit(ok ? 0 : 1);
  }
  const { pr, repoFlag, expectHead } = parseArgs(argv);
  let out = { decision: 'ask', reasons: [] };
  try {
    if (!pr || !/^\d+$/.test(pr)) throw new Error('usage: merge-policy.js <pr-number> --expect-head <sha> [--repo owner/name]');
    if (repoFlag !== null && !SLUG_RE.test(repoFlag)) throw new Error('--repo must look like owner/name');
    if (expectHead !== null && !SHA_RE.test(expectHead)) throw new Error('--expect-head must be a full 40-character commit SHA');
    const viewRepo = repoFlag ? ['--repo', repoFlag] : [];
    const info = JSON.parse(gh(['pr', 'view', pr, ...viewRepo, '--json',
      'additions,deletions,changedFiles,baseRefName,state,isDraft,url,headRefOid,isCrossRepository,mergeStateStatus,statusCheckRollup']));
    const slug = repoFlag || info.url.replace(/^https:\/\/[^/]+\//, '').replace(/\/pull\/\d+$/, '');
    if (!SLUG_RE.test(slug)) throw new Error(`could not derive owner/name from ${info.url}`);
    const files = listFiles(slug, pr);
    const { policy, source } = loadPolicy(slug, info.baseRefName);
    out = evaluate({ pr, repoFlag, info, files, policy, policySource: source, expectHead });
  } catch (e) {
    out.reasons.push(`policy check failed (fail closed): ${e.message}`);
  }
  console.log(JSON.stringify(out, null, 2));
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { matches, expandBraces, validatePolicy, summarizeChecks, evaluate, DEFAULTS };
