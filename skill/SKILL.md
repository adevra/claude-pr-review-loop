---
name: pr-review-loop
description: Use after finishing a change on a feature branch when you want the repo's @claude CI review and to handle its findings in THIS session. Pushes the branch, opens/uses the PR, requests the review, waits event-driven for CI to finish (a background watcher re-invokes the session — no polling), then drives a gated fix loop (round cap 2). Invoke as /pr-review-loop.
---

# /pr-review-loop — request and handle a Claude PR review, in-session

Automates the loop you'd otherwise do by hand: push → comment `@claude` → wait for CI → read the
findings → fix → optionally re-review. The waiting is **event-driven**: a background script
(`watch-claude-review.sh`, bundled next to this skill) blocks on `gh run watch` and, when it exits,
the harness re-invokes this session with the result. You burn no turns polling.

Depends on the repo having a `.github/workflows/claude.yml` that fires on a comment containing
`@claude` (the standard `anthropics/claude-code-action` workflow). That workflow is never modified by
this skill. A repo that doesn't have it yet can scaffold one with
`npx github:adevra/claude-pr-review-loop init`.

## Step 1 — Preconditions (refuse early if unmet)

- `git status --porcelain` must be **empty**. If the tree is dirty, stop: "Commit or stash your
  changes first — /pr-review-loop reviews what's pushed."
- `git branch --show-current` must **not** be `main` (or `master`). If on the default branch, stop:
  "Switch to a feature branch first."

## Step 2 — Push and ensure a PR exists

```bash
BRANCH=$(git branch --show-current)
git push -u origin "$BRANCH"
PR=$(gh pr view "$BRANCH" --json number --jq '.number' 2>/dev/null)
# If no PR yet, create one (fill title/body from the branch's commits):
#   gh pr create --base main --head "$BRANCH" --title "<title>" --body "<summary>"
# then re-read PR. Reuse an existing PR — never open a duplicate.
```

## Step 3 — Request the review and launch the watcher

Post the trigger as a **comment** (the description does NOT trigger CI), capture the comment's
GitHub `createdAt` as the discovery timestamp (server clock — no skew), then launch the watcher in
the **background**:

```bash
gh pr comment "$PR" --body "@claude please review this PR."
SINCE=$(gh pr view "$PR" --json comments --jq '.comments[-1].createdAt')
```

Then run the watcher with **`run_in_background: true`** (this is the whole point — the session goes
idle and is re-invoked when CI finishes):

```bash
bash "$HOME/.claude/skills/pr-review-loop/watch-claude-review.sh" "$PR" "$SINCE"
```

Tell the user: "Requested the review on PR #<n> and I'm waiting for CI — I'll pick this back up
automatically when it finishes." Then **end the turn** (do not poll).

## Step 4 — On wake: read the result

When the background command completes you'll see a `WATCH_RESULT:` line:

- `WATCH_RESULT: no_run …` → the `@claude` comment didn't trigger the workflow. Report that and stop
  (suggest checking the comment / that `.github/workflows/claude.yml` exists and is enabled).
- `WATCH_RESULT: done … conclusion=success` → fetch the **newest** bot output and continue to Step 5.
  Check **both** streams and use whichever is newest (robust to sticky-comment vs formal review):
  ```bash
  gh pr view "$PR" --json comments --jq '[.comments[] | select(.author.login | startswith("claude"))] | last | .body'
  gh api "repos/{owner}/{repo}/pulls/$PR/reviews" --jq '[.[] | select(.user.login | startswith("claude"))] | last | .body'
  ```
- `WATCH_RESULT: done … conclusion=skipped` or any non-success → surface the run URL; do not parse
  findings. Stop.

If the review has **no actionable findings** (approve/clean), report "the review came back clean"
and **stop — do not prompt**.

## Step 5 — Gate: fix or leave (Question A)

Summarize the findings, then ask with **AskUserQuestion**:

- **Fix now** → go to Step 6.
- **Leave it for now** → stop. The PR is left exactly as the reviewer saw it.

## Step 6 — Fix, then gate again (Question B)

Apply **`superpowers:receiving-code-review` discipline** — do not implement verbatim:

- Fix the findings you judge valid for this codebase.
- For each finding you do **not** act on (false positive, technically wrong, or out-of-scope), name
  it and give a one-line reason in your summary, so the developer sees the full picture.

Commit the fixes. Then ask with **AskUserQuestion** (note: **both options push** — the only choice
is whether to re-trigger a review):

- **Push & request another review** → push, post `@claude please review this PR.`, capture a fresh
  `SINCE`, relaunch the watcher (Step 3's background command), end the turn → back to Step 4.
- **Push, skip re-review** → push the fixes and stop.

## Round cap

At most **2 review cycles** per invocation (round 1 = the initial review; round 2 = the one
re-review reachable via Question B). After the round-2 review is handled, if the user again chooses
to fix, **push the fixes but do NOT trigger a third review** — drop the "request another review"
option, report, and hand back. This prevents runaway CI.

## Edge cases

| Situation | Behaviour |
|-----------|-----------|
| Working tree dirty, or on `main`/`master` | Refuse in Step 1; explain why. |
| PR already exists for the branch | Reuse it; don't open a duplicate. |
| `WATCH_RESULT: no_run` | Comment likely didn't fire the workflow (or no `claude.yml`); report and stop. |
| Run conclusion ≠ success | Surface the run URL; don't parse findings. |
| Review came back clean | Report "clean", skip Question A. |

## Notes

- The watcher runs through the **Bash tool** (Git Bash / POSIX) — POSIX shell + `gh`. Requires `gh`
  authenticated.
- The watcher lives next to this file: `$HOME/.claude/skills/pr-review-loop/watch-claude-review.sh`.
  It is launched as a background Bash command so the session sits idle until CI finishes.
- Run discovery is by **timestamp**, not headSha: every `claude.yml` run fires on `issue_comment`
  against the default branch, so all runs share `main`'s headSha regardless of PR. Our run is the
  oldest `claude.yml` `issue_comment` run created at/after `SINCE`.
