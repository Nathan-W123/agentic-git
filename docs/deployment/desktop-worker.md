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

Submitting a task from the chat panel's **Dispatch** button defaults to the
remote route whenever a worker advertises that adapter, and names how many
are listening. The task card stays in the conversation and tracks the same
coordinator state the Executions view shows, so you can watch a task your
desktop is running from wherever you submitted it.

The Overview's **Agents running** dial carries the platform-wide count of
agents executing right now, counted from active leases rather than from
registrations, so an idle fleet reads as zero rather than as the number of
machines that once said hello.
