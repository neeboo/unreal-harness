#!/usr/bin/env bash
# Pre-bake the Node + dsh + pnpm toolchain so trials stop installing it.
#
# # Why this exists
#
# A benchmark trial builds the task's own image and then installs Node, dsh and
# pnpm into it. That download plus `npm install` costs roughly four minutes per
# trial, against a per-task agent budget measured in minutes — so a multi-task,
# multi-arm matrix spends hours of wall clock installing identical bytes. The
# measurement is not wrong, it just cannot finish.
#
# # What it does
#
# 1. Builds one image (`dsh-toolchain:<node version>`) holding Node, dsh and
#    pnpm under `/opt/dsh-toolchain`.
# 2. For each task, prepends a `FROM` stage that COPYs that directory into the
#    task image, so `/opt/dsh-toolchain` exists inside every trial.
#
# The adapter notices `/opt/dsh-toolchain` and copies from it instead of
# downloading (see `Dsh.PREBAKED_TOOLCHAIN`). Nothing about the task's own
# environment, verifier or difficulty changes: the toolchain is the *agent's*
# dependency, not the task's.
#
# # The trap: most Terminal-Bench tasks ship a prebuilt image
#
# A task's `task.toml` may set `[environment] docker_image`, in which case Harbor
# pulls that registry image and **never reads `environment/Dockerfile`** -- so a
# grafted Dockerfile is dead text and the toolchain silently never appears. The
# first attempt at this reported "using pre-baked" in the transcript while still
# downloading Node, because what it was reading was the script's own source.
#
# This script therefore also removes `docker_image` from the task's
# `[environment]` section (backing `task.toml` up first), forcing a local build
# from the grafted Dockerfile. The build cost is ~30s against ~4min of
# per-trial installing, so building locally is the cheaper path once the
# toolchain is in place.
#
# # Reversibility
#
# Every modified Dockerfile is backed up to `Dockerfile.orig` and every task.toml
# to `task.toml.orig` before the first edit, and `--restore` puts them back. The
# script is idempotent: running it twice does not nest stages.
#
# Usage:
#   ./prebake-toolchain.sh                    # build + graft into $TASKS_ROOT
#   ./prebake-toolchain.sh --restore          # put the Dockerfiles back
#   TASKS="a b c" ./prebake-toolchain.sh
#
# Environment:
#   TASKS_ROOT       dataset directory (default /tmp/tb-probe/terminal-bench)
#   TASKS            space-separated task names
#   NODE_VERSION     default 22.23.2
#   DSH_VERSION      default 0.1.7-alpha.2
#   TOOLCHAIN_IMAGE  default dsh-toolchain:<NODE_VERSION>

set -euo pipefail

TASKS_ROOT="${TASKS_ROOT:-/tmp/tb-probe/terminal-bench}"
TASKS="${TASKS:-html-js-filter session-window-debug shadow-relay}"
NODE_VERSION="${NODE_VERSION:-22.23.2}"
DSH_VERSION="${DSH_VERSION:-0.1.7-alpha.2}"
TOOLCHAIN_IMAGE="${TOOLCHAIN_IMAGE:-dsh-toolchain:${NODE_VERSION}}"
TOOLCHAIN_PATH="/opt/dsh-toolchain"
STAGE_MARKER="# >>> dsh-toolchain stage (added by prebake-toolchain.sh) >>>"
STAGE_END="# <<< dsh-toolchain stage <<<"

restore() {
  local restored=0
  for task in $TASKS; do
    local dir="$TASKS_ROOT/$task/environment"
    if [ -f "$dir/Dockerfile.orig" ]; then
      mv -f "$dir/Dockerfile.orig" "$dir/Dockerfile"
      restored=$((restored + 1))
    fi
    if [ -f "$TASKS_ROOT/$task/task.toml.orig" ]; then
      mv -f "$TASKS_ROOT/$task/task.toml.orig" "$TASKS_ROOT/$task/task.toml"
    fi
    echo "restored $task"
  done
  echo "restored $restored task(s)"
}

if [ "${1:-}" = "--restore" ]; then
  restore
  exit 0
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required" >&2
  exit 2
fi

# ---------------------------------------------------------------- build image
echo "building $TOOLCHAIN_IMAGE (node $NODE_VERSION, dsh $DSH_VERSION)"

BUILD_CTX="$(mktemp -d)"
trap 'rm -rf "$BUILD_CTX"' EXIT

