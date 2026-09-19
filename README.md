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
docker compose run --rm agent                # bash shell in /workspace
docker compose run --rm agent claude         # Claude Code, against your subscription
docker compose run --rm agent claude-local   # Claude Code, against the local llama.cpp server
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
| `./docker/secrets/claude-oauth-token` | `/secrets/claude-oauth-token` (ro) | **no** | long-lived Claude Code subscription token |
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

## Claude Code auth

Two ways to run `claude` in the container, picked per-invocation rather than baked into the
image:

- **Subscription** (`claude`): authenticates with a long-lived (1 year) OAuth token instead of
  the interactive `/login` device flow, which doesn't fit a non-interactive container well. Run
  `claude setup-token` yourself (on the host, or in an interactive container shell — it needs a
  real login in a browser) and paste the resulting `sk-ant-oat01-...` token into
  `docker/secrets/claude-oauth-token` (gitignored, never committed). `docker/agent-start.sh`
  exports it as `CLAUDE_CODE_OAUTH_TOKEN` at container start; missing/unreadable file just means
  `claude` falls back to asking you to log in interactively instead of failing outright. Treat
  this token like a password — anyone with it can use your subscription.
- **Local model** (`claude-local`, in `./bin`): points Claude Code at the same llama.cpp server
  `pi` uses (`pi/agent/models.json`), via its native Anthropic Messages API
  (`http://host.docker.internal:8080/v1/messages` — llama.cpp added this recently, so `claude`
  needs no translation proxy in front of it). Unsets `CLAUDE_CODE_OAUTH_TOKEN` so it can't
  accidentally fall through to the subscription. Tool use needs `llama-server` started with
  `--jinja`; override the model it asks for with `ANTHROPIC_MODEL=... claude-local`.

## Container internals

Container starts as root (`docker/entrypoint.sh`): sets the iptables rule, `chown`s the mounted
dirs to the unprivileged `agent` user, then drops to it (`setpriv`) and runs
`docker/agent-start.sh`, which lazily installs `elan` into `~/.elan` on a first/empty cache,
installs `pi-mcp-adapter`, runs `gh-app-login`, exports `CLAUDE_CODE_OAUTH_TOKEN` if
`docker/secrets/claude-oauth-token` is mounted, then execs whatever command was requested
(`bash` by default).
