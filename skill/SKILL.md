---
name: pr-review-loop
description: Use after finishing a change on a feature branch when you want the repo's @claude CI review and to handle its findings in THIS session. Pushes the branch, opens/uses the PR, requests the review, waits event-driven for CI to finish (a background watcher re-invokes the session — no polling), then drives a gated fix loop (round cap 2). Invoke as /pr-review-loop, or /pr-review-loop auto [pr] for auto mode (fixes without asking, merges low-risk PRs per the repo's .claude/pr-review-loop.json policy, asks for the rest).
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

**Two modes.** Default mode is Steps 1–7 exactly as written: every fix and every merge is gated
on the user. **Auto mode** is opt-in and changes only Steps 5 and 7 — see [Auto mode](#auto-mode)
below. It is on only when the invocation carries the argument `auto` (e.g. `/pr-review-loop auto`
or `/pr-review-loop auto 540`), or the user/caller has stated in this session that auto mode is
on. Otherwise you are in default mode, even if a previous invocation used auto.

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

If the review has **no actionable findings** (approve/clean), report "the review came back clean",
skip Question A, and go straight to **Step 7** so the user can still choose to merge, merge it
themselves, or run another round.

## Step 5 — Gate: fix or leave (Question A)

(Auto mode: skip this step — see [Auto mode](#auto-mode).)

Summarize the findings, then ask with **AskUserQuestion**:

- **Fix now** → go to Step 6.
- **Leave it for now** → stop. The PR is left exactly as the reviewer saw it.

## Step 6 — Fix, then gate again (Question B)

Apply **`superpowers:receiving-code-review` discipline** — do not implement verbatim:

- Fix the findings you judge valid for this codebase.
- For each finding you do **not** act on (false positive, technically wrong, or out-of-scope), name
  it and give a one-line reason in your summary, so the developer sees the full picture.

Commit the fixes and **push** them. Then go to Step 7.

## Step 7 — Gate: what happens to the PR (Question B)

(Auto mode: replaced by the policy decision — see [Auto mode](#auto-mode).)

The fixes are already pushed, so this asks what to do with the PR. Ask with **AskUserQuestion**,
offering exactly these three:

- **Approve the merge** → merge it: `gh pr merge <n> --squash`. This option, and only this option, is
  the explicit approval that a merge into the default branch requires; the user picking it here *is*
  that approval, so do not ask a second time. If the merge is refused (branch protection, a
  permission rule, or a harness classifier), say so plainly, give the exact command, and stop rather
  than working around it.
- **I'll merge it myself** → stop. Report the PR number and URL and leave it open. Do not merge.
- **Run another review round** → post `@claude please review this PR.`, capture a fresh `SINCE`,
  relaunch the watcher (Step 3's background command), end the turn → back to Step 4.

If the round cap below is already spent, drop the third option and offer only the first two.

Never merge on any other path through this skill. A clean review is not approval, and neither is
"Fix now" in Step 5. (In default mode this is absolute. Auto mode's policy merge is the single
other path, and it exists only when auto mode is on.)

## Round cap

At most **2 review cycles** per invocation (round 1 = the initial review; round 2 = the one
re-review reachable via Question B). After the round-2 review is handled, if the user again chooses
to fix, **push the fixes but do NOT trigger a third review** — drop "Run another review round" from
Question B, leaving "Approve the merge" and "I'll merge it myself", report, and hand back. This
prevents runaway CI.

## Auto mode

Opt-in (activation: see "Two modes" at the top). Steps 1–4 and 6, the watcher, and the round cap
(2) are unchanged. A trailing number (`/pr-review-loop auto 540`) names the PR to use instead of
looking it up from the branch. Auto mode changes two things:

### Step 5 in auto mode — no Question A

Do not ask. Go straight to Step 6: fix the findings you judge valid, list every declined finding
with a one-line reason, commit, push. If that push moved the tip and the round cap allows, start
the next review round yourself (Step 3: new `@claude` comment, fresh `SINCE`, relaunch the watcher,
end the turn). If the round cap is spent, the pushed fixes are unreviewed — go to Step 7 (auto),
where that forces an ask.

### Step 7 in auto mode — the policy decides: ask or merge

1. Run the bundled policy check (it reads `.claude/pr-review-loop.json` from the PR's **base**
   branch, so a PR cannot loosen its own gate, and measures the PR with `gh pr view --json
   additions,deletions,changedFiles` + `gh pr diff --name-only`):

   ```bash
   node "$HOME/.claude/skills/pr-review-loop/merge-policy.js" "$PR"
   ```

   Policy file schema (all keys optional; these are the defaults when the file or a key is missing):

   ```json
   { "ask_paths": [], "max_changed_lines": 1500, "max_changed_files": 25 }
   ```

   `ask_paths` globs match repo-relative paths: `*` stays inside one path segment, `**` spans
   segments, `?` is one character, `{a,b}` alternates. A pattern without `**/` matches from the repo
   root only (`**/*.sql` for "any `.sql` anywhere"). A change to the policy file itself always asks.

2. **ASK** the user (AskUserQuestion) if **any** of these holds:
   - the check printed `"decision": "ask"` — a changed file matches `ask_paths`, additions+deletions
     > `max_changed_lines`, changed files > `max_changed_files`, the PR is a draft or not open, or
     the check itself failed (it fails closed);
   - any review finding was declined or left open (in any round);
   - the latest review is not clean — including fixes pushed after the last review because the
     round cap was spent.

   The question carries a short summary: what changed (files/lines, the matching `ask_paths`),
   why it needs them (each triggered rule), and the review verdict (clean / findings fixed /
   declined ones with reasons). Offer exactly Step 7's default-mode options ("Approve the merge",
   "I'll merge it myself", and "Run another review round" only if the round cap allows); the answer
   is handled exactly as in default mode.

3. **OTHERWISE MERGE**: `gh pr merge "$PR" --squash`. The merge stays subject to the repo's own
   gates — branch protection, required checks, merge hooks, receipts. If anything refuses it, stop
   and report the refusal and the exact command; never work around it or retry it in another
   form. After merging, say what was merged
   (PR, squash SHA) and why no ask was needed (the policy source, the measured lines/files, "no
   ask_paths matched", clean review, nothing declined).

## Edge cases

| Situation | Behaviour |
|-----------|-----------|
| Working tree dirty, or on `main`/`master` | Refuse in Step 1; explain why. |
| PR already exists for the branch | Reuse it; don't open a duplicate. |
| Merge refused (protection/permission/classifier) | Say so, give the exact command, stop. Never work around it. |
| `WATCH_RESULT: no_run` | Comment likely didn't fire the workflow (or no `claude.yml`); report and stop. |
| Run conclusion ≠ success | Surface the run URL; don't parse findings. |
| Review came back clean | Report "clean", skip Question A, go to Step 7 (merge gate). |
| Auto mode, policy check fails or no policy file | Fails closed → ask. No file on base → defaults (`[]`, 1500, 25). |
| Auto mode, PR edits `.claude/pr-review-loop.json` | Always ask; the policy is read from the base branch anyway. |
| Auto mode, merge refused by a hook/protection | Stop, report the refusal + exact command. Never work around it. |

## Notes

- The watcher runs through the **Bash tool** (Git Bash / POSIX) — POSIX shell + `gh`. Requires `gh`
  authenticated.
- The watcher lives next to this file: `$HOME/.claude/skills/pr-review-loop/watch-claude-review.sh`.
  It is launched as a background Bash command so the session sits idle until CI finishes.
- Run discovery is by **timestamp**, not headSha: every `claude.yml` run fires on `issue_comment`
  against the default branch, so all runs share `main`'s headSha regardless of PR. Our run is the
  oldest `claude.yml` `issue_comment` run created at/after `SINCE`.
