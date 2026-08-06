# personal-agent

A minimal debian container with `gh`, `elan`/`lean`, `node`, `claude` (Claude Code), and `pi`
(pi-coding-agent), for running coding agents against repos on your host without giving them the
run of your machine.

## First-time setup

```
./setup.sh
```

Creates the untracked directories `docker-compose.yaml` bind-mounts (see below), and warns if
`docker/secrets/github-app.pem` is missing. Copy your GitHub App's private key there — it's
gitignored, never committed.

## Using it

```
docker compose run --rm agent          # bash shell in /workspace
docker compose run --rm agent claude   # or any command directly
```

`/workspace` is `./projects` on the host — put the repos you want the agent to work on there.
Nothing else on your machine is mounted in.

## What's mounted where

| Host path | Container path | Tracked? | Purpose |
|---|---|---|---|
| `./projects` | `/workspace` | no | repos the agent works on |
| `./bin` | `~/bin` | yes | your own scripts, on `PATH` ahead of everything else |
| `./pi` | `~/.pi` | yes | pi config, incl. `pi/agent/models.json` (local llama.cpp provider) |
| `./docker/secrets/github-app.pem` | `/secrets/github-app.pem` (ro) | **no** | GitHub App private key |
| `./.docker-cache/{npm,elan,gh,claude}` | `~/.npm`, `~/.elan`, `~/.config/gh`, `~/.claude` | no | tool caches/config, survive rebuilds |

`./bin` and `./pi` are meant to be committed (put scripts/config you want to keep in them).
Everything else under `.docker-cache/`, `projects/`, and `docker/secrets/` is host-local
state — gitignored, recreated by `setup.sh`.

## Network

The container has normal internet access (needed for the Claude/npm/GitHub APIs). What's
restricted is the **host machine itself**: an iptables rule set up by `docker/entrypoint.sh`
allows the container to reach the host only on `HOST_ALLOWED_PORT` (default `8080`, e.g. a local
llama.cpp server) and drops everything else addressed at the host. This needs `NET_ADMIN`/
`NET_RAW`, which is why they're granted in `docker-compose.yaml`.

## GitHub auth

The container authenticates `gh` as a GitHub App installation rather than a personal token:
`docker/gh-app-login.sh` signs a JWT with the mounted private key, mints a short-lived (~1h)
installation access token, and runs `gh auth login --with-token`. This runs automatically at
container start (non-fatal if the key isn't there) and is on `PATH` as `gh-app-login` — rerun it
manually once the hour is up and `gh`/`git push` start failing with 401s.

`GITHUB_APP_ID` defaults to the App already set up for this key; override it in a `.env` file if
you swap in a different App/key.

## Container internals

Container starts as root (`docker/entrypoint.sh`): sets the iptables rule, `chown`s the mounted
dirs to the unprivileged `agent` user, then drops to it (`setpriv`) and runs
`docker/agent-start.sh`, which lazily installs `elan` into `~/.elan` on a first/empty cache,
installs `pi-mcp-adapter`, runs `gh-app-login`, then execs whatever command was requested
(`bash` by default).
