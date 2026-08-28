# Reference sandbox image for coordinator agents.
#
# Build from the repository root:
#   docker build -f infrastructure/docker/agent.Dockerfile -t coord/reference-agent:1 .
#
# The coordinator runs this image with --network none, a read-only root
# filesystem, dropped capabilities, and only the task worktree bind-mounted, so
# the image must not need network access or writable system paths at runtime.
# Pinned for the reason given in control-plane.Dockerfile: an unpinned base
# lets the toolchain move under a build of unchanged code.
FROM node:22.22.2-alpine

# A non-root default matters on Linux, where the container uid must be able to
# write the bind-mounted worktree. Override with COORD_AGENT_USER when the host
# uid differs; Docker Desktop on macOS and Windows remaps ownership for you.
RUN addgroup -S agent && adduser -S -G agent agent

COPY infrastructure/docker/reference-agent.mjs /opt/agent/reference-agent.mjs
RUN chmod 0555 /opt/agent/reference-agent.mjs

USER agent

# The coordinator supplies the real command through --entrypoint, so this is
# only what you get when running the image directly.
ENTRYPOINT ["node", "/opt/agent/reference-agent.mjs"]
