# The coordinator control plane: API gateway, web control room, and the
# integration engine, in one container. State lives outside the image — the
# coordination store in Postgres (COORD_DATABASE_URL) and canonical
# repository mirrors on the /data volume.
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json turbo.json tsconfig.base.json ./
COPY apps ./apps
COPY services ./services
COPY packages ./packages
COPY adapters ./adapters
COPY scripts ./scripts
RUN npm ci
RUN npx turbo run build
# Drop devDependencies (turbo, typescript) from the runtime tree.
RUN npm prune --omit=dev

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
RUN npm install -g --allow-scripts=@anthropic-ai/claude-code \
      @anthropic-ai/claude-code @openai/codex \
  && npm cache clean --force \
  && claude --version \
  && codex --version
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
