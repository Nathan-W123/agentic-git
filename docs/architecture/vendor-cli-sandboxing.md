# Running a vendor CLI inside the Docker sandbox

Codex, Claude Code, and Gemini CLI run on the host today, under their own
sandboxing, and the adapters refuse to combine with the project's Docker
sandbox rather than running unconfined while appearing sandboxed. That refusal
rested on three obstacles, recorded in
[the remote worker protocol](../protocol/remote-workers.md#why-the-vendor-clis-stay-on-the-host).

Two of them now have mechanisms. This document records what was built, what was
measured, and what is still missing — including one obstacle that turned out to
be smaller than it looked and one that turned out to be larger.

## 1. Egress: an allowlist, not a wider network

The sandbox runs `--network none`. A vendor CLI with no route to its provider
cannot do anything, and the previously available alternative — setting
`sandbox.network` — traded deny-default egress for unrestricted egress, which
is strictly worse than the CLI's own host sandbox.

What is built is a per-task gateway (`EgressGateway` in
`@coord/workspace-manager`) with two layers:

- The agent container joins a Docker network created `--internal`. Such a
  network has no route off the host **at all** — not a filtered one.
- One proxy container is attached to both that network and a bridged one,
  which makes it the only egress path. It serves `CONNECT` and nothing else,
  to allowlisted hosts and ports only.

The layering is the point, and the two layers answer different questions. The
`HTTPS_PROXY` variables the container is given are what make *allowed* traffic
work. The internal network is what makes *everything else* fail. A CLI that
ignored the proxy convention entirely would therefore reach nothing rather than
reaching everything — so a client that does not honour `HTTPS_PROXY` is a
functionality problem, never a containment one. That distinction is what makes
this safe to ship before every CLI's proxy behaviour has been confirmed.

Two deliberate limits:

- **The allowlist is authority-only.** `CONNECT api.anthropic.com:443` names a
  host and a port and nothing else, and the tunnel is opaque afterwards. This
  gates *who* is reachable and can never gate *what* is asked of them. The same
  property is why the proxy never sees a credential in flight: there is no TLS
  interception.
- **A credential that can reach an allowed host can be exfiltrated to it.**
  Scoping egress bounds which *hosts* an agent can talk to, not what it may say.

### The host list is discovered, not guessed

No vendor documents every host its CLI dials, and the set moves with releases.
`DEFAULT_EGRESS_ALLOWLISTS` therefore ships a starting point, not a
specification:

| Adapter | Starting allowlist |
| --- | --- |
| `codex` | `api.openai.com`, `auth.openai.com`, `chatgpt.com` |
| `claude` | `api.anthropic.com`, `statsig.anthropic.com` |
| `gemini` | `generativelanguage.googleapis.com`, `oauth2.googleapis.com`, `cloudcode-pa.googleapis.com` |

What makes that tolerable is that every refusal is recorded. The proxy writes
one JSON object per decision, so the correct list for a given CLI version is
read off a run rather than guessed at:

```json
{"event":"denied","at":"…","reason":"host","host":"telemetry.example.com","port":443}
```

`EgressGateway.auditLog()` returns that stream. Treat a `denied` entry as the
instruction to widen the list, and prefer the exact host over a dot-prefixed
parent — `.googleapis.com` admits every Google API, which is a much larger
grant than `generativelanguage.googleapis.com`.

A dot-prefixed entry matches subdomains only and never the bare apex, so
`.googleapis.com` does not admit `googleapis.com`, and — the case that matters —
does not admit `googleapis.com.evil.test`.

## 2. Credentials: two files, not a home directory

All three CLIs authenticate against login state in the user's home directory.
Mounting that home would hand an agent far more than its credentials: on the
machine this was built against, `~/.claude.json` is 50 KB of project history and
MCP server configuration, and `~/.codex` holds session, goal, and memory
SQLite databases. None of it is needed to make an API call.

`resolveVendorCredentials` names the specific files instead:

| Adapter | Mounted | Environment |
| --- | --- | --- |
| `codex` | `~/.codex/auth.json` | `CODEX_HOME` |
| `claude` | `~/.claude/.credentials.json` | `CLAUDE_CONFIG_DIR` |
| `gemini` | `~/.gemini/oauth_creds.json`, and `google_accounts.json`, `projects.json`, `installation_id` when present | — |

The container gets a tmpfs home containing one or two files. A missing
*required* credential throws rather than producing a container that starts,
fails to authenticate, and reports an empty changeset as a completed task —
the failure the adapters already work to make loud.

### Why the default is a copy, not a read-only bind

The task called for read-only mounts, and that was the starting design. It does
not survive contact with the files: all three vendors store OAuth material the
CLI **rewrites in place** when the access token ages out. The files carry
`last_refresh` and `expiry_date` fields precisely because something writes them.
A read-only bind therefore works until the first refresh and then fails in a way
that reads as an auth bug rather than as a mount policy.

So `ephemeral-copy` is the default: the credential is staged into a task-scoped
copy mounted read-write, the CLI refreshes normally, the refreshed token dies
with the task, and nothing in the container ever opens the host's own file for
writing. `read-only` remains available and is the right choice for API-key
deployments, which never rewrite anything.

## 3. Double-sandboxing: sound, under a precondition

Codex confines its edit phase with `--sandbox workspace-write`, which needs a
platform sandbox backend. Inside a container with `--cap-drop ALL` and
`--security-opt no-new-privileges` that either fails or must be disabled.

**Disabling it is sound, and here is the argument.** "Always keep sandboxing
enabled" is a claim about the boundary, not about which layer draws it. Compare
what each layer grants:

- `workspace-write` on the host confines writes to the task worktree.
- The container exposes exactly one host path — the task worktree bind mount —
  plus a tmpfs. Its root filesystem is read-only.

The blast radius is therefore *the same set of bytes* either way, and the
container reaches it with capabilities dropped and privilege escalation
blocked, which the host sandbox does not do. Codex's `workspace-write` also
restricts network by default; inside the container, egress is bounded by the
internal network and the allowlist above, which is a narrower grant than a
bridged network, not a wider one. Nothing is given up by relocating the
boundary.

The argument holds **only while the container actually is the boundary**, which
is why it is enforced rather than assumed. `assertContainerIsSoleBoundary`
refuses to disable Codex's own sandbox when the container has been weakened —
a writable root filesystem, retained capabilities, `no-new-privileges` off, or
a widened network. On any of those, disabling Codex's sandbox would *remove*
sandboxing rather than move it, and the call throws instead.

Two honest caveats. `danger-full-access` lets Codex read the credential file
mounted for it — inherent to giving a CLI its own credentials, and no different
from the host case. And Codex's Windows sandbox helper has been seen to go
missing in a way that silently degraded every write — the reason
`CodexWriteDeniedError` exists in the adapter. The container path needs no such
helper, which is a secondary benefit rather than the motivation.

## What is still missing

The mechanism is built and the adapters still refuse, deliberately. The
remaining work is adapter wiring, and one piece of it is not the small change
the earlier note assumed:

- **`CodexAdapter` and the prompt-cli adapters do not accept a
  `WorkspaceSandbox` at all.** Only `GenericCliAdapter` does. They call their
  process runner directly, so each needs the `wrapLaunch` /
  `resolveWorkspacePath` treatment `GenericCliAdapter` already has.
- **Codex writes its `--output-schema` file to a host temp directory.** The
  container cannot see it, and the schema is what enforces structured output,
  so it is not optional. This needs either an additional bind mount surface on
  `DockerSandboxOptions` or a different location for the file — a design
  decision, not a mechanical edit.
- **Only the local CLI run path was considered.** `apps/worker`,
  `worker-operations`, `recovery`, and the benchmark fixture each construct
  their own `DockerWorkspaceManager` and would each need the gateway lifecycle
  threaded through them.

`sandbox.egressAllowlist` and `sandbox.credentials` validate in project
configuration today and are consumed by `openVendorSandbox` and the
verification script, but **no vendor adapter reads them yet**.

## Verifying it

Two layers, deliberately split by what they need:

```bash
npx turbo run test --filter=@coord/workspace-manager
```

covers the allowlist decision — authority parsing, subdomain matching, the
lookalike-suffix case, tunnelling, and refusals — over real sockets in process,
with no daemon and no traffic leaving the machine.

```bash
npm run verify:egress
```

covers what only a live daemon can answer: that a container on the gateway's
network cannot reach a non-allowlisted host, that it **cannot bypass the proxy
at all**, and that a credential mount exposes one file rather than a home
directory. It probes with DNS and TCP only — no model call, no token spend.
