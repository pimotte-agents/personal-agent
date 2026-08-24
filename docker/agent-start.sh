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

exec "$@"
