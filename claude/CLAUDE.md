# Container environment

Applies to every project in this container. Project-specific instructions (the repo's own
`AGENTS.md` / `CLAUDE.md`) take precedence.

## Where you are

- A Debian Docker container, running as the unprivileged user `agent`. Permission prompts are
  bypassed, so act carefully: `/workspace` is the owner's real `projects/` directory on their
  machine, and deletions there are not recoverable.
- Internet access is open. The host machine itself is reachable only on port 8080 (the local
  llama.cpp server).

## Cost of resources

Prefer the cheapest resource that does the job:

1. **CPU time in the container is cheap.** Scripts, `rg`, `jq`, builds, test runs, brute-force
   checks and long-running computations cost the user almost nothing. Prefer writing a script or
   running a command over reasoning through something by hand or reading lots of output.
2. **The local llama-server (through `pi`) is more expensive.** It is a single GPU-bound server
   shared with the user's other work; use it for simple tasks you would otherwise spend Claude
   tokens on (see below), not for things a script can do.
3. **Claude tokens are the user's bottleneck.** Every token you read or write counts. Keep tool
   output short, read files by line range, avoid re-reading, and delegate bulk or mechanical work
   instead of doing it in your own context.

## Delegating to pi

`pi` is a coding agent backed by the local llama-server (Qwen 27B). It is weaker than you but
free in Claude tokens, so use it as a subagent for simple, well-specified tasks: bulk or
mechanical edits, summarising or searching files, drafting boilerplate, first-pass explanations.
Don't give it tasks needing deep reasoning, subtle design decisions or security-sensitive work,
and review what it returns.

- First check that the server is available (`curl -sf -m 3 http://host.docker.internal:8080/health`).
  If the check fails, don't use pi; do the work yourself.
- Run it non-interactively with a self-contained prompt: `pi -p "<task, with file paths and the
  expected output>"`. It has no access to your conversation.
- **Run at most one pi instance at a time.** The llama-server has limited resources, so wait for
  a running pi to finish before starting another and never launch several in parallel. Pass
  long-running ones through a log file in the background as described under Working habits, and
  check that no `pi` process is still running (`pgrep -x pi`) before starting a new one.

## GitHub

- Authentication is automatic: git (credential helper) and `gh` (wrapper) fetch a fresh GitHub
  App token on every call, as `pimotte-agents[bot]`. You don't need to log in or refresh anything.
- If something still fails with a 401, run `gh-app-login` once. If that fails, stop and tell the
  user.
- Do not look for tokens or keys (`/root`, `/etc/gh-app.conf`, `hosts.yml`, environment
  variables), and never print one.
- `git@github.com:` URLs are rewritten to HTTPS, so submodules with ssh URLs work.

## Tools

- Available: `git`, `gh`, `jq`, `curl`, `rg`, `sqlite3`, `graphviz`, `ps`/`top`, `file`,
  `pdftotext`, `python3` with `pip`/`venv`, `node`/`npm`, `elan`/`lake`/`lean`, `ssh`,
  build-essential, `pi`.
- `pip install <pkg>` works (it installs into `~/.local`) but doesn't survive a container restart.
  For a project that needs Python packages, use a `.venv` inside the project.
- No root access and no `apt`. If you need a tool that isn't installed, ask the user rather than
  working around it at length; they can add it to the image.

## Working habits

- Long-running commands (full builds, searches, experiments): run them in the background with
  output going to a log file, then check the log. Do not poll with long `sleep`s.
- Keep tool output short (`| head`, `| tail`, `grep`). Read big files by line range.
- Edit files with the edit/write tools, not `cat > file`, `sed -i` or ad-hoc Python, so edits stay
  reviewable and undoable.
- Git: stage the files you changed by name, never `git add -A` / `git add .`. Commit and push
  only when asked, or when the project's instructions say to.

## Lean

- Toolchains live in `~/.elan` and are shared between projects. In a mathlib project, run
  `lake exe cache get` before the first build instead of compiling mathlib.
- Check a single file with `lake env lean <file>` (seconds); keep full `lake build` for the end.
- Look names up with `#check` / `exact?` in a scratch file instead of guessing or grepping mathlib.
