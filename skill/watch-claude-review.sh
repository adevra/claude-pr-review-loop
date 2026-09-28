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
#   <since> = the GitHub created_at of our "@claude please review" comment (server clock, so there
#   is NO local/remote clock-skew to handle), e.g. 2026-09-29T10:00:00Z.
#
# Environment (optional):
#   PR_REVIEW_LOOP_WORKFLOW   workflow file name (default claude.yml)
#   PR_REVIEW_LOOP_TIMEOUT    minutes to wait for the run to finish (default 60)
#
# Correlation is by TIMESTAMP + TRIGGERING ACTOR (+ PR title), not headSha: every claude.yml run
# fires on `issue_comment` and executes against the default branch, so ALL runs share the default
# branch's headSha regardless of which PR the comment was on. Our run is the OLDEST claude.yml
# issue_comment run created at/after <since> that WE triggered (triggering_actor = the gh user) and
# that did not conclude "skipped", preferring runs whose title is this PR's title. Filtering on the
# triggering actor drops runs started by anyone else's comment — including the action's own status
# comment, which fires a sibling run the job's `if:` skips — so a stranger's concurrent "@claude"
# can never be mistaken for ours. The REST `actor=` query filter does NOT do this for issue_comment
# runs (it returns bot-triggered siblings too), so the filter is applied client-side.

set -uo pipefail

PR="${1:-}"
SINCE="${2:-}"
WORKFLOW="${PR_REVIEW_LOOP_WORKFLOW:-claude.yml}"
TIMEOUT_MIN="${PR_REVIEW_LOOP_TIMEOUT:-60}"
DISCOVERY_TRIES=60   # ~180s — the runs API has been observed NOT surfacing a run for well over
DISCOVERY_SLEEP=3    # 90s after it was created (see the re-confirm step below), so be patient.

if ! [[ "$PR" =~ ^[0-9]+$ ]] || ! [[ "$SINCE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$ ]]; then
  echo "WATCH_RESULT: error  usage: watch-claude-review.sh <pr-number> <since-iso8601-utc, e.g. 2026-09-29T10:00:00Z>"
  exit 2
fi
if ! [[ "$WORKFLOW" =~ ^[A-Za-z0-9._-]+\.ya?ml$ ]] || ! [[ "$TIMEOUT_MIN" =~ ^[0-9]+$ ]]; then
  echo "WATCH_RESULT: error  PR_REVIEW_LOOP_WORKFLOW must be a workflow file name and PR_REVIEW_LOOP_TIMEOUT a number of minutes"
  exit 2
fi

ME=$(gh api user --jq '.login' 2>/dev/null || true)
if ! [[ "$ME" =~ ^[A-Za-z0-9-]+$ ]]; then
  ME=""
  echo "NOTE: could not resolve the gh user; discovery falls back to timestamp only."
fi
PR_TITLE=$(gh pr view "$PR" --json title --jq '.title' 2>/dev/null || true)

ACTOR_FILTER='true'
[ -n "$ME" ] && ACTOR_FILTER=".triggering_actor.login == \"$ME\""

# Prints "id<TAB>display_title" per matching run, oldest first. $1 = "skipped" or "not-skipped".
list_runs() {
  local cmp='!='
  [ "$1" = "skipped" ] && cmp='=='
  gh api "repos/{owner}/{repo}/actions/workflows/$WORKFLOW/runs?event=issue_comment&per_page=100" \
    --jq "[.workflow_runs[] | select(.created_at >= \"$SINCE\") | select($ACTOR_FILTER) | select(.conclusion $cmp \"skipped\")] | sort_by(.created_at) | .[] | \"\(.id)\t\(.display_title)\"" \
    2>/dev/null || true
}

# First run whose title is this PR's title; otherwise the first run at all.
pick_run() {
  local first="" id title
  while IFS=$'\t' read -r id title; do
    [ -z "$id" ] && continue
    [ -z "$first" ] && first="$id"
    if [ -n "$PR_TITLE" ] && [ "$title" = "$PR_TITLE" ]; then echo "$id"; return; fi
  done
  echo "$first"
}

# --- Discovery
RUN_ID=""
for _ in $(seq 1 "$DISCOVERY_TRIES"); do
  RUN_ID=$(list_runs not-skipped | pick_run)
  [ -n "$RUN_ID" ] && break
  sleep "$DISCOVERY_SLEEP"
done

# Fallback: no non-skipped run appeared in the window. Before concluding that the comment did not
# trigger a review, RE-CONFIRM after a pause: a real run has been observed to stay invisible to the
# runs API for the whole discovery window and show up on a later query. A skipped-run verdict is
# therefore only trustworthy if it still holds after the API has had more time.
if [ -z "$RUN_ID" ]; then
  sleep 30
  RUN_ID=$(list_runs not-skipped | pick_run)
  if [ -n "$RUN_ID" ]; then
    echo "NOTE: the real run only became visible on the re-confirm poll (API lag) — using it."
  else
    RUN_ID=$(list_runs skipped | pick_run)
    if [ -n "$RUN_ID" ]; then
      echo "NOTE: only skipped run(s) found at/after $SINCE. If the workflow gates on author_association,"
      echo "check that the account that posted the trigger comment is allowed to run it."
    fi
  fi
fi

if [ -z "$RUN_ID" ]; then
  echo "WATCH_RESULT: no_run  pr=$PR  since=$SINCE"
  echo "No $WORKFLOW run registered at/after the comment within the discovery window — the '@claude'"
  echo "comment likely did not trigger the workflow (verify the comment posted and the workflow is enabled)."
  exit 0
fi

# --- Wait for completion, bounded. A run stuck in the queue (no runner) would otherwise block forever.
DEADLINE=$(( $(date +%s) + TIMEOUT_MIN * 60 ))
STATUS=""
while :; do
  STATUS=$(gh run view "$RUN_ID" --json status --jq '.status' 2>/dev/null || echo "")
  [ "$STATUS" = "completed" ] && break
  if [ "$(date +%s)" -ge "$DEADLINE" ]; then
    URL=$(gh run view "$RUN_ID" --json url --jq '.url' 2>/dev/null || echo "")
    echo "WATCH_RESULT: timeout  pr=$PR  run=$RUN_ID  status=${STATUS:-unknown}  url=$URL"
    echo "The run did not finish within ${TIMEOUT_MIN} minutes. Inspect it; do not parse findings."
    exit 0
  fi
  sleep 10
done

CONCLUSION=$(gh run view "$RUN_ID" --json conclusion --jq '.conclusion' 2>/dev/null || echo "unknown")
URL=$(gh run view "$RUN_ID" --json url --jq '.url' 2>/dev/null || echo "")

echo "WATCH_RESULT: done  pr=$PR  run=$RUN_ID  conclusion=$CONCLUSION  url=$URL"
case "$CONCLUSION" in
  success)
    echo "The review run completed. Fetch the review THIS run produced (it verifies the author and the"
    echo "run link) and handle its findings:"
    echo "  node \"\$HOME/.claude/skills/pr-review-loop/fetch-review.js\" $PR $RUN_ID"
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
