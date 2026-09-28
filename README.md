# claude-pr-review-loop

> The `/pr-review-loop` skill for [Claude Code](https://code.claude.com) — request your repo's
> `@claude` CI review and drive the fix loop **event-driven, in the same session**. No polling, no
> webhook, no daemon.

When you finish a change on a feature branch, you normally: push → comment `@claude` on the PR →
wait → read the review → fix → maybe re-review. This skill does the whole loop for you, and the
waiting is **event-driven** — a background watcher blocks on `gh run watch` and the harness wakes
your session the moment CI finishes. You burn zero turns waiting.

## Install

Install the skill once into your Claude Code **user scope** so it works in every repo:

```sh
npx github:adevra/claude-pr-review-loop
```

That drops the skill into `~/.claude/skills/pr-review-loop/`. Restart any open Claude Code session
to pick it up, then run `/pr-review-loop` on a feature branch.

## Per-repo setup

The skill drives the **standard** `@claude` GitHub Action review. Any repo you want to review needs
`.github/workflows/claude.yml`. Scaffold it from the repo root:

```sh
npx github:adevra/claude-pr-review-loop init
```

Then add the one secret the workflow needs:

```sh
claude setup-token                       # generate a Claude Code OAuth token
gh secret set CLAUDE_CODE_OAUTH_TOKEN     # paste it when prompted
```

`init` also drops a sample `.claude/pr-review-loop.json` (only read by [auto mode](#auto-mode-opt-in));
edit its `ask_paths` for the repo. Existing files are never overwritten. Commit both and you're set.

## Usage

On a feature branch with your work committed:

```
/pr-review-loop
```

It will:

1. **Refuse early** if the tree is dirty or you're on `main`/`master`.
2. **Push** the branch and open (or reuse) a PR.
3. **Comment `@claude`** to trigger the CI review, then launch the background watcher and end the
   turn — your session goes idle.
4. **Wake automatically** when CI finishes, read the newest review output, and summarize the
   findings.
5. **Gate on a fix** (`AskUserQuestion`): *Fix now* or *Leave it*. Fixes follow
   `receiving-code-review` discipline — valid findings get fixed, declined ones get a one-line
   reason.
6. **Optionally re-review** once (round cap of 2, so CI never runs away).
7. **Gate the merge** (`AskUserQuestion`): *Approve the merge*, *I'll merge it myself*, or *Run
   another review round*. Nothing merges unless you pick the first.

## Auto mode (opt-in)

```
/pr-review-loop auto          # this branch's PR
/pr-review-loop auto 540      # a specific PR
```

Or tell the session "auto mode on". Without that, the skill behaves exactly as above.

In auto mode the skill does not ask before fixing: it fixes the valid findings, lists the declined
ones with a reason, pushes and re-reviews within the same round cap. At the merge step, a
per-repo policy decides:

- It **asks you** if any changed file matches `ask_paths`, the diff is bigger than
  `max_changed_lines` (additions + deletions) or `max_changed_files`, any finding was declined or
  left open, or the latest review isn't clean.
- **Otherwise it merges** (`gh pr merge --squash`) and tells you why no ask was needed. Branch
  protection, required checks and your own merge hooks still apply; if one refuses, it stops and
  reports rather than working around it.

The policy lives in the repo at `.claude/pr-review-loop.json` (`init` scaffolds a sample):

```json
{
  "ask_paths": [".github/**", "**/migrations/**", "**/*.sql", "package.json"],
  "max_changed_lines": 1500,
  "max_changed_files": 25
}
```

Missing file or keys fall back to `[]`, `1500`, `25`. Globs: `*` within a path segment, `**`
across segments, `?`, `{a,b}`; patterns anchor at the repo root. The file is read from the PR's
**base** branch, and a PR that edits it always asks, so a PR cannot loosen its own gate. The
mechanical check is `skill/merge-policy.js` (`node merge-policy.js <pr>` prints the decision as
JSON; any error fails closed to "ask").

## How it works

| File | Role |
|------|------|
| `skill/SKILL.md` | The orchestrator Claude follows when you run `/pr-review-loop`. |
| `skill/watch-claude-review.sh` | Background watcher. Correlates *your* review run by the `@claude` comment's `createdAt` (timestamp, **not** head SHA — every `claude.yml` run shares `main`'s SHA), blocks on `gh run watch`, then prints `WATCH_RESULT:` and exits, which re-invokes the session. |
| `skill/merge-policy.js` | Auto mode's merge-policy check: reads `.claude/pr-review-loop.json` from the base branch, measures the PR with `gh`, prints `ask`/`eligible` + reasons. |
| `template/claude.yml` | The standard `anthropics/claude-code-action` workflow `init` scaffolds. |
| `template/pr-review-loop.json` | Sample auto-mode policy `init` scaffolds into `.claude/`. |

The CI workflow itself is **never modified** by the skill.

## Commands

```
npx github:adevra/claude-pr-review-loop            # install the skill (default)
npx github:adevra/claude-pr-review-loop init       # scaffold claude.yml + .claude/pr-review-loop.json
npx github:adevra/claude-pr-review-loop uninstall   # remove the global skill
npx github:adevra/claude-pr-review-loop help
```

## Requirements

- [Claude Code](https://code.claude.com)
- [`gh`](https://cli.github.com/) (GitHub CLI), authenticated
- A POSIX shell for the watcher (Git Bash on Windows — Claude Code's Bash tool already uses it)
- Node ≥ 16 (only to run the installer)

## License

MIT
