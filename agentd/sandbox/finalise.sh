#!/usr/bin/env bash
# Fallback finalisation (§5.4/§7): push + PR + diff card. The agent is
# instructed to do this itself; this script is idempotent so running it
# after a well-behaved agent is a no-op that just reports the PR. Emits a
# single machine-readable KILN_FINALISE_JSON: line for agentd to parse.
set -uo pipefail # deliberately NOT -e: always emit the JSON marker

cd /work/repo 2>/dev/null || {
  echo 'KILN_FINALISE_JSON:{"error":"workspace missing"}'
  exit 1
}

# Belt and braces: commit anything the loop left uncommitted.
git add -A
git diff --cached --quiet || git commit -q -m "wip: kiln finalise checkpoint" || true

BASE_REF="origin/$KILN_BASE_BRANCH"
COMMITS=$(git rev-list --count "$BASE_REF..HEAD" 2>/dev/null || echo 0)
if [ "$COMMITS" = "0" ]; then
  echo 'KILN_FINALISE_JSON:{"no_commits":true}'
  exit 0
fi

if ! git push -u origin "$KILN_TASK_BRANCH" >/dev/null 2>&1; then
  echo 'KILN_FINALISE_JSON:{"error":"push failed"}'
  exit 1
fi

# Reuse the agent's PR when it opened one; create otherwise.
PR_URL=$(gh pr view "$KILN_TASK_BRANCH" --json url --jq .url 2>/dev/null || true)
if [ -z "$PR_URL" ]; then
  PR_URL=$(gh pr create --fill --base "$KILN_BASE_BRANCH" --head "$KILN_TASK_BRANCH" 2>/dev/null | tail -n1 || true)
  case "$PR_URL" in https://*) ;; *) PR_URL="" ;; esac
fi

PATCH_FILE=$(mktemp)
git diff "$BASE_REF...HEAD" >"$PATCH_FILE" 2>/dev/null || true
PATCH_BYTES=$(wc -c <"$PATCH_FILE")
TRUNCATED=false
[ "$PATCH_BYTES" -gt 262144 ] && TRUNCATED=true # 256 KiB cap (§7)

DIFFSTAT=$(git diff --stat "$BASE_REF...HEAD" 2>/dev/null | tail -n 60)

jq -cn \
  --arg pr "$PR_URL" \
  --arg stat "$DIFFSTAT" \
  --arg patch "$(head -c 262144 "$PATCH_FILE" | base64 -w0)" \
  --argjson trunc "$TRUNCATED" \
  '{pr_url:$pr, diffstat:$stat, patch_b64:$patch, truncated:$trunc}' |
  sed 's/^/KILN_FINALISE_JSON:/'
rm -f "$PATCH_FILE"
