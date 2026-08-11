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

# A mounted volume arrives owned by root, and this server runs as `node`.
#
# The image creates `/data` and gives it to `node` at build time, which is
# enough while the directory is part of the image. Attaching a volume replaces
# it: the mount is a fresh filesystem owned by root:root, the build-time
# ownership is no longer in the picture, and the first write — `coord init`
# creating `.coordinator/` — fails with EACCES. `set -e` then ends the
# process, the platform restarts it, and it fails the same way. Attaching the
# volume is what breaks the container, which is the opposite of the intent.
#
# So the entrypoint starts as root, hands the project root to `node`, and
# drops privilege for everything after. The chown is guarded on the ownership
# actually being wrong: it is one recursive pass the first time a volume is
# attached, and a stat on every boot after that, rather than a walk of every
# canonical repository on every restart.
RUN_AS=""
if [ "$(id -u)" = "0" ]; then
  node_uid="$(id -u node)"
  node_gid="$(id -g node)"
  if [ "$(stat -c %u "$COORD_PROJECT_ROOT")" != "$node_uid" ]; then
    chown -R "$node_uid:$node_gid" "$COORD_PROJECT_ROOT"
  fi
  if command -v setpriv >/dev/null 2>&1; then
    RUN_AS="setpriv --reuid=$node_uid --regid=$node_gid --init-groups"
  else
    # Rather than fail to start. Running as root is worse than running as
    # `node`, and both are better than a container that cannot boot — the
    # vendor CLIs inside already run with their own sandbox disabled, so the
    # boundary this gives up is thinner than it looks.
    echo "coord: setpriv unavailable; continuing as root" >&2
  fi
fi

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
  # Unprivileged, so the files it creates belong to the user that will be
  # reading and rewriting them for the life of the volume.
  $RUN_AS node /app/apps/cli/dist/index.js init
fi

exec $RUN_AS node /app/apps/web/dist/index.js
