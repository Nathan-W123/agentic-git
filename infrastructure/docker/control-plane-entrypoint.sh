#!/bin/sh
# Initializes the project directory on first boot, then starts the control
# plane. `coord init` is idempotent, but skipping it when the configuration
# already exists keeps restarts quiet and never touches a mounted config.
set -eu

: "${COORD_PROJECT_ROOT:=/data}"
cd "$COORD_PROJECT_ROOT"

if [ ! -f "$COORD_PROJECT_ROOT/.coordinator/config.json" ]; then
  node /app/apps/cli/dist/index.js init
fi

exec node /app/apps/web/dist/index.js
