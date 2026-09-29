'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { matches, expandBraces, validatePolicy, evaluate, DEFAULTS } = require('../skill/merge-policy.js');

let failed = 0;
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { failed++; console.error(`FAIL ${name}\n  ${e.message}`); }
}

// --- glob semantics -------------------------------------------------------------------------
const cases = [
  ['db/**', 'db/migrations/2026_x.sql', true],
  ['db/**', 'db-ish/a.ts', false],
  ['**/*.sql', 'a.sql', true],
  ['**/*.sql', 'deep/er/a.sql', true],
  ['**/*.sql', 'a.sqlx', false],
  ['*.sql', 'deep/a.sql', false],
  ['app/**/payout*', 'app/payouts.tsx', true],
  ['app/**/payout*', 'app/(tabs)/settings/payout-setup.tsx', true],
  ['src/services/auth*', 'src/services/auth.ts', true],
  ['src/services/auth*', 'src/services/authz/x.ts', false],
  ['.github/**', '.github/workflows/claude.yml', true],
  ['.claude/**', '.claude/settings.json', true],
  ['src/content/{privacy,terms}/**', 'src/content/terms/tr.md', true],
  ['src/content/{privacy,terms}/**', 'src/content/blog/tr.md', false],
  ['package*.json', 'package-lock.json', true],
  ['package*.json', 'app/package.json', false],
  ['**/package.json', 'packages/web/package.json', true],
  ['wrangler.*', 'wrangler.jsonc', true],
  ['a?c', 'abc', true],
  ['a?c', 'a/c', false],
  ['a.b', 'axb', false],
  ['a[0]', 'a[0]', true],
  ['a(b|c)', 'ab', false],
  ['a**b', 'a/x/b', true],
  ['**', 'any/thing/at/all', true],
  ['**/.env.*', 'config/.env.production', true],
  ['**/.env.*', 'config/.envrc', false],
  ['{a,b{c,d}}/x', 'bd/x', true],
  ['', '', true],
  ['', 'a', false],
];
for (const [glob, p, want] of cases) {
  test(`matches(${JSON.stringify(glob)}, ${JSON.stringify(p)}) === ${want}`, () => assert.strictEqual(matches(glob, p), want));
}

