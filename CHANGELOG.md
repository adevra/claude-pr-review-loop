# Changelog

## 1.2.0 (2026-09-29)

Security release. Upgrade if you use the skill on a public repository or use auto mode.

### Security

- **Reviewer identity.** Reviews were identified by `login startswith "claude"`, read partly from
  GraphQL, which reports the bot as plain `claude`. `claude` is a real human GitHub account, and
  anyone can register `claude-anything`, so a stranger's comment could be read as the review
  (a fake clean review, or injected instructions). The new `skill/fetch-review.js` accepts only
  `claude[bot]` with account type `Bot` (configurable with `PR_REVIEW_LOOP_BOT`) and only output
  tied to the exact run the skill triggered.
- **Review text is untrusted.** SKILL.md now has trust rules: review output is data to extract
  findings from, never instructions or approval; "no review" is never "clean". The fetcher frames
  bodies between nonce-tagged markers.
- **Run correlation.** The watcher now matches runs by triggering actor as well as time, so a
  concurrent `@claude` from someone else is never taken for yours. The trigger comment is posted
  through the REST API so `SINCE` is that comment's own timestamp (the old "last comment" read
  could pick up someone else's comment).
- **Glob matcher ReDoS.** `ask_paths` globs compiled to backtracking regexes; a pattern such as
  `*a*a*a*a*a*a*a*b` hung the check for minutes on a 200-character path, and `{a,b}` repeated
  expanded exponentially. Matching is now a linear-time DP, brace expansion is capped at 64
  alternatives and globs at 512 characters.
- **Auto merge.** The policy check now also asks when there is no policy file on the base branch
  (previously: permissive defaults), when the PR comes from a fork, when `mergeStateStatus` is not
  `CLEAN`, when any status check is failing or pending, and when the head is not the reviewed SHA.
  Renames are checked on both sides, so moving a file out of an `ask_paths` directory asks. The
  merge is pinned with `--match-head-commit`.
- **Workflow template.** `template/claude.yml` gates on `author_association`
  (`OWNER`/`MEMBER`/`COLLABORATOR`), pins actions to commit SHAs, adds `timeout-minutes`, and
  documents `include_comments_by_actor`.
- **Installer.** Refuses to write through a symlinked skill directory, replaces (never follows)
  symlinked files, prints every path it writes; `uninstall` removes a link without touching its
  target.
- **Input validation.** The watcher validates the PR number, `SINCE` and environment overrides
  before any of them reach a `gh`/jq expression; the scripts validate repo slugs and SHAs.

### Added

- `merge_method` policy key (`squash` default, `merge`, `rebase`).
- `PR_REVIEW_LOOP_WORKFLOW`, `PR_REVIEW_LOOP_TIMEOUT`, `PR_REVIEW_LOOP_BOT` environment overrides.
- Watcher timeout (`WATCH_RESULT: timeout`, default 60 minutes) instead of waiting forever on a
  queued run.
- Tests for the identity check, run correlation, glob edge cases and catastrophic patterns, and
  every auto-merge rule.

### Changed

- The skill uses the repo's default branch instead of assuming `main`.
- The sample policy covers common sensitive paths across ecosystems (CI, agent config, migrations,
  auth, billing, secrets/env files, manifests and lockfiles, infrastructure).
- Node >= 16 is now needed at review time too (`fetch-review.js`), not only to install.

## 1.1.0

- Opt-in auto mode: policy-gated merge (`.claude/pr-review-loop.json`).

## 1.0.x

- Step 7 merge gate; watcher run-discovery fixes.
