#!/usr/bin/env bash
# Authenticates `gh` as a GitHub App installation: signs a JWT with the App's private key,
# looks up the (single) installation it's on, mints a short-lived installation access token
# from it, and hands that to `gh auth login`. Mirrors the flow in
# ../../orchestra/Orchestra/GitHub.lean (createJWT / createInstallationToken / setupGhAuth),
# minus the multi-installation/fork bookkeeping this project doesn't need.
#
# Installation tokens expire after an hour — rerun this (it's on PATH as `gh-app-login`)
# whenever `gh`/`git push` starts failing with 401s.
set -euo pipefail

: "${GITHUB_APP_ID:?set GITHUB_APP_ID}"
: "${GITHUB_APP_PRIVATE_KEY_PATH:?set GITHUB_APP_PRIVATE_KEY_PATH}"

if [ ! -r "$GITHUB_APP_PRIVATE_KEY_PATH" ]; then
  echo "gh-app-login: can't read GITHUB_APP_PRIVATE_KEY_PATH ($GITHUB_APP_PRIVATE_KEY_PATH)" >&2
  exit 1
fi

b64url() { openssl base64 -e -A | tr '+/' '-_' | tr -d '='; }

iat=$(date +%s)
exp=$((iat + 540)) # GitHub rejects a JWT whose lifetime exceeds 10 minutes.
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
  echo "gh-app-login: no installations found for this App:" >&2
  echo "$installations" >&2
  exit 1
fi

token=$(curl -sS -X POST -H "Authorization: Bearer $jwt" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/app/installations/${installation_id}/access_tokens" | jq -r '.token // empty')
if [ -z "$token" ]; then
  echo "gh-app-login: GitHub did not return a token for installation $installation_id" >&2
  exit 1
fi

gh auth login --with-token <<< "$token"
echo "gh-app-login: authenticated as the GitHub App installation (token expires in ~1h)."
