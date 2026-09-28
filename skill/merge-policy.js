#!/usr/bin/env node
'use strict';

/*
 * merge-policy.js — the mechanical half of /pr-review-loop auto mode.
 *
 *   node merge-policy.js <pr> [--repo owner/name]
 *   node merge-policy.js --match <glob> <path>      # self-test helper
 *
 * Reads the policy from the PR's BASE branch (so a PR cannot loosen its own gate), measures the PR
 * with `gh`, and prints one JSON object:
 *
 *   {"decision":"ask"|"eligible","reasons":[...],"policy":{...},"policySource":"...",
 *    "changedFiles":n,"changedLines":n,"askMatches":[{"path":..,"glob":..}]}
 *
 * "eligible" only means the diff-shaped rules pass. The review-shaped rules (clean review, no
 * declined findings) are judged by the skill on top. Any error → decision "ask" (fail closed).
 * Exit code is 0 whenever JSON was printed.
 */

const { execFileSync } = require('child_process');

const POLICY_PATH = '.claude/pr-review-loop.json';
const DEFAULTS = { ask_paths: [], max_changed_lines: 1500, max_changed_files: 25 };

function expandBraces(glob) {
  const m = glob.match(/^(.*?)\{([^{}]*)\}(.*)$/);
  if (!m) return [glob];
  const out = [];
  for (const alt of m[2].split(',')) out.push(...expandBraces(m[1] + alt + m[3]));
  return out;
}

function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        const atSegStart = i === 0 || glob[i - 1] === '/';
        const nextIsSlash = glob[i + 2] === '/';
        if (atSegStart && nextIsSlash) { re += '(?:.*/)?'; i += 2; continue; }
        re += '.*'; i += 1; continue;
      }
      re += '[^/]*';
    } else if (ch === '?') {
      re += '[^/]';
    } else {
      re += ch.replace(/[.+^$()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp('^' + re + '$');
}

function matches(glob, path) {
  return expandBraces(glob).some((g) => globToRegExp(g).test(path));
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function loadPolicy(repoArgs, base) {
  let raw;
  try {
    raw = gh(['api', ...repoArgs.api, '-H', 'Accept: application/vnd.github.raw',
      `repos/${repoArgs.slug}/contents/${POLICY_PATH}?ref=${encodeURIComponent(base)}`]);
  } catch (e) {
    const msg = String((e.stderr || '') + (e.stdout || '') + e.message);
    if (/404|Not Found/i.test(msg)) return { policy: { ...DEFAULTS }, source: 'defaults (no policy file on base)' };
    throw new Error(`could not read ${POLICY_PATH} from ${base}: ${msg.trim().split('\n')[0]}`);
  }
  const parsed = JSON.parse(raw);
  const policy = { ...DEFAULTS, ...parsed };
  if (!Array.isArray(policy.ask_paths) || !policy.ask_paths.every((g) => typeof g === 'string')) {
    throw new Error('ask_paths must be an array of strings');
  }
  for (const k of ['max_changed_lines', 'max_changed_files']) {
    if (typeof policy[k] !== 'number' || !(policy[k] >= 0)) throw new Error(`${k} must be a non-negative number`);
  }
  return { policy, source: `${POLICY_PATH}@${base}` };
}

function main(argv) {
  if (argv[0] === '--match') {
    const ok = matches(argv[1], argv[2]);
    console.log(ok ? 'match' : 'no-match');
    process.exit(ok ? 0 : 1);
  }
  const pr = argv[0];
  const ri = argv.indexOf('--repo');
  const repoFlag = ri >= 0 ? argv[ri + 1] : null;
  const out = { decision: 'ask', reasons: [] };
  try {
    if (!pr || !/^\d+$/.test(pr)) throw new Error('usage: merge-policy.js <pr-number> [--repo owner/name]');
    const viewRepo = repoFlag ? ['--repo', repoFlag] : [];
    const info = JSON.parse(gh(['pr', 'view', pr, ...viewRepo, '--json',
      'additions,deletions,changedFiles,baseRefName,state,isDraft,url']));
    const slug = repoFlag || info.url.replace(/^https:\/\/[^/]+\//, '').replace(/\/pull\/\d+$/, '');
    const names = gh(['pr', 'diff', pr, ...viewRepo, '--name-only']).split(/\r?\n/).filter(Boolean);
    const { policy, source } = loadPolicy({ slug, api: [] }, info.baseRefName);

    const changedLines = info.additions + info.deletions;
    const changedFiles = Math.max(info.changedFiles, names.length);
    const askMatches = [];
    for (const path of names) {
      if (path === POLICY_PATH) { askMatches.push({ path, glob: '(the policy file itself)' }); continue; }
      const glob = policy.ask_paths.find((g) => matches(g, path));
      if (glob) askMatches.push({ path, glob });
    }

    const reasons = [];
    if (info.state !== 'OPEN') reasons.push(`PR is ${info.state}, not OPEN`);
    if (info.isDraft) reasons.push('PR is a draft');
    if (askMatches.length) reasons.push(`${askMatches.length} changed file(s) match ask_paths`);
    if (changedLines > policy.max_changed_lines) reasons.push(`${changedLines} changed lines > max_changed_lines ${policy.max_changed_lines}`);
    if (changedFiles > policy.max_changed_files) reasons.push(`${changedFiles} changed files > max_changed_files ${policy.max_changed_files}`);

    Object.assign(out, {
      decision: reasons.length ? 'ask' : 'eligible',
      reasons, policy, policySource: source, changedFiles, changedLines, askMatches,
    });
  } catch (e) {
    out.reasons.push(`policy check failed (fail closed): ${e.message}`);
  }
  console.log(JSON.stringify(out, null, 2));
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { matches, globToRegExp, expandBraces };
