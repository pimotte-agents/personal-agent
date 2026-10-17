#!/usr/bin/env bash
# Runs as root. Restricts the container's access to the host machine to a single port, then
# drops privileges before running anything from the (untrusted) /workspace bind mount.
set -euo pipefail

# host.docker.internal is added via the `extra_hosts: host-gateway` entry in docker-compose.yaml.
# Only the destination IP matters here — general internet egress (Anthropic API, npm, GitHub) is
# untouched, this only scopes what the container can reach *on the host*.
HOST_IP="$(getent hosts host.docker.internal | awk '{print $1}' | head -n1 || true)"
if [ -n "$HOST_IP" ]; then
  iptables -A OUTPUT -d "$HOST_IP" -p tcp --dport "${HOST_ALLOWED_PORT:-8080}" -j ACCEPT
  iptables -A OUTPUT -d "$HOST_IP" -j DROP
fi

# Bind-mounted cache/workspace dirs may be freshly created (root-owned) or owned by whatever UID
# they had on a previous run; make sure the agent user can write them either way.
chown -R agent:agent /home/agent /workspace

# GitHub App config for gh-app-token, which `agent` can only run via sudo (sudo resets the
# environment, so it reads this root-only file instead). The key path points under /root, which
# `agent` can't enter; unset the variables so agents don't go looking for the key.
if [ -n "${GITHUB_APP_ID:-}" ] && [ -n "${GITHUB_APP_PRIVATE_KEY_PATH:-}" ]; then
  (umask 077 && printf 'GITHUB_APP_ID=%q\nGITHUB_APP_PRIVATE_KEY_PATH=%q\n' \
    "$GITHUB_APP_ID" "$GITHUB_APP_PRIVATE_KEY_PATH" > /etc/gh-app.conf)
fi
unset GITHUB_APP_ID GITHUB_APP_PRIVATE_KEY_PATH

exec setpriv --reuid=agent --regid=agent --init-groups /usr/local/bin/agent-start.sh "$@"
