# The coordinator control plane: API gateway, web control room, and the
# integration engine, in one container. State lives outside the image — the
# coordination store in Postgres (COORD_DATABASE_URL) and canonical
# repository mirrors on the /data volume.
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json turbo.json tsconfig.base.json ./
# Manifests before source, and only the manifests. `npm ci` reads every
# workspace's package.json and none of its code, so copying the tree first —
# which is what this did — put the whole source under the install layer and
# made every commit reinstall a dependency tree that had not changed. One
# line per workspace because a multi-source COPY flattens its sources into
# the destination directory, losing the paths npm resolves the workspaces by.
COPY adapters/codex/package.json ./adapters/codex/
COPY adapters/generic-cli/package.json ./adapters/generic-cli/
COPY adapters/prompt-cli/package.json ./adapters/prompt-cli/
COPY apps/cli/package.json ./apps/cli/
COPY apps/web/package.json ./apps/web/
COPY apps/worker/package.json ./apps/worker/
COPY packages/agent-protocol/package.json ./packages/agent-protocol/
COPY packages/collab/package.json ./packages/collab/
COPY packages/intent-analysis/package.json ./packages/intent-analysis/
COPY packages/local-triage/package.json ./packages/local-triage/
COPY packages/shared-types/package.json ./packages/shared-types/
COPY services/api-gateway/package.json ./services/api-gateway/
COPY services/code-intelligence/package.json ./services/code-intelligence/
COPY services/coordinator/package.json ./services/coordinator/
COPY services/integration-service/package.json ./services/integration-service/
COPY services/persistence/package.json ./services/persistence/
COPY services/repository-service/package.json ./services/repository-service/
COPY services/workspace-manager/package.json ./services/workspace-manager/
RUN npm ci
COPY apps ./apps
COPY services ./services
COPY packages ./packages
COPY adapters ./adapters
COPY scripts ./scripts
# Concurrency capped deliberately. Turbo defaults to ten parallel tasks, and
# seventeen packages compiling at once peaked at 1061 MB here against 605 MB at
# two — while taking the same wall-clock time (26s vs 25s), because this build
# is bound by the dependency graph rather than by CPU. On a build container
# with a memory ceiling the wide version is the one that dies, and it buys
# nothing to be wide.
RUN npx turbo run build --concurrency=2
# Drop devDependencies (turbo, typescript) from the runtime tree.
RUN npm prune --omit=dev
# The local message filter runs a small ONNX model, and `onnxruntime-node`
# ships every platform it supports plus a CUDA build: 513 MB installed, of
# which 315 MB is a GPU provider this image has no GPU for and 159 MB is
# macOS and Windows. What actually loads here is linux/x64 CPU, at 36 MB.
#
# Deleted rather than avoided, because there is no install-time flag for it:
# the binaries are inside the published package. Deleting the wrong one fails
# visibly rather than silently — the filter reports itself unavailable and
# every message goes to an agent, which is what happened before it existed.
# Found rather than named: the directory under `bin` is the N-API version the
# installed build targets (napi-v3, napi-v6, ...) and it changes with the
# dependency, so a hardcoded path would quietly stop matching and put half a
# gigabyte back. Both Linux architectures are kept — arm64 is 19 MB and
# losing it would break an arm build to save nothing worth saving.
RUN find node_modules/onnxruntime-node/bin -mindepth 2 -maxdepth 2 -type d \
      \( -name darwin -o -name win32 \) -exec rm -rf {} + \
  && find node_modules/onnxruntime-node -type f \
      \( -name 'libonnxruntime_providers_cuda.*' \
      -o -name 'libonnxruntime_providers_tensorrt.*' \) -delete
# The model itself, fetched once here rather than on the first message in a
# channel: a container with no egress to huggingface.co still filters, and
# nobody's first sentence waits on a 22 MB download.
RUN node -e "import('@coord/local-triage').then(async (m) => { \
      if (!(await m.createChatterFilter().available())) { \
        throw new Error('the triage model did not load'); \
      } \
    })"

