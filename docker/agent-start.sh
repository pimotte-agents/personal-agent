#!/usr/bin/env bash
# Runs as the unprivileged `agent` user. ~/.elan and ~/.pi are bind-mounted from the host cache
# dirs, so on a fresh (empty) cache they need to be populated before first use.
set -euo pipefail

if [ ! -x "$ELAN_HOME/bin/elan" ]; then
  curl https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh -sSf \
    | sh -s -- -y --no-modify-path --default-toolchain none
fi

# Best-effort: no network / no key mounted shouldn't block getting a shell.
if [ -n "${GITHUB_APP_ID:-}" ] && [ -n "${GITHUB_APP_PRIVATE_KEY_PATH:-}" ]; then
  gh-app-login || echo "agent-start: gh-app-login failed, continuing without gh auth" >&2
fi

# Long-lived `claude setup-token` token, so `claude` authenticates against the subscription
# without an interactive OAuth login. Unset (rather than run `claude-local`, see ../bin) to talk
# to the local llama.cpp server instead.
if [ -n "${CLAUDE_OAUTH_TOKEN_PATH:-}" ] && [ -f "${CLAUDE_OAUTH_TOKEN_PATH}" ]; then
  export CLAUDE_CODE_OAUTH_TOKEN="$(cat "$CLAUDE_OAUTH_TOKEN_PATH")"
fi

exec "$@"