cat > "$BUILD_CTX/Dockerfile" <<DOCKERFILE
# The toolchain image. Debian bookworm because every selected task image is
# Debian-based and the glibc floor is what actually has to line up (Node 22 needs
# glibc >= 2.28; bookworm ships 2.36).
FROM python:3.12-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \\
      curl ca-certificates xz-utils \\
 && rm -rf /var/lib/apt/lists/*

ARG NODE_VERSION
ARG DSH_VERSION
ARG TOOLCHAIN_PATH

RUN set -eux; \\
    ARCH="\$(dpkg --print-architecture)"; \\
    case "\$ARCH" in \\
      amd64) NODE_ARCH=x64 ;; \\
      arm64) NODE_ARCH=arm64 ;; \\
      *) echo "unsupported arch: \$ARCH" >&2; exit 2 ;; \\
    esac; \\
    mkdir -p "\$TOOLCHAIN_PATH"; \\
    curl -fsSL "https://nodejs.org/dist/v\${NODE_VERSION}/node-v\${NODE_VERSION}-linux-\${NODE_ARCH}.tar.xz" \\
      -o /tmp/node.tar.xz; \\
    mkdir -p "\$TOOLCHAIN_PATH/node"; \\
    tar -xJf /tmp/node.tar.xz -C "\$TOOLCHAIN_PATH/node" --strip-components=1; \\
    rm /tmp/node.tar.xz; \\
    export PATH="\$TOOLCHAIN_PATH/node/bin:\$PATH"; \\
    npm install --global --prefix "\$TOOLCHAIN_PATH" --no-fund --no-audit \\
      "@deepseek-ai/dsh@\${DSH_VERSION}" pnpm@10; \\
    "\$TOOLCHAIN_PATH/node/bin/node" --version; \\
    "\$TOOLCHAIN_PATH/bin/pnpm" --version; \\
    test -f "\$TOOLCHAIN_PATH/lib/node_modules/@deepseek-ai/dsh/lib/bin.js"
DOCKERFILE

docker build \
  --build-arg "NODE_VERSION=$NODE_VERSION" \
  --build-arg "DSH_VERSION=$DSH_VERSION" \
  --build-arg "TOOLCHAIN_PATH=$TOOLCHAIN_PATH" \
  -t "$TOOLCHAIN_IMAGE" \
  "$BUILD_CTX"

# The adapter runs as whatever user the task declares, and `COPY --from` lands
# files as root. Make the tree world-readable so any agent user can copy from it.
docker build -q -t "${TOOLCHAIN_IMAGE}-shared" - <<DOCKERFILE
FROM $TOOLCHAIN_IMAGE
RUN chmod -R a+rX $TOOLCHAIN_PATH
DOCKERFILE
TOOLCHAIN_IMAGE="${TOOLCHAIN_IMAGE}-shared"
echo "built $TOOLCHAIN_IMAGE"

# ------------------------------------------------------------- graft per task
#
# Force a local build. A prebuilt `docker_image` makes Harbor ignore the
# Dockerfile entirely, which is how the first attempt at this pre-bake appeared
# to work while still downloading Node.
force_local_build() {
  local task_toml="$TASKS_ROOT/$1/task.toml"
  [ -f "$task_toml" ] || return 0
  grep -qE '^[[:space:]]*docker_image[[:space:]]*=' "$task_toml" || return 0
  [ -f "$task_toml.orig" ] || cp -p "$task_toml" "$task_toml.orig"
  python3 - "$task_toml" <<'PYEOF'
import re, sys, pathlib

path = pathlib.Path(sys.argv[1])
lines = path.read_text().splitlines(keepends=True)
out, in_environment = [], False
for line in lines:
    stripped = line.strip()
    if stripped.startswith('['):
        in_environment = stripped == '[environment]'
    if in_environment and re.match(r'^\s*docker_image\s*=', line):
        # Commented rather than deleted so the original pin stays readable.
        out.append('# prebake-toolchain.sh: removed to force a local build. Original:\n')
        out.append('# ' + line)
        continue
    out.append(line)
path.write_text(''.join(out))
PYEOF
  echo "  forced local build for $1 (docker_image commented out)"
}

grafted=0
for task in $TASKS; do
  dir="$TASKS_ROOT/$task/environment"
  if [ ! -f "$dir/Dockerfile" ]; then
    echo "SKIP $task: no $dir/Dockerfile" >&2
    continue
  fi

  force_local_build "$task"

  if grep -qF "$STAGE_MARKER" "$dir/Dockerfile"; then
    echo "already grafted: $task"
    continue
  fi

  [ -f "$dir/Dockerfile.orig" ] || cp -p "$dir/Dockerfile" "$dir/Dockerfile.orig"

  # A multi-stage build: the toolchain stage exists only to be COPYed from, and
  # the task's own recipe follows unchanged. The COPY is appended rather than
  # inserted, and the task's own trailing USER is re-applied after it, so
  # grafting cannot silently change which user the trial runs as -- the adapter
  # installs into "$HOME/.local" and a user change would move $HOME with it.
  {
    echo "$STAGE_MARKER"
    echo "# Only exists to be copied from; adds no software to the task's runtime."
    echo "FROM $TOOLCHAIN_IMAGE AS dsh-toolchain"
    echo "$STAGE_END"
    echo
    cat "$dir/Dockerfile.orig"
    echo
    echo "$STAGE_MARKER"
    echo "USER root"
    echo "COPY --from=dsh-toolchain $TOOLCHAIN_PATH $TOOLCHAIN_PATH"
    original_user="$(grep -iE '^[[:space:]]*USER[[:space:]]+' "$dir/Dockerfile.orig" | tail -1 || true)"
    if [ -n "$original_user" ]; then
      echo "$original_user"
      echo "# (re-applied: the COPY above needed root to write the toolchain path)"
    fi
    echo "$STAGE_END"
  } > "$dir/Dockerfile"

  echo "grafted: $task"
  grafted=$((grafted + 1))
done

echo
echo "grafted $grafted task image(s) under $TASKS_ROOT"
echo "toolchain image: $TOOLCHAIN_IMAGE"
echo
echo "The final COPY switches to root to write a world-readable path. If a task"
echo "needs to run as a non-root user, its own Dockerfile must still end with the"
echo "right USER directive AFTER the graft -- check with:"
echo "  tail -5 $TASKS_ROOT/<task>/environment/Dockerfile"
