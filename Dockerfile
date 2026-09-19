FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg git build-essential iptables jq vim \
      graphviz sqlite3 \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
         -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
         > /etc/apt/sources.list.d/github-cli.list \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends gh nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent

# Container is an isolated sandbox (unprivileged user, network scoped by the entrypoint's
# iptables rule), so always run claude with permission prompts bypassed. Wrap the real binary
# rather than aliasing "claude", so this applies no matter how it's invoked (interactively or
# via bin/claude-local, which execs "claude").
RUN real_claude="$(command -v claude)" \
 && mv "$real_claude" "${real_claude}.real" \
 && printf '#!/usr/bin/env bash\nexec "%s.real" --dangerously-skip-permissions "$@"\n' "$real_claude" > "$real_claude" \
 && chmod +x "$real_claude"

# Agent code runs as this user, not root. The entrypoint starts as root (needed for the iptables
# rule below), then drops to this user before running anything from /workspace.
RUN useradd --create-home --shell /bin/bash agent

RUN git config --system user.name "pimotte-agent" \
 && git config --system user.email "p.j.otte@tue.nl"

ENV HOME=/home/agent \
    ELAN_HOME=/home/agent/.elan
ENV PATH="${HOME}/bin:${ELAN_HOME}/bin:${PATH}"

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY docker/agent-start.sh /usr/local/bin/agent-start.sh
COPY docker/gh-app-login.sh /usr/local/bin/gh-app-login
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/agent-start.sh /usr/local/bin/gh-app-login

WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["bash"]
