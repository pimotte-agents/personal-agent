# Container environment

Applies to every project in this container. Project-specific instructions (the repo's own
`AGENTS.md` / `CLAUDE.md`) take precedence.

## Where you are

- A Debian Docker container, running as the unprivileged user `agent`. Permission prompts are
  bypassed, so act carefully: `/workspace` is the owner's real `projects/` directory on their
  machine, and deletions there are not recoverable.
- Internet access is open. The host machine itself is reachable only on port 8080 (the local
  llama.cpp server).

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
  build-essential.
- `pip install <pkg>` works (it installs into `~/.local`) but doesn't survive a container restart.
  For a project that needs Python packages, use a `.venv` inside the project.
- No root access and no `apt`. If you need a tool that isn't installed, ask the user rather than
  working around it at length; they can add it to the image.

## Working habits

- Long-running commands (full builds, searches, experiments): run them in the background with
  output going to a log file, then check the log. Do not poll with long `sleep`s.
- Keep tool output short (`| head`, `| tail`, `grep`). Read big files by line range.
- Edit files with the edit/write tools, not `cat > file`, `sed -i` or ad-hoc Python, so edits stay
  reviewable and (in Claude Code) undoable.
- Git: stage the files you changed by name, never `git add -A` / `git add .`. Commit and push
  only when asked, or when the project's instructions say to.

## Lean

- Toolchains live in `~/.elan` and are shared between projects. In a mathlib project, run
  `lake exe cache get` before the first build instead of compiling mathlib.
- Check a single file with `lake env lean <file>` (seconds); keep full `lake build` for the end.
- Look names up with `#check` / `exact?` in a scratch file instead of guessing or grepping mathlib.
