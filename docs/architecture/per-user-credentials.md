# Per-user provider accounts

Every user of a Relay deployment can run their prompts and tasks under **their
own** Claude, Codex, or Gemini account, instead of everyone sharing whatever
account the control-plane host machine is logged into.

This document records what per-user authentication is actually available from
these vendors — which is not what one would design from scratch — and what was
built on top of it.

## What was there before

Two paths reached a vendor CLI, and both spent the host owner's account:

- **Provider chat.** The dashboard's "Sign in with Claude" shells `claude
  login` on the control-plane host. That is why it was gated to system
  administrators: one browser flow, one machine, one account, funding
  everybody.
- **Build-mode dispatch with no worker registered.** The task runs on the
  control plane, and the adapter inherited the host process environment, so it
  authenticated as the host owner too.

Registered remote workers were already fine: each worker machine runs its own
logged-in CLI, so work dispatched to a worker already ran under that machine's
account. The gap was specifically the dashboard-only path.

## The near-blocker: only one vendor offers a grant

The design one would reach for first is a real OAuth flow — Relay registers as
a client, each user authorizes it, Relay holds a per-user grant and refreshes
it. **One of the three vendors offers something of that shape; two do not.**

Claude Code's login is an OAuth PKCE flow bound to *Claude Code's own* client
identifier, built for a CLI running on the end user's machine. There is no
published client registration for third-party servers, no redirect-URI
allowlist to join, and no consent screen that would name a different
application. Driving that flow from Relay's server would mean impersonating
Anthropic's own OAuth client and handling users' claude.ai credentials
directly. The Gemini CLI is the same shape.

**Codex is the exception.** `codex login --device-auth` is a device
authorization flow: the CLI runs on the server, prints a verification URL and
a one-time code, and the user approves it in their own browser against their
own ChatGPT account. What lands is a session issued to *this deployment* —
a genuine per-user grant, obtained through a flow the vendor built for exactly
this situation. It is the best per-user connection available anywhere in this
system, and Relay implements it.

For Claude and Gemini the ideal remains unavailable, and no amount of
implementation effort produces it. What follows is the realistic path.

## What is available: credentials the user mints

Every vendor supports a credential the user creates themselves and hands to a
headless runner — the mechanism built for CI:

| Vendor | Credential | How the user gets it | How it is delivered |
| --- | --- | --- | --- |
| Codex | **ChatGPT subscription session** | `codex login --device-auth`, run by Relay, approved in the user's browser | `auth.json` in the staged `CODEX_HOME` |
| Claude | Subscription OAuth token (`sk-ant-oat…`) | `claude setup-token` on their own machine | `CLAUDE_CODE_OAUTH_TOKEN` |
| Claude | Anthropic API key | console.anthropic.com | `ANTHROPIC_API_KEY` |
| Codex | OpenAI API key | platform.openai.com | **`auth.json` in the staged `CODEX_HOME`** — not the variable |
| Gemini | Google AI Studio key | aistudio.google.com | `GEMINI_API_KEY` |
| Gemini | **Google subscription session** (advanced) | copy `~/.gemini/oauth_creds.json` | `oauth_creds.json` + `settings.json` in a redirected home |

### Session files share a refresh token

The two "subscription session" rows differ in one way that matters. A Codex
device-auth session is *issued* to this deployment and is nobody else's copy.
A Gemini session file is *copied* from the user's own machine, and both sides
then hold the same rotating refresh token — whichever refreshes first can
invalidate the other, logging the user out of their local CLI.

That is why the Gemini API key is the recommended option and the session file
is presented as advanced, with the tradeoff stated in the connect form itself
rather than buried here. `credentialOrigin` records which case a stored
credential is, so the UI warns only where the cost is real.

**Gemini needs an auth method declared.** Dropping `oauth_creds.json` into a
home is not enough: the CLI refuses to start with "Please set an Auth method",
naming its settings file and the API-key variables. A `settings.json`
declaring `security.auth.selectedType: "oauth-personal"` is what turns that
into a real call. `google_accounts.json` and `projects.json` are *not*
required — verified by staging the credential without them.

**Codex does not authenticate from `OPENAI_API_KEY`.** With only the variable
set, `codex exec` sends no credential at all and the API answers
`401 … Missing bearer or basic authentication in header`; writing
`{"auth_mode":"apikey","OPENAI_API_KEY":"…"}` into the staged home makes the
same key produce a real verdict (`invalid_api_key` for a bad one). The
distinction is worth knowing because the variable-only failure looks like a
rejected key rather than a credential that was never delivered.

**Gemini needs `GEMINI_CLI_TRUST_WORKSPACE=true`.** Redirecting the home
discards the user's trusted-directory list, and the CLI then exits 55 —
refusing to run headless in an untrusted directory — *before* attempting
authentication, which would otherwise surface as a confusing "credential
rejected".

The Claude subscription token is the important row: it spends the user's own
Claude subscription rather than metered API credit, so per-user billing works
the way people expect without anyone buying API credits.

**Codex and Gemini subscription logins have no environment equivalent** — but
that does not make them uncarryable, which was an early and wrong conclusion
here. Both store their session in a *file*, and a file can be staged into an
isolated home exactly like an API key. Codex gets its own session through
device authorization; Gemini's must be copied, with the refresh-token cost
described above. An API key remains the recommended option for Gemini.

## The part that is easy to get wrong

Handing a CLI the right token is only half of it. Each vendor CLI *also* reads
a logged-in session from the host home directory. A process that inherits the
host environment can therefore fall back to the host owner's account —
silently, and looking exactly like success.

So every launch also redirects the CLI's configuration directory to an empty
per-task directory, and strips every credential variable out of the inherited
environment before adding the user's own. Verified against the installed Claude
Code CLI:

| Setup | Result |
| --- | --- |
| Isolated `CLAUDE_CONFIG_DIR` + deliberately invalid token | `401 OAuth access token is invalid` |
| Isolated `CLAUDE_CONFIG_DIR`, no credential at all | `Not logged in · Please run /login` |

Neither quietly answered as the host owner, which is the property the whole
feature depends on. `openCredentialHome` in `@coord/workspace-manager` is what
enforces it, and `user-credentials.test.ts` pins it.

The directory is fresh per launch rather than shared, because all three vendors
refresh tokens in place: a shared directory would accumulate one user's
refreshed credentials where the next user's process could read them. It is
removed when the run ends, whichever way the run ends.

## Storage

`UserCredentialStore` keeps one record per user per vendor, encrypted with
AES-256-GCM, in `<project>/secrets/user-credentials.json`. The secret is never
returned to a browser — the API returns metadata plus a four-character hint —
and disconnecting destroys it rather than merely hiding it.

The key comes from `COORD_CREDENTIAL_KEY` when set, which is what a real
deployment should do: it is the only option that survives moving the project
directory. Without it a key is generated once and kept beside the credential
file, which keeps a single-host deployment working with no setup and is honest
about what it protects — someone who can read the key file can read the
credentials. Encryption at rest here defends against copied backups and stray
file reads, not against an attacker who already owns the project directory.

## Choosing what happens without a credential

`COORD_CREDENTIAL_POLICY` decides what a task does when its submitter has
connected no account:

- **`host-login`** (default) — falls back to the host machine's CLI login, the
  previous behaviour. Right for a single-operator project.
- **`refuse`** — fails the task with an explanation. **A deployment serving
  more than one person should set this**, because the alternative is quietly
  charging the host owner for someone else's work, which is the exact
  confusion this feature exists to remove.

## GitHub rides in the same store

The push action has the same identity problem the vendor CLIs had, and the
owner rejected the deployment-wide answer to it outright: a shared
`GITHUB_TOKEN` is a confused deputy — any user's task could push to any
repository the token reached, and every commit carried the token owner's
identity.

So GitHub is a fourth thing a user can connect, stored per user in the same
encrypted vault (`CredentialService` widens `VendorCliKind` with `github`).
It differs from the vendor rows only in delivery: nothing ever launches a
CLI with it or stages a credential home — the push path reads the stored
secret and sends it as HTTP auth to the remote.

The credential arrives one of two ways, and either way it is verified
against `api.github.com/user` before anything is stored, keeping the
verified login as the connection's label so Settings can say *who* a push
will run as:

- **Sign in with GitHub** — the device flow, the same "enter this code in
  your browser" shape the Codex connection uses. Offered when the
  deployment has a GitHub OAuth App configured: the owner creates one once
  (github.com → Settings → Developer settings → OAuth Apps) with **Enable
  Device Flow** ticked, and sets `COORD_GITHUB_CLIENT_ID` to its client id.
  The device grant needs no client secret and no redirect URL. It carries
  the `repo` scope, which an OAuth App cannot narrow per repository.
- **Paste a personal access token** — always available, and the whole story
  when no OAuth App is configured. Also the right choice for anyone who
  wants a fine-grained token scoped to specific repositories, which the
  sign-in's `repo` grant cannot be.

A push asked of an agent resolves the task's `submittedBy` — the same field
that decides whose account pays for the run — and refuses by name ("you
haven't connected GitHub") when nothing is stored. There is deliberately no
environment fallback on that path.

A GitHub connection is a push credential, not an agent: `listConnectionsFor`
excludes it from the channel roster, so nobody is offered a name that can
never answer an @mention.

## What each path does now

- **Provider chat.** A user's own credential is used whenever one exists, and
  the administrator gate applies only to the shared host login. Connecting a
  credential verifies it against the vendor CLI first — a credential that is
  merely stored looks connected and fails much later, mid-task.
- **Build-mode local dispatch.** `runPendingTasks` resolves each claimed task's
  `submittedBy` to that user's credential and launches the adapter with it. The
  agent's own configured `env` block still wins, since that is deployment
  configuration rather than per-task identity.
- **Remote workers.** Unchanged — each worker machine still uses its own
  logged-in CLI. See [what is still open](#what-is-still-open).

## What is still open

- **Remote workers do not receive the submitter's credential.** A task
  dispatched to a registered worker runs under that worker machine's own login.
  Closing this means shipping a credential to another machine over the worker
  protocol, which is a different security question than storing one locally and
  deserves its own design rather than an extension of this one.
- **Sandboxed runs still mount host credential files.**
  `resolveVendorCredentials` stages files from the host home directory, so a
  Docker-sandboxed vendor CLI would authenticate as the host owner. The
  adapters currently refuse to combine vendor CLIs with the Docker sandbox at
  all (see [vendor CLI sandboxing](vendor-cli-sandboxing.md)), so nothing is
  wrong today — but whoever wires that up must take the per-user credential
  rather than the host's file.
- **No expiry handling.** A subscription token that expires surfaces as a
  failed run with the vendor's own message. The stored record keeps a
  `lastVerifiedAt`, so proactive re-checking is possible but is not implemented.
- **Codex and Gemini subscriptions remain host-only**, for the reason above.
  Only their API keys can be per-user.