FROM node:24-bookworm-slim
# git drives repository import, worktrees, bundles, and integration.
#
# Everything after it is here because an agent works in a checkout of somebody
# else's repository, and the image is the only place a runtime can come from.
# The container runs unprivileged (see the entrypoint) so an agent cannot
# apt-get anything at run time, and `--no-install-recommends` means nothing
# arrives by accident — a task asked to run a Python test suite failed for
# want of python3, and would have failed next for want of curl to fetch one.
#
# Deliberately a runtime, not a toolbox: each of these is something a task
# routinely needs and cannot obtain for itself.
#   python3/pip/venv — the commonest test runner after node's own
#   build-essential — pip and npm packages with native extensions build from
#     source whenever no wheel matches; without it they fail deep in a
#     compiler error that reads like a bug in the repository
#   curl/wget        — fetching fixtures, probing services, installers
#   openssh-client   — git remotes over SSH
#   jq               — the one thing every shell script assumes
#   unzip            — archives, downloaded toolchains
#   ripgrep          — what agents actually reach for to read a repository
#   procps, less     — `ps` and git's pager; tools shell out to both
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
      git ca-certificates \
      python3 python3-pip python3-venv \
      build-essential \
      curl wget \
      openssh-client \
      jq unzip ripgrep procps less \
  && rm -rf /var/lib/apt/lists/*
# Signing in to an agent from the browser is not an HTTP call this server can
# make: it runs the vendor's own CLI (`claude auth login`, `codex login
# --device-auth`) against an isolated home and reads the device code back out.
# `resolveClaudeCommand` and `resolveCodexCommand` both fall through to a bare
# PATH lookup off Windows, so without these installed the connect screen can
# only offer a pasted token and reports "No usable ... CLI was found on this
# host" — which is per-user sign-in working on a laptop but not on a deploy.
# --allow-scripts is not optional here. Claude Code ships a stub bin and pulls
# the real per-platform executable in its postinstall; npm 11 blocks install
# scripts by default, so without this the package installs "successfully" and
# leaves nothing runnable behind — `claude auth status` then fails and the host
# reports no usable CLI. Codex needs no such grant: its bin is plain JS, which
# is why it worked while Claude did not.
# Pinned, because this step is the only one in the image that can fail
# without anything in this repository changing. Unpinned, every build
# resolved whatever `latest` was at that moment and ran each package's
# postinstall — which downloads a per-platform binary over the network —
# then asserted both CLIs run. A release published an hour ago could
# therefore break a deploy of a commit that built yesterday, after all the
# code had already compiled, which reads as "failed to build image" with
# nothing in the diff to explain it.
#
# Bump these deliberately: change the version, redeploy, and the failure (if
# any) belongs to that bump rather than to whoever happened to deploy next.
ARG CLAUDE_CODE_VERSION=2.1.235
ARG CODEX_VERSION=0.147.0
ARG GEMINI_CLI_VERSION=latest
ARG COPILOT_CLI_VERSION=latest
RUN npm install -g --allow-scripts=@anthropic-ai/claude-code \
      @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
      @openai/codex@${CODEX_VERSION} \
      @google/gemini-cli@${GEMINI_CLI_VERSION} \
      @github/copilot@${COPILOT_CLI_VERSION} \
  && npm cache clean --force \
  && claude --version \
  && codex --version \
  && gemini --version \
  && copilot --version
# Cursor and Kiro publish their CLIs through vendor installers rather than the
# npm registry. Install into the image once, then expose only the resulting
# executables to the unprivileged runtime user. Their sign-in state is never
# stored in this layer; the web flow always redirects HOME to a per-user
# temporary directory and encrypts the captured session afterwards.
RUN curl -fsSL https://cursor.com/install | bash \
  && curl -fsSL https://cli.kiro.dev/install | bash \
  && install -m 0755 /root/.local/bin/agent /usr/local/bin/agent \
  && install -m 0755 /root/.local/bin/kiro-cli /usr/local/bin/kiro-cli \
  && agent --version \
  && kiro-cli --version
# COORD_PORT is deliberately not set here. A platform that assigns a port
# passes it as PORT, and pinning COORD_PORT in the image would outrank it —
# leaving the container listening where the router is not looking. Unset, the
# entrypoint falls through to PORT, and to 4317 when nothing assigns one.
# `HOME` is set explicitly because the entrypoint now starts as root and drops
# to `node` itself. `USER node` used to imply /home/node; without it the
# process would inherit root's home, and the vendor CLIs — which stage their
# sign-in state under $HOME — would be writing somewhere `node` cannot.
# `PIP_BREAK_SYSTEM_PACKAGES` and the PATH entry are what make python3 above
# actually usable, rather than present.
#
# Debian marks its system Python externally-managed (PEP 668), so a plain
# `pip install` refuses with an error about the environment rather than the
# package — accurate on a machine somebody owns, and wrong here, where the
# container is rebuilt from this file every deploy and there is no system
# Python to protect. Without it the first thing any Python task does fails.
#
# And the process is unprivileged, so pip installs into `$HOME/.local`. Its
# console scripts — pytest, ruff, whatever the repository uses — land in
# `~/.local/bin`, which is not on the default PATH: `pip install pytest`
# would succeed and `pytest` would then report command not found.
ENV NODE_ENV=production \
    COORD_PROJECT_ROOT=/data \
    COORD_HOST=0.0.0.0 \
    HOME=/home/node \
    PIP_BREAK_SYSTEM_PACKAGES=1
# Prepended rather than rewritten. Spelling the whole PATH out here would drop
# the sbin directories the base image sets, and the entrypoint looks for
# `setpriv` on PATH to drop privilege — losing it does not fail the boot, it
# falls through to "continuing as root", which is the one outcome this
# deployment must not reach silently.
ENV PATH=/home/node/.local/bin:$PATH
# The GitHub OAuth App this deployment signs users in through ("Sign in with
# GitHub" on the connect screen — the device flow). A device-flow client id is
# a public identifier, not a secret: it travels in every request the flow
# makes and names the app on GitHub's own approval screen, which is why the
# gh CLI ships its own in open source. The secret half of an OAuth App is
# never used by the device grant, so nothing here unlocks anything. A
# platform-level variable outranks this default, and a fork should register
# its own OAuth App (with Enable Device Flow ticked) and replace the id —
# compose deployments already mask it with whatever their .env says.
ENV COORD_GITHUB_CLIENT_ID=Ov23liGI2B1T62b0ifdC
WORKDIR /app
COPY --from=build /app /app
COPY infrastructure/docker/control-plane-entrypoint.sh /usr/local/bin/coord-control-plane
RUN chmod +x /usr/local/bin/coord-control-plane \
  && mkdir -p /data \
  && chown node:node /data
# No `USER node` here, and the entrypoint is why.
#
# A mounted volume replaces the directory created above with a fresh
# filesystem owned by root, so a container that has already dropped privilege
# cannot take ownership of it and dies on its first write. The entrypoint
# starts as root for exactly long enough to hand the project root to `node`,
# then runs the server as `node` through setpriv — so the process that serves
# traffic is still unprivileged, and attaching a volume no longer breaks it.
# No VOLUME instruction. It would declare the intent well enough for plain
# Docker, but Railway rejects a Dockerfile containing one outright — the build
# fails before it starts — and expects the mount to be attached to the service
# instead. /data is still created and owned above, so a mount lands on a
# directory that already exists; without one, canonical repositories live on
# the container's own writable layer and do not survive a redeploy.
EXPOSE 4317
ENTRYPOINT ["coord-control-plane"]
