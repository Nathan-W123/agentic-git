# Running your desktop as a worker

The point of this setup is that the machine holding your vendor logins does
the work while you are somewhere else. Your desktop runs the worker daemon;
your phone is a browser talking to the control plane like any other client.
Nothing about the phone needs the CLIs, and the control plane never needs
your Claude or ChatGPT session.

## What the worker uses

A worker executes with **its own local logins**. `claude` and `codex` are
already signed in on that machine, and the adapters shell out to them:

| Adapter | Planning | Execution |
| --- | --- | --- |
| `claude` | `claude -p --output-format json --permission-mode plan --json-schema …` | `claude -p --output-format json --dangerously-skip-permissions` |
| `codex` | `codex exec --json` with a structured output schema | `codex exec --json --sandbox …` |

Planning runs under a mode that structurally refuses edits, so the plan the
control plane arbitrates cannot have changed anything yet.

## Configure the worker's project

The worker reads its own `.coordinator/config.json` — not the control
plane's. Only the agents listed here are advertised when it registers, and
only tasks naming those adapters will ever be leased to it.

```json
{
  "version": 1,
  "validationCommands": [],
  "agents": {
    "claude": { "adapter": "claude" },
    "codex": {
      "adapter": "codex",
      "command": "C:\\Users\\you\\.codex\\.sandbox-bin\\codex.exe"
    }
  }
}
```

`command` is only needed when the executable is not on `PATH`. On Windows
the `claude` npm shim cannot be spawned directly; the adapter resolves the
native executable itself, so leaving `command` unset is correct.

**Do not configure a `sandbox` block for a worker that runs `claude` or
`gemini`.** Those CLIs authenticate as the host user with their own login
state and cannot run inside the project's Docker sandbox — the adapter
refuses rather than running them somewhere their credentials do not exist.

## Start it

Mint a token with the `run_task` scope from Settings → API tokens, then:

```bash
COORD_SERVER=https://your-control-plane \
COORD_TOKEN=coord_pat_… \
COORD_PROJECT_ROOT=/path/to/worker/project \
COORD_PROJECT_ID=project_local \
COORD_WORKER_NAME=nathan-desktop \
node apps/worker/dist/index.js
```

`COORD_REPOSITORY` optionally pins the worker to one repository. A planned
shutdown (Ctrl-C) hands the lease back so the task is picked up again
immediately instead of waiting out the expiry.

## What you see from the phone

The Overview's **Agents running** dial carries the platform-wide count of
agents executing right now, counted from active leases rather than from
registrations, so an idle fleet reads as zero rather than as the number of
machines that once said hello.

That dial is also how you hand the fleet work. **Hover it** on a machine with
a mouse and the dispatch panel opens beside it; **tap it** on a touchscreen
and the same panel comes up as a sheet from the bottom of the screen. It is a
real button, so a keyboard reaches it too — Tab to it and press Enter. Hover
opens the panel only for as long as the pointer stays on it or in it; a tap,
click, or Enter pins it open until you dismiss it with Cancel, Escape, or a
tap outside.

The panel asks for an objective and a repository, then shows the two routes:

- **Run here** — the control plane plans, executes, validates and promotes in
  process.
- **Remote worker** — the task is left in the queue for a registered worker to
  lease through the worker protocol.

**Remote is the default whenever a worker advertises the task's adapter**, and
the panel names how many are listening. If you pick remote with nobody
connected, the panel says so plainly: the task waits in the queue rather than
pretending to have started.

The same rule governs the chat panel's **Build** mode, which submits a task
directly: with a worker advertising the adapter it queues for that worker, and
only with no such worker does the control plane start the run itself. Either
way the task card stays in the conversation and tracks the same coordinator
state the Executions view shows, so you can watch a task your desktop is
running from wherever you submitted it.
