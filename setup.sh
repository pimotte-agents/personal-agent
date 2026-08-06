#!/usr/bin/env bash
# Creates the untracked directories docker-compose.yaml expects to bind-mount (see .gitignore:
# /projects/, /.docker-cache/, /docker/secrets/). Run once after cloning, before `docker compose up`.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

mkdir -p projects
mkdir -p .docker-cache/npm .docker-cache/elan .docker-cache/gh .docker-cache/claude

# Claude Code's config file, not a directory — an empty file isn't valid JSON, and a missing one
# would make Docker create a directory in its place at mount time.
if [ ! -f .docker-cache/claude.json ]; then
  echo '{}' > .docker-cache/claude.json
fi

mkdir -p docker/secrets
if [ ! -f docker/secrets/github-app.pem ]; then
  echo "setup.sh: docker/secrets/github-app.pem is missing." >&2
  echo "  Copy the GitHub App private key there before" >&2
  echo "  starting the container, or gh-app-login will fail at boot (non-fatally)." >&2
fi
