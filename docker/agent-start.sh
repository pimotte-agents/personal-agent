#!/usr/bin/env bash
# Runs as the unprivileged `agent` user. ~/.elan and ~/.pi are bind-mounted from the host cache
# dirs, so on a fresh (empty) cache they need to be populated before first use.
set -euo pipefail

if [ ! -x "$ELAN_HOME/bin/elan" ]; then
  curl https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh -sSf \
    | sh -s -- -y --no-modify-path --default-toolchain none
fi

# Warm the GitHub token cache and surface a broken setup early. Best-effort: no network / no key
# mounted shouldn't block getting a shell. git and gh fetch tokens on demand from here on.
if ! sudo -n /usr/local/bin/gh-app-token >/dev/null; then
  echo "agent-start: couldn't mint a GitHub App token, continuing without GitHub auth" >&2
fi

# One set of container-wide agent instructions: pi reads ~/.pi/agent/AGENTS.md (tracked in this
# repo as pi/agent/AGENTS.md); Claude Code reads ~/.claude/CLAUDE.md. Leave a real file alone.
if [ -f "$HOME/.pi/agent/AGENTS.md" ] && { [ -L "$HOME/.claude/CLAUDE.md" ] || [ ! -e "$HOME/.claude/CLAUDE.md" ]; }; then
  ln -sfn "$HOME/.pi/agent/AGENTS.md" "$HOME/.claude/CLAUDE.md"
fi

# Long-lived `claude setup-token` token, so `claude` authenticates against the subscription
# without an interactive OAuth login. Unset (rather than run `claude-local`, see ../bin) to talk
# to the local llama.cpp server instead.
if [ -n "${CLAUDE_OAUTH_TOKEN_PATH:-}" ] && [ -f "${CLAUDE_OAUTH_TOKEN_PATH}" ]; then
  export CLAUDE_CODE_OAUTH_TOKEN="$(cat "$CLAUDE_OAUTH_TOKEN_PATH")"
fi

exec "$@"
