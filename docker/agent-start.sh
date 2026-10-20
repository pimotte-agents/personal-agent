#!/usr/bin/env bash
# Runs as the unprivileged `agent` user. ~/.elan, ~/.npm-global and ~/.pi are bind-mounted from
# the host cache dirs, so on a fresh (empty) cache they need to be populated before first use.
set -euo pipefail

if [ ! -x "$ELAN_HOME/bin/elan" ]; then
  curl https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh -sSf \
    | sh -s -- -y --no-modify-path --default-toolchain none
fi

# claude and pi live in the agent-owned $NPM_CONFIG_PREFIX so they can update themselves; install
# them only when missing, after that they keep themselves current.
if [ ! -x "$NPM_CONFIG_PREFIX/bin/claude" ]; then
  npm install -g @anthropic-ai/claude-code
fi
if [ ! -x "$NPM_CONFIG_PREFIX/bin/pi" ]; then
  npm install -g --ignore-scripts @earendil-works/pi-coding-agent
fi

# Warm the GitHub token cache and surface a broken setup early. Best-effort: no network / no key
# mounted shouldn't block getting a shell. git and gh fetch tokens on demand from here on.
if ! sudo -n /usr/local/bin/gh-app-token >/dev/null; then
  echo "agent-start: couldn't mint a GitHub App token, continuing without GitHub auth" >&2
fi

# Claude Code reads ~/.claude/CLAUDE.md; ours is tracked in this repo as claude/CLAUDE.md (pi has
# its own, pi/agent/AGENTS.md). Leave a real file alone.
if [ -f "$HOME/claude-instructions/CLAUDE.md" ] && { [ -L "$HOME/.claude/CLAUDE.md" ] || [ ! -e "$HOME/.claude/CLAUDE.md" ]; }; then
  ln -sfn "$HOME/claude-instructions/CLAUDE.md" "$HOME/.claude/CLAUDE.md"
fi

# Long-lived `claude setup-token` token, so `claude` authenticates against the subscription
# without an interactive OAuth login. Unset (rather than run `claude-local`, see ../bin) to talk
# to the local llama.cpp server instead.
if [ -n "${CLAUDE_OAUTH_TOKEN_PATH:-}" ] && [ -f "${CLAUDE_OAUTH_TOKEN_PATH}" ]; then
  export CLAUDE_CODE_OAUTH_TOKEN="$(cat "$CLAUDE_OAUTH_TOKEN_PATH")"
fi

exec "$@"
