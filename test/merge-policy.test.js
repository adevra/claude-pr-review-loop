'use strict';

const assert = require('assert');
const { matches } = require('../skill/merge-policy.js');

const cases = [
  ['trimsy-app/supabase/**', 'trimsy-app/supabase/migrations/2026_x.sql', true],
  ['trimsy-app/supabase/**', 'trimsy-app/supabase-ish/a.ts', false],
  ['**/*.sql', 'a.sql', true],
  ['**/*.sql', 'deep/er/a.sql', true],
  ['**/*.sql', 'a.sqlx', false],
  ['*.sql', 'deep/a.sql', false],
  ['trimsy-app/app/**/payout*', 'trimsy-app/app/payouts.tsx', true],
  ['trimsy-app/app/**/payout*', 'trimsy-app/app/(tabs)/settings/payout-setup.tsx', true],
  ['trimsy-app/src/services/auth*', 'trimsy-app/src/services/auth.ts', true],
  ['trimsy-app/src/services/auth*', 'trimsy-app/src/services/authz/x.ts', false],
  ['.github/**', '.github/workflows/claude.yml', true],
  ['.claude/hooks/**', '.claude/hooks/guard-bash.py', true],
  ['src/content/{privacy,terms}/**', 'src/content/terms/tr.md', true],
  ['src/content/{privacy,terms}/**', 'src/content/blog/tr.md', false],
  ['package*.json', 'package-lock.json', true],
  ['package*.json', 'app/package.json', false],
  ['wrangler.*', 'wrangler.jsonc', true],
  ['a?c', 'abc', true],
  ['a?c', 'a/c', false],
  ['a.b', 'axb', false],
];

let failed = 0;
for (const [glob, path, want] of cases) {
  const got = matches(glob, path);
  try {
    assert.strictEqual(got, want);
  } catch (_) {
    failed++;
    console.error(`FAIL matches(${JSON.stringify(glob)}, ${JSON.stringify(path)}) = ${got}, want ${want}`);
  }
}
if (failed) process.exit(1);
console.log(`merge-policy glob tests: ${cases.length} passed`);
