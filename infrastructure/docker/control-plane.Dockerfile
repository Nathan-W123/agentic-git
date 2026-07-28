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
ENV NODE_ENV=production \
    COORD_PROJECT_ROOT=/data \
    COORD_HOST=0.0.0.0 \
    COORD_PORT=4317
WORKDIR /app
COPY --from=build /app /app
COPY infrastructure/docker/control-plane-entrypoint.sh /usr/local/bin/coord-control-plane
RUN chmod +x /usr/local/bin/coord-control-plane \
  && mkdir -p /data \
  && chown node:node /data
USER node
VOLUME /data
EXPOSE 4317
ENTRYPOINT ["coord-control-plane"]
