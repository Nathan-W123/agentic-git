# Agent adapters: Claude, Codex, Gemini, and generic CLIs

Four adapter kinds drive coding agents through the platform's plan-first
lifecycle (plan → admission → execute in an isolated worktree → changeset →
validation → promotion). Which one runs is chosen per agent in
`.coordinator/config.json`:

```json
{
  "agents": {
    "claude":  { "adapter": "claude" },
    "codex":   { "adapter": "codex" },
    "gemini":  { "adapter": "gemini", "args": ["--model", "gemini-2.5-pro"] },
    "scripted": { "command": "node", "args": ["my-agent.js"] }
  },
  "defaultAgent": "claude"
}
```

| Adapter | Drives | How |
| --- | --- | --- |
| `claude` | Claude Code CLI | `claude -p --output-format json`; planning under `--permission-mode plan` (edits structurally refused), execution under `--dangerously-skip-permissions` inside the granted worktree |
| `codex` | OpenAI Codex CLI | `codex exec` with `--output-schema` enforcement; planning read-only, execution under Codex's `workspace-write` sandbox; native Windows explicitly uses the `elevated` backend |
| `gemini` | Gemini CLI | `gemini -p --output-format json`; planning in a disposable worktree, execution with `--yolo` auto-approval |
| `generic-cli` | anything | Your executable speaks the NDJSON protocol in `docs/protocol/generic-cli.md` over stdin/stdout |

`command` overrides the executable path; `args` accepts only a single
`--model <id>` pair for claude/codex/gemini (anything else is rejected so
configuration cannot weaken the enforced invocation mode); `env` adds
environment variables for the process. `planningTimeoutMs` and
`executionTimeoutMs` put hard deadlines on the corresponding provider calls;
the defaults are deliberately generous, so latency-sensitive local projects
should set them explicitly. Claude agents may also set `effort` to `low`,
`medium`, `high`, `xhigh`, or `max`; this is passed through as Claude's safe
`--effort` option and does not alter permissions. A Codex agent can set
`"windowsSandbox": "unelevated"` when administrator-approved elevated setup is
blocked by local policy; both modes retain scoped filesystem boundaries.

## The workflow, end to end

1. **Install and authenticate the vendor CLI once, on the machine that
   executes tasks** — the control-plane host for local runs, each worker host
   for remote runs. That means `claude` (login via claude.ai/console account
   or `ANTHROPIC_API_KEY`), `codex login` (ChatGPT account or
   `OPENAI_API_KEY`), or `gemini` (Google login or `GEMINI_API_KEY`). You do
   **not** log in through the dashboard, and the platform never sees or
   stores these credentials; API keys can alternatively be supplied per agent
   via the `env` block.
2. **Declare the agent** in `.coordinator/config.json` as above and restart
   the control plane (or worker).
3. **In the dashboard**: submit a task, pick the agent from the dropdown, and
   run the queue. The adapter asks the agent for a structural plan first,
   the coordinator admits or sequences it, execution happens in an isolated
   worktree, and only the resulting diff — validated and policy-gated —
   can reach canonical.

An unauthenticated CLI is caught, not trusted: a model that "completes"
without editing anything (the classic signature of a CLI answering with a
login prompt) fails the task rather than promoting an empty changeset.

## Confinement caveat

The `claude`, `codex`, and `gemini` adapters run the vendor CLI **on the
host**, using its own login state; their write-blast radius is bounded by the
task worktree plus each CLI's own sandboxing, and only the worktree diff
enters the pipeline. They therefore refuse to combine with the project's
Docker sandbox (`sandbox` in config) — that mode is for `generic-cli`
agents, which the platform can fully confine because it owns the process it
launches. If you need container isolation for a vendor CLI, wrap it as a
generic-cli agent inside an image with credentials injected, and accept that
protocol translation is on you.

What blocked it was the sandbox itself: it runs `--network none`, and a vendor
CLI with no route to its provider's API cannot do anything at all — a DNS
lookup for a vendor endpoint inside the sandbox fails with `EAI_AGAIN`, while
the same lookup on a bridged network resolves. Widening the network would trade
deny-default egress for unrestricted egress, which is worse than what the
vendor CLI's own sandbox already gives you. Their credentials were the second
obstacle: subscription logins live in the host home directory, which the
container deliberately cannot see.

Both now have mechanisms — a per-task egress allowlist and minimal-scope
credential mounts — and the Codex double-sandboxing question is resolved. The
refusal remains because the adapters themselves are not wired for it:
`CodexAdapter` and the prompt-cli adapters accept no `WorkspaceSandbox`, and
Codex's `--output-schema` file is written where the container cannot read it.
See [vendor CLI sandboxing](vendor-cli-sandboxing.md); `docs/protocol/remote-workers.md`
records the original measurements.

## Cost reporting

Adapters may report what a session spent, and the coordinator records it per
task and per project so a project's token budgets can be enforced. The Codex
adapter parses the figure the CLI prints. A `generic-cli` agent may attach
`{"tokens": {"total": n, "input": n, "output": n}}` to its `done` message.

Reporting is optional and never inferred. Claude Code and Gemini CLI are not
parsed for usage today, so agents on those adapters are recorded as having
reported nothing — which is different from having spent nothing, and is what
a project with a token budget will see.
