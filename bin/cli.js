#!/usr/bin/env node
'use strict';

/*
 * claude-pr-review-loop — install the /pr-review-loop skill into your Claude Code user scope,
 * and scaffold the CI workflow a repo needs to answer @claude.
 *
 * Zero runtime dependencies. Node >= 16.
 *
 *   npx github:adevra/claude-pr-review-loop            # install the skill globally (~/.claude/skills)
 *   npx github:adevra/claude-pr-review-loop init       # scaffold .github/workflows/claude.yml here
 *   npx github:adevra/claude-pr-review-loop uninstall   # remove the global skill
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const PKG_ROOT = path.resolve(__dirname, '..');
const SKILL_SRC = path.join(PKG_ROOT, 'skill');
const TEMPLATE_SRC = path.join(PKG_ROOT, 'template');

const SKILL_NAME = 'pr-review-loop';
const SKILL_DEST = path.join(os.homedir(), '.claude', 'skills', SKILL_NAME);

// --- tiny ANSI helpers (no deps) ---
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => c('1', s);
const green = (s) => c('32', s);
const cyan = (s) => c('36', s);
const yellow = (s) => c('33', s);
const dim = (s) => c('2', s);
const ok = (s) => console.log(`${green('✓')} ${s}`);
const info = (s) => console.log(`${cyan('›')} ${s}`);
const warn = (s) => console.log(`${yellow('!')} ${s}`);

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function install() {
  if (!fs.existsSync(SKILL_SRC)) {
    console.error(`Cannot find packaged skill at ${SKILL_SRC}`);
    process.exit(1);
  }
  const existed = fs.existsSync(SKILL_DEST);
  fs.mkdirSync(SKILL_DEST, { recursive: true });

  for (const file of fs.readdirSync(SKILL_SRC)) {
    const src = path.join(SKILL_SRC, file);
    if (!fs.statSync(src).isFile()) continue;
    const dest = path.join(SKILL_DEST, file);
    copyFile(src, dest);
    if (file.endsWith('.sh')) {
      try { fs.chmodSync(dest, 0o755); } catch (_) { /* best effort (no-op on Windows) */ }
    }
  }

  console.log('');
  ok(`${existed ? 'Updated' : 'Installed'} the ${bold('/pr-review-loop')} skill`);
  console.log(`  ${dim(SKILL_DEST)}`);
  console.log('');
  info(`It's now available in ${bold('every')} Claude Code session. Restart any open session to load it.`);
  console.log('');
  console.log(bold('Next, in each repo you want to review:'));
  console.log(`  ${cyan('npx github:adevra/claude-pr-review-loop init')}   ${dim('# scaffolds .github/workflows/claude.yml')}`);
  console.log('');
  console.log(`Then run ${bold('/pr-review-loop')} in Claude Code on a feature branch.`);
  console.log('');
}

function init() {
  if (!fs.existsSync(path.join(process.cwd(), '.git'))) {
    warn(`This doesn't look like a git repository (${dim(process.cwd())}).`);
    warn('Run `init` from the root of the repo you want to set up.');
  }
  const destDir = path.join(process.cwd(), '.github', 'workflows');
  const dest = path.join(destDir, 'claude.yml');

  console.log('');
  if (fs.existsSync(dest)) {
    info(`.github/workflows/claude.yml already exists — leaving it untouched.`);
  } else {
    copyFile(path.join(TEMPLATE_SRC, 'claude.yml'), dest);
    ok('Scaffolded .github/workflows/claude.yml');
  }
  console.log('');
  console.log(bold('One required secret') + ' — the workflow needs a Claude Code OAuth token:');
  console.log(`  ${dim('1.')} Generate one:  ${cyan('claude setup-token')}`);
  console.log(`  ${dim('2.')} Add it to the repo:  ${cyan('gh secret set CLAUDE_CODE_OAUTH_TOKEN')}`);
  console.log('');
  console.log(`Commit the workflow, then ${bold('/pr-review-loop')} will be able to drive reviews here.`);
  console.log('');
}

function uninstall() {
  console.log('');
  if (fs.existsSync(SKILL_DEST)) {
    fs.rmSync(SKILL_DEST, { recursive: true, force: true });
    ok(`Removed ${SKILL_DEST}`);
  } else {
    info('Nothing to remove — the skill is not installed.');
  }
  console.log('');
}

function help() {
  console.log(`
${bold('claude-pr-review-loop')} — the /pr-review-loop skill for Claude Code, everywhere.

${bold('Usage')}
  ${cyan('npx github:adevra/claude-pr-review-loop')} ${dim('[command]')}

${bold('Commands')}
  ${cyan('install')}     ${dim('(default)')} Install the skill into ~/.claude/skills (user scope)
  ${cyan('init')}        Scaffold .github/workflows/claude.yml in the current repo
  ${cyan('uninstall')}   Remove the global skill
  ${cyan('help')}        Show this message
`);
}

const cmd = (process.argv[2] || 'install').toLowerCase();
switch (cmd) {
  case 'install': case 'i': install(); break;
  case 'init': init(); break;
  case 'uninstall': case 'remove': case 'rm': uninstall(); break;
  case 'help': case '--help': case '-h': help(); break;
  default:
    console.error(`Unknown command: ${cmd}\n`);
    help();
    process.exit(1);
}
