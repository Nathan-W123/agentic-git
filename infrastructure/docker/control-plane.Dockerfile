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
# COORD_PORT is deliberately not set here. A platform that assigns a port
# passes it as PORT, and pinning COORD_PORT in the image would outrank it —
# leaving the container listening where the router is not looking. Unset, the
# entrypoint falls through to PORT, and to 4317 when nothing assigns one.
ENV NODE_ENV=production \
    COORD_PROJECT_ROOT=/data \
    COORD_HOST=0.0.0.0
WORKDIR /app
COPY --from=build /app /app
COPY infrastructure/docker/control-plane-entrypoint.sh /usr/local/bin/coord-control-plane
RUN chmod +x /usr/local/bin/coord-control-plane \
  && mkdir -p /data \
  && chown node:node /data
USER node
# No VOLUME instruction. It would declare the intent well enough for plain
# Docker, but Railway rejects a Dockerfile containing one outright — the build
# fails before it starts — and expects the mount to be attached to the service
# instead. /data is still created and owned above, so a mount lands on a
# directory that already exists; without one, canonical repositories live on
# the container's own writable layer and do not survive a redeploy.
EXPOSE 4317
ENTRYPOINT ["coord-control-plane"]
