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
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
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
ENV NODE_ENV=production \
    COORD_PROJECT_ROOT=/data \
    COORD_HOST=0.0.0.0 \
    HOME=/home/node
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
