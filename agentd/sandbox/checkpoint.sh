#!/usr/bin/env bash
# Checkpoint-on-teardown (§5.8, default on): before a non-completed teardown
# the runner can still act on (cancel, TTL expiry, shim crash), push whatever
# exists to the task branch so Continue can pick it up in a fresh sandbox.
# Prints KILN_CHECKPOINT_PUSHED only when the remote actually moved.
set -uo pipefail

cd /work/repo 2>/dev/null || exit 0

git add -A
git diff --cached --quiet || git commit -q -m "wip: kiln checkpoint" || true

# nothing beyond base → nothing worth preserving
COMMITS=$(git rev-list --count "origin/$KILN_BASE_BRANCH..HEAD" 2>/dev/null || echo 0)
[ "$COMMITS" = "0" ] && exit 0

# remote already has HEAD → no-op
REMOTE=$(git rev-parse -q --verify "refs/remotes/origin/$KILN_TASK_BRANCH" 2>/dev/null || echo none)
[ "$REMOTE" = "$(git rev-parse HEAD)" ] && exit 0

git push -u origin "$KILN_TASK_BRANCH" >/dev/null 2>&1 && echo "KILN_CHECKPOINT_PUSHED"
exit 0
