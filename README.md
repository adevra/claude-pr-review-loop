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

Commit the workflow and you're set.

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

## How it works

| File | Role |
|------|------|
| `skill/SKILL.md` | The orchestrator Claude follows when you run `/pr-review-loop`. |
| `skill/watch-claude-review.sh` | Background watcher. Correlates *your* review run by the `@claude` comment's `createdAt` (timestamp, **not** head SHA — every `claude.yml` run shares `main`'s SHA), blocks on `gh run watch`, then prints `WATCH_RESULT:` and exits, which re-invokes the session. |
| `template/claude.yml` | The standard `anthropics/claude-code-action` workflow `init` scaffolds. |

The CI workflow itself is **never modified** by the skill.

## Commands

```
npx github:adevra/claude-pr-review-loop            # install the skill (default)
npx github:adevra/claude-pr-review-loop init       # scaffold claude.yml in the current repo
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
