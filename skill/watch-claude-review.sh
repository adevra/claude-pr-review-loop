#!/usr/bin/env bash
#
# watch-claude-review.sh — block until the @claude CI review for a PR completes, then exit.
#
# Used by the /pr-review-loop skill as a BACKGROUND Bash command (run_in_background: true). When this
# process exits, the Claude Code harness re-invokes the session with the output below — giving
# event-driven "the review is ready" behaviour with no polling on the agent's side and no extra
# infrastructure (no webhook, no tunnel, no daemon). The CI workflow (.github/workflows/claude.yml)
# is untouched.
#
# Usage: watch-claude-review.sh <pr-number> <since-iso8601-utc>
#   <since> = the GitHub createdAt of our "@claude please review" comment (the API returns it on the
#   server clock, so there is NO local/remote clock-skew to handle).
#
# Correlation is by TIMESTAMP, not headSha: every claude.yml run fires on `issue_comment` and (on
# this repo) executes against the default branch, so ALL runs share main's headSha regardless of
# which PR the comment was on. Our run is therefore the OLDEST claude.yml issue_comment run created
# at/after <since> — i.e. the first run triggered once our comment landed — EXCLUDING runs that
# concluded "skipped". The claude-code-action posts its own status/eyes comment, which fires a
# sibling claude.yml run that the job's `if:` condition skips; that skipped sibling is often created
# at (or within a second of) our @claude comment, so a naive "oldest at/after <since>" match latches
# onto it instead of the real review. We therefore prefer the oldest NON-skipped run, and fall back
# to a skipped run only when no real run appears (so a genuine non-trigger still reports "skipped").

set -uo pipefail

PR="${1:-}"
SINCE="${2:-}"
WORKFLOW="claude.yml"
DISCOVERY_TRIES=30   # ~90s — the run can take several seconds to register after the comment
DISCOVERY_SLEEP=3

if [ -z "$PR" ] || [ -z "$SINCE" ]; then
  echo "WATCH_RESULT: error  usage: watch-claude-review.sh <pr> <since-iso8601>"
  exit 2
fi

# --- Discovery: our run = oldest claude.yml issue_comment run created at/after SINCE whose
# conclusion is NOT "skipped" (queued/in-progress runs have an empty conclusion, so they qualify).
# This skips the action's own skipped status-comment sibling; see the header note.
RUN_ID=""
for _ in $(seq 1 "$DISCOVERY_TRIES"); do
  RUN_ID=$(gh run list --workflow="$WORKFLOW" --event=issue_comment --limit 50 \
    --json databaseId,createdAt,conclusion \
    --jq "[.[] | select(.createdAt >= \"$SINCE\") | select(.conclusion != \"skipped\")] | sort_by(.createdAt) | .[0].databaseId // empty" \
    2>/dev/null || true)
  [ -n "$RUN_ID" ] && break
  sleep "$DISCOVERY_SLEEP"
done

# Fallback: no non-skipped run appeared in the window. If a skipped sibling exists at/after SINCE,
# surface it (the @claude comment most likely did not actually trigger a review); else report no_run.
if [ -z "$RUN_ID" ]; then
  RUN_ID=$(gh run list --workflow="$WORKFLOW" --event=issue_comment --limit 50 \
    --json databaseId,createdAt,conclusion \
    --jq "[.[] | select(.createdAt >= \"$SINCE\") | select(.conclusion == \"skipped\")] | sort_by(.createdAt) | .[0].databaseId // empty" \
    2>/dev/null || true)
fi

if [ -z "$RUN_ID" ]; then
  echo "WATCH_RESULT: no_run  pr=$PR  since=$SINCE"
  echo "No claude.yml run registered at/after the comment within the discovery window — the '@claude'"
  echo "comment likely did not trigger the workflow (verify the comment posted and the workflow is enabled)."
  exit 0
fi

# --- Wait for completion: gh run watch is a server-side long-poll; the agent is idle until it returns.
# --exit-status makes gh exit non-zero on a failed run; swallow it so we can report the conclusion.
gh run watch "$RUN_ID" --exit-status >/dev/null 2>&1 || true

CONCLUSION=$(gh run view "$RUN_ID" --json conclusion --jq '.conclusion' 2>/dev/null || echo "unknown")
URL=$(gh run view "$RUN_ID" --json url --jq '.url' 2>/dev/null || echo "")

echo "WATCH_RESULT: done  pr=$PR  run=$RUN_ID  conclusion=$CONCLUSION  url=$URL"
case "$CONCLUSION" in
  success)
    echo "The review run completed. Fetch the NEWEST @claude output on PR #$PR (check both the PR"
    echo "issue-comments and review-comments streams, use whichever is newest) and handle findings."
    ;;
  skipped)
    echo "The matched run was SKIPPED (the comment may not have contained '@claude', or the job's"
    echo "condition filtered it). No review was produced; do not parse findings."
    ;;
  *)
    echo "The review run did NOT succeed (conclusion=$CONCLUSION). Inspect the run rather than parsing"
    echo "findings: $URL"
    ;;
esac
exit 0
