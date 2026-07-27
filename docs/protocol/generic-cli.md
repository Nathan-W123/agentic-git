# Generic CLI Agent Protocol

`GenericCliAdapter` drives any command-line coding agent that speaks
newline-delimited JSON over stdin and stdout. The adapter never uses a shell:
the executable and its arguments are passed as an argument array.

- The host writes one JSON object per line to the agent's **stdin**.
- The agent writes one JSON object per line to its **stdout**.
- **stderr** is diagnostic only. It is captured and attached to error messages,
  and it never carries protocol meaning.

A request is answered by exactly one reply. `event` lines may be emitted at any
time and never count as a reply. Lines longer than 4 MiB are rejected.

## Host messages

### `start`

Sent immediately after the process is spawned.

```json
{
  "type": "start",
  "sessionId": "session_...",
  "taskId": "task_cap_value",
  "objective": "Cap the incremented value at ten",
  "repositoryId": "demo",
  "workspacePath": "/workspace",
  "canonicalVersion": {
    "sequence": 1,
    "revision": "...",
    "branch": "main",
    "createdAt": "2026-01-01T00:00:00Z"
  },
  "validationCommands": [
    { "executable": "node", "args": ["--test"], "label": "repository tests" }
  ]
}
```

### `plan_request`

```json
{ "type": "plan_request", "sessionId": "session_..." }
```

The agent must reply with a `plan`. `workspacePath` points at a disposable
worktree of the canonical revision. The agent may inspect it, but changes made
during planning are discarded and never become the execution changeset.

### `context`

```json
{
  "type": "context",
  "sessionId": "session_...",
  "workspacePath": "/workspace",
  "decision": { "decision": "approved", "...": "..." },
  "canonicalVersion": { "...": "..." },
  "plan": { "...": "..." },
  "planRevision": 2
}
```

`workspacePath` is the workspace **as the agent process sees it**. Under the
Docker sandbox this is the container mount point, not the host path. The agent
edits files under that path and replies with `done`.

The approved plan is echoed back because the agent is restarted between the
disposable planning workspace and the coordinator-granted execution workspace.

### `replan_request`

Sent before execution when a blocking task has promoted a newer canonical
revision. The optional `workspacePath` is a fresh read-only planning worktree.

```json
{
  "type": "replan_request",
  "sessionId": "session_...",
  "workspacePath": "/workspace",
  "request": {
    "taskId": "task_format_total",
    "previousPlan": { "...": "..." },
    "canonicalChange": {
      "changedFiles": ["src/counter.js"],
      "changedSymbols": ["increment"],
      "reason": "Blocking work changed canonical state before this task started"
    },
    "constraints": []
  }
}
```

The agent must inspect the new contract and answer with a complete `plan`.

### `scope_decision`

Answers a prior `scope_change_requested` event. The agent must not edit newly
requested resources until the decision is `approved` or
`approved_with_constraints`.

```json
{
  "type": "scope_decision",
  "sessionId": "session_...",
  "decision": {
    "requestId": "scope_...",
    "decision": "approved",
    "revisedPlan": { "...": "..." },
    "ownershipGrants": [],
    "constraints": [],
    "explanation": "Scope is conflict-free",
    "decidedAt": "2026-01-01T00:00:00Z"
  }
}
```

### `pause`, `resume`, `cancel`

```json
{ "type": "cancel", "sessionId": "session_..." }
```

Control messages are not acknowledged. The adapter reports
`supportsPause: true`; an agent must stop starting new edits while paused,
continue after `resume`, and exit promptly after `cancel`.

## Agent messages

### `plan`

```json
{
  "type": "plan",
  "plan": {
    "taskId": "task_cap_value",
    "objective": "Cap the incremented value at ten",
    "expectedFiles": ["src/counter.js", "test/cap.test.js"],
    "expectedSymbols": ["increment"],
    "dependencies": ["symbol:normalizeInput"],
    "expectedApis": [],
    "expectedSchemas": [],
    "expectedConfigKeys": [],
    "expectedTests": ["test/cap.test.js"],
    "expectedServices": [],
    "intent": "Bound the returned counter value without changing its API",
    "commands": [],
    "externalAccess": [],
    "riskLevel": "low"
  }
}
```

The plan is validated with `assertAgentPlan`. `expectedFiles` are normalized to
repository-relative POSIX paths, deduplicated, and sorted; a path that escapes
the repository is rejected. `taskId` must match the started task.

Files the agent later changes must be covered by `expectedFiles`. The
coordinator rejects a changeset that leaves the approved scope.

### `event`

```json
{ "type": "event", "event": { "event": "progress", "message": "editing" } }
```

Supported events are `progress`, `scope_change_requested`, and `completed`.
`occurredAt` is optional and is filled in by the host when omitted.

A scope request may name files, symbols, APIs, schemas, configuration keys,
tests, and services. It needs a stable `requestId` and a non-empty reason. The
agent should wait for the matching `scope_decision` before editing that scope.

### `done`

```json
{
  "type": "done",
  "symbolsChanged": ["increment"],
  "explanation": "capped the incremented value at ten"
}
```

Signals that editing is finished. Both fields are optional;
`symbolsChanged` falls back to the plan's `expectedSymbols`. The host then
collects the diff from the host-side worktree, so the agent must not commit.

### `error`

```json
{ "type": "error", "message": "no model credentials" }
```

Fails the request that is in flight.

## Running an agent

```powershell
$env:COORD_AGENT_CMD = "node"
$env:COORD_AGENT_ARGS = '["./my-agent.mjs"]'
npm.cmd run benchmark -- --live
```

| Variable | Meaning |
| --- | --- |
| `COORD_AGENT_CMD` | Agent executable. Required by `--live`. |
| `COORD_AGENT_ARGS` | JSON array of arguments, or a whitespace-separated list. |
| `COORD_AGENT_TASKS` | `cap` (default), `normalize`, `all`, or explicit task ids. |
| `COORD_AGENT_SANDBOX` | `docker` to confine the agent process, `none` by default. |
| `COORD_AGENT_IMAGE` | Container image. Required by `COORD_AGENT_SANDBOX=docker`. |
| `COORD_AGENT_NETWORK` | Docker network mode. Defaults to `none`. |

Tasks not listed in `COORD_AGENT_TASKS` keep their deterministic scripted
behavior, which is the path CI uses.

## Sandboxed execution

With `COORD_AGENT_SANDBOX=docker` the agent runs under
`DockerWorkspaceManager`. A container cannot gain a bind mount after it starts,
so the adapter runs two processes per session:

1. A planning container with a disposable canonical worktree, which answers
   `plan_request`.
2. An execution container that bind-mounts only the task worktree, which
   receives `start` again, then `context`.

Agents must therefore treat planning and execution as independent invocations
and rely on the `context` message rather than in-process state.

A sandboxed agent also cannot use git. The worktree's `.git` pointer refers to a
host path that is not mounted, so it is masked with a read-only empty file. Read and
write files under `workspacePath`; the coordinator collects the diff on the host
after `done`.