// --- catastrophic patterns: must stay fast (the matcher is a linear DP, not a backtracking regex)
const bombs = [
  ['*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*b', 'a'.repeat(4000)],
  ['**a**a**a**a**a**a**a**a**a**a**a**b', 'a/'.repeat(2000)],
  ['**/**/**/**/**/**/**/**/**/**/**/x', 'a/'.repeat(2000) + 'y'],
  ['?*?*?*?*?*?*?*?*?*?*?*?*?*?*?*?*!', 'x'.repeat(4000)],
];
for (const [glob, p] of bombs) {
  test(`no catastrophic backtracking: ${glob.slice(0, 24)}…`, () => {
    const t0 = Date.now();
    assert.strictEqual(matches(glob, p), false);
    assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0}ms`);
  });
}
test('brace expansion bomb is refused, not expanded', () => {
  assert.throws(() => expandBraces('{a,b}'.repeat(20)), /more than 64 alternatives/);
});
test('overlong glob is refused', () => {
  assert.throws(() => matches('a'.repeat(600), 'a'), /at most 512/);
});

// --- policy validation ----------------------------------------------------------------------
test('policy: keys default, unknown keys ignored, __proto__ inert', () => {
  const p = validatePolicy(JSON.parse('{"ask_paths":["x/**"],"__proto__":{"polluted":1},"extra":1}'));
  assert.deepStrictEqual(p, { ...DEFAULTS, ask_paths: ['x/**'] });
  assert.strictEqual({}.polluted, undefined);
});
for (const [label, bad] of [
  ['array', []], ['null', null], ['ask_paths string', { ask_paths: 'x' }], ['empty glob', { ask_paths: [''] }],
  ['non-integer max', { max_changed_lines: 1.5 }], ['negative max', { max_changed_files: -1 }],
  ['bad merge_method', { merge_method: 'force' }], ['brace bomb', { ask_paths: ['{a,b}'.repeat(20)] }],
]) {
  test(`policy rejects ${label}`, () => assert.throws(() => validatePolicy(bad)));
}
test('template policy is valid and asks for the obvious sensitive paths', () => {
  const tpl = validatePolicy(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'template', 'pr-review-loop.json'), 'utf8')));
  const asks = (p) => tpl.ask_paths.some((g) => matches(g, p));
  for (const p of ['.github/workflows/ci.yml', 'db/migrations/001.sql', 'src/auth/session.ts', 'api/billing/stripe.ts',
    '.env', 'config/.env.local', 'package.json', 'apps/web/pnpm-lock.yaml', 'go.sum', 'infra/main.tf', 'Dockerfile',
    '.claude/settings.json', '.github/CODEOWNERS', 'certs/server.pem']) {
    assert.ok(asks(p), `expected ask for ${p}`);
  }
  for (const p of ['src/components/Button.tsx', 'README.md', 'docs/guide.md', 'src/lib/format.ts']) {
    assert.ok(!asks(p), `expected no ask for ${p}`);
  }
});

// --- evaluate -------------------------------------------------------------------------------
const HEAD = 'a'.repeat(40);
const baseInfo = {
  additions: 10, deletions: 2, changedFiles: 1, state: 'OPEN', isDraft: false, isCrossRepository: false,
  mergeStateStatus: 'CLEAN', headRefOid: HEAD,
  statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
};
const policy = { ...DEFAULTS, ask_paths: ['db/**'] };
const run = (over = {}) => evaluate({
  pr: '7', repoFlag: null, info: { ...baseInfo, ...(over.info || {}) }, files: over.files || [{ path: 'src/a.ts' }],
  policy: 'policy' in over ? over.policy : policy, policySource: 'test', expectHead: 'expectHead' in over ? over.expectHead : HEAD,
});

test('evaluate: clean PR is eligible with a pinned merge command', () => {
  const out = run();
  assert.strictEqual(out.decision, 'eligible', out.reasons.join('; '));
  assert.deepStrictEqual(out.mergeCommand, ['gh', 'pr', 'merge', '7', '--squash', '--match-head-commit', HEAD]);
});
test('evaluate: merge_method is honoured', () => {
  assert.strictEqual(run({ policy: { ...policy, merge_method: 'rebase' } }).mergeCommand[4], '--rebase');
});
const askCases = [
  ['no policy file', { policy: null }, /explicit policy/],
  ['ask_paths match', { files: [{ path: 'db/x.sql' }] }, /match ask_paths/],
  ['rename out of an ask path', { files: [{ path: 'tmp/x.sql', previous: 'db/x.sql' }] }, /match ask_paths/],
  ['policy file edited', { files: [{ path: '.claude/pr-review-loop.json' }] }, /match ask_paths/],
  ['fork PR', { info: { isCrossRepository: true } }, /fork/],
  ['draft', { info: { isDraft: true } }, /draft/],
  ['closed', { info: { state: 'CLOSED' } }, /not OPEN/],
  ['blocked', { info: { mergeStateStatus: 'BLOCKED' } }, /not CLEAN/],
  ['unknown merge state', { info: { mergeStateStatus: 'UNKNOWN' } }, /not CLEAN/],
  ['failing check', { info: { statusCheckRollup: [{ __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE' }] } }, /failing checks: ci/],
  ['pending check', { info: { statusCheckRollup: [{ __typename: 'CheckRun', name: 'ci', status: 'IN_PROGRESS', conclusion: '' }] } }, /pending checks: ci/],
  ['failing status', { info: { statusCheckRollup: [{ __typename: 'StatusContext', context: 'lint', state: 'ERROR' }] } }, /failing checks: lint/],
  ['too many lines', { info: { additions: 2000 } }, /max_changed_lines/],
  ['too many files', { info: { changedFiles: 30 } }, /max_changed_files/],
  ['head moved after review', { expectHead: 'b'.repeat(40) }, /not the reviewed SHA/],
  ['no reviewed SHA', { expectHead: null }, /--expect-head/],
];
for (const [label, over, re] of askCases) {
  test(`evaluate asks: ${label}`, () => {
    const out = run(over);
    assert.strictEqual(out.decision, 'ask');
    assert.ok(out.reasons.some((r) => re.test(r)), out.reasons.join('; '));
    assert.strictEqual(out.mergeCommand, undefined);
  });
}

if (failed) { console.error(`merge-policy tests: ${failed} failed, ${passed} passed`); process.exit(1); }
console.log(`merge-policy tests: ${passed} passed`);
