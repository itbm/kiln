#!/usr/bin/env bash
# First exec after sandbox creation (§5.3): clone + branch before the model
# ever sees the workspace. The GitHub token never touches disk or the remote
# URL — `gh auth setup-git` installs a credential helper that reads GH_TOKEN
# from the environment, so .git/config stays clean.
set -euo pipefail

export GIT_TERMINAL_PROMPT=0 # fail fast on bad credentials

gh auth setup-git

# Blobless clone: full history metadata with lazy blob fetch — fast start on
# large repos while keeping `git log`/`blame` functional (extra blob fetches
# ride the same allowlisted egress).
git clone --filter=blob:none --single-branch \
  --branch "$KILN_BASE_BRANCH" \
  "https://github.com/$KILN_REPO.git" /work/repo
cd /work/repo

# Resume finds the existing task branch; fresh tasks (and retries) create it.
git fetch origin "+refs/heads/$KILN_TASK_BRANCH:refs/remotes/origin/$KILN_TASK_BRANCH" 2>/dev/null &&
  git switch "$KILN_TASK_BRANCH" ||
  git switch -c "$KILN_TASK_BRANCH"

git config user.name "Kiln Agent"
git config user.email "kiln-agent@users.noreply.github.com"

echo "bootstrap ok: $KILN_REPO @ $(git rev-parse --short HEAD) on $KILN_TASK_BRANCH"
