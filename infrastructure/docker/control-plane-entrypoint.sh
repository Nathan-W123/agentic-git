#!/bin/sh
# Initializes the project directory on first boot, then starts the control
# plane. `coord init` is idempotent, but skipping it when the configuration
# already exists keeps restarts quiet and never touches a mounted config.
set -eu

# Where the project lives, in order of how much the answer is known.
#
# An explicit `COORD_PROJECT_ROOT` wins. Otherwise Railway's own
# `RAILWAY_VOLUME_MOUNT_PATH`, which it sets automatically on any service with
# a volume attached: whatever mount path was chosen in the dashboard is then
# the project root, so attaching a volume is the whole job and there is no
# second setting to match against the first. Getting those two out of step
# produces a deployment that looks fine and quietly stores everything on the
# container's writable layer, which is lost on the next deploy — accounts,
# agent sign-ins and imported repositories with it.
#
# `/data` last, which is what the image creates and owns, so a plain
# `docker run` with no volume still works.
: "${COORD_PROJECT_ROOT:=${RAILWAY_VOLUME_MOUNT_PATH:-/data}}"
mkdir -p "$COORD_PROJECT_ROOT"
cd "$COORD_PROJECT_ROOT"

# Codex's scoped-write sandbox needs a platform helper this image does not
# have, and it does not degrade when the helper is missing — it refuses
# filesystem access outright, so a run reports that its "repository access
# request was rejected", inspects nothing, and returns an empty changeset that
# the pipeline then records as a failed task.
#
# The confinement it would provide is already here: this is a container, with
# one task's worktree in it and nothing else worth reaching. Turning Codex's
# own sandbox off inside another sandbox is the case the adapter documents
# `danger-full-access` for, and it is set here — in the image — rather than in
# a project's config, because it is a fact about this host and would be wrong
# on the laptop that shares the repository.
: "${COORD_CODEX_SANDBOX:=danger-full-access}"
export COORD_CODEX_SANDBOX

if [ ! -f "$COORD_PROJECT_ROOT/.coordinator/config.json" ]; then
  node /app/apps/cli/dist/index.js init
fi

exec node /app/apps/web/dist/index.js
