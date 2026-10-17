#!/usr/bin/env bash
# git credential helper (configured for https://github.com in ../Dockerfile): answers `get` with a
# fresh GitHub App installation token from gh-app-token, so `git push`/`fetch` never hit an
# expired token. `store`/`erase` are no-ops — gh-app-token does its own caching.
set -euo pipefail

[ "${1:-}" = get ] || exit 0

protocol="" host=""
while IFS='=' read -r key value; do
  [ -z "$key" ] && break
  case "$key" in
    protocol) protocol=$value ;;
    host) host=$value ;;
  esac
done
[ "$protocol" = https ] && [ "$host" = github.com ] || exit 0

# On failure print nothing: git then reports the auth error itself.
token=$(sudo -n /usr/local/bin/gh-app-token 2>/dev/null) || exit 0
printf 'username=x-access-token\npassword=%s\n' "$token"
