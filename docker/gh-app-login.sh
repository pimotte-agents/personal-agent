#!/usr/bin/env bash
# Forces a fresh GitHub App installation token and checks it works. Normally unnecessary: git (via
# git-credential-ghapp) and gh (via the gh wrapper) fetch a valid token on every call. Kept on PATH
# as `gh-app-login` for when something still reports a 401.
set -euo pipefail

if ! sudo -n /usr/local/bin/gh-app-token --refresh >/dev/null; then
  echo "gh-app-login: couldn't mint a token (is docker/secrets/github-app.pem in place?)" >&2
  exit 1
fi
gh api /installation/repositories --jq '"gh-app-login: token OK, \(.total_count) repositories accessible."'
