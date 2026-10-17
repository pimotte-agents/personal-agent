#!/usr/bin/env bash
# Prints a GitHub App installation access token, minting a new one when the cached token has less
# than 10 minutes left (installation tokens last an hour). Signs a JWT with the App's private key,
# looks up the (single) installation it's on, and exchanges the JWT for a token. Mirrors the flow
# in ../../orchestra/Orchestra/GitHub.lean (createJWT / createInstallationToken), minus the
# multi-installation/fork bookkeeping this project doesn't need.
#
# Runs as root only: the private key lives under /root (unreadable by `agent`), and `agent` may run
# exactly this script via sudo (see the sudoers rule in ../Dockerfile). That way the agent can get
# short-lived tokens but never the long-lived key. Callers: git-credential-ghapp, the `gh`
# wrapper, and gh-app-login. Takes no arguments except an optional `--refresh` to skip the cache.
set -euo pipefail

CONF=/etc/gh-app.conf   # written by entrypoint.sh, root-only
CACHE=/root/.cache/gh-app-token
MIN_REMAINING=600

refresh=0
case "${1:-}" in
  "") ;;
  --refresh) refresh=1 ;;
  *) echo "gh-app-token: usage: gh-app-token [--refresh]" >&2; exit 2 ;;
esac

if [ ! -r "$CONF" ]; then
  echo "gh-app-token: $CONF missing; GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY_PATH weren't set at container start" >&2
  exit 1
fi
# shellcheck source=/dev/null
. "$CONF"
: "${GITHUB_APP_ID:?set GITHUB_APP_ID}"
: "${GITHUB_APP_PRIVATE_KEY_PATH:?set GITHUB_APP_PRIVATE_KEY_PATH}"

now=$(date +%s)
if [ "$refresh" = 0 ] && [ -r "$CACHE" ]; then
  read -r cached_exp cached_token < "$CACHE" || true
  if [ -n "${cached_token:-}" ] && [ $((cached_exp - now)) -gt "$MIN_REMAINING" ]; then
    printf '%s\n' "$cached_token"
    exit 0
  fi
fi

if [ ! -r "$GITHUB_APP_PRIVATE_KEY_PATH" ]; then
  echo "gh-app-token: can't read the App private key ($GITHUB_APP_PRIVATE_KEY_PATH)" >&2
  exit 1
fi

b64url() { openssl base64 -e -A | tr '+/' '-_' | tr -d '='; }

iat=$((now - 30))   # allow for clock skew
exp=$((now + 540))  # GitHub rejects a JWT whose lifetime exceeds 10 minutes.
header='{"alg":"RS256","typ":"JWT"}'
payload="{\"iss\":${GITHUB_APP_ID},\"iat\":${iat},\"exp\":${exp}}"

b64header=$(printf '%s' "$header" | b64url)
b64payload=$(printf '%s' "$payload" | b64url)
signature=$(printf '%s.%s' "$b64header" "$b64payload" \
  | openssl dgst -sha256 -sign "$GITHUB_APP_PRIVATE_KEY_PATH" | b64url)
jwt="${b64header}.${b64payload}.${signature}"

installations=$(curl -sS -H "Authorization: Bearer $jwt" -H "Accept: application/vnd.github+json" \
  https://api.github.com/app/installations)
installation_id=$(echo "$installations" | jq -r '.[0].id // empty')
if [ -z "$installation_id" ]; then
  echo "gh-app-token: no installations found for this App:" >&2
  echo "$installations" >&2
  exit 1
fi

response=$(curl -sS -X POST -H "Authorization: Bearer $jwt" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/app/installations/${installation_id}/access_tokens")
token=$(echo "$response" | jq -r '.token // empty')
expires_at=$(echo "$response" | jq -r '.expires_at // empty')
if [ -z "$token" ]; then
  echo "gh-app-token: GitHub did not return a token for installation $installation_id" >&2
  exit 1
fi
token_exp=$(date -d "$expires_at" +%s 2>/dev/null || echo $((now + 3600)))

mkdir -p "$(dirname "$CACHE")"
umask 077
printf '%s %s\n' "$token_exp" "$token" > "$CACHE.$$"
mv "$CACHE.$$" "$CACHE"

printf '%s\n' "$token"
