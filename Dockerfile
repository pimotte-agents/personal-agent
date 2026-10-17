FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg git build-essential iptables jq vim \
      graphviz sqlite3 chromium \
      procps file ripgrep python3-pip python3-venv poppler-utils openssh-client sudo \
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
 && git config --system user.email "p.j.otte@tue.nl" \
 && git config --system credential.https://github.com.helper ghapp \
 && git config --system url."https://github.com/".insteadOf "git@github.com:" \
 && git config --system --add url."https://github.com/".insteadOf "ssh://git@github.com/"

# GitHub App auth: the private key is mounted under /root (0700, so `agent` can't read it) and only
# root can mint tokens from it. `agent` may run exactly gh-app-token via sudo, and the git
# credential helper and gh wrapper call it on demand, so tokens never go stale.
RUN chmod 700 /root \
 && printf '%s\n' \
      'agent ALL=(root) NOPASSWD: /usr/local/bin/gh-app-token "", /usr/local/bin/gh-app-token --refresh' \
      > /etc/sudoers.d/gh-app-token \
 && chmod 440 /etc/sudoers.d/gh-app-token \
 && visudo -cf /etc/sudoers.d/gh-app-token

# Debian marks the system Python as externally managed; in this throwaway container plain
# `pip install` (which falls back to ~/.local) is fine.
ENV PIP_BREAK_SYSTEM_PACKAGES=1

ENV HOME=/home/agent \
    ELAN_HOME=/home/agent/.elan
ENV PATH="${HOME}/bin:${ELAN_HOME}/bin:${PATH}"

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY docker/agent-start.sh /usr/local/bin/agent-start.sh
COPY docker/gh-app-login.sh /usr/local/bin/gh-app-login
COPY docker/gh-app-token.sh /usr/local/bin/gh-app-token
COPY docker/git-credential-ghapp.sh /usr/local/bin/git-credential-ghapp
COPY docker/gh-wrapper.sh /usr/local/bin/gh
RUN chmod 755 /usr/local/bin/entrypoint.sh /usr/local/bin/agent-start.sh /usr/local/bin/gh-app-login \
      /usr/local/bin/gh-app-token /usr/local/bin/git-credential-ghapp /usr/local/bin/gh

WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["bash"]
