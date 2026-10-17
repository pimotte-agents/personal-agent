#!/usr/bin/env bash
# Installed as /usr/local/bin/gh, ahead of the real /usr/bin/gh on PATH. Hands gh a fresh GitHub
# App installation token via GH_TOKEN on every call, so it never runs with an expired one. An
# explicitly set GH_TOKEN wins.
if [ -z "${GH_TOKEN:-}" ] && token=$(sudo -n /usr/local/bin/gh-app-token 2>/dev/null); then
  export GH_TOKEN="$token"
fi
exec /usr/bin/gh "$@"
