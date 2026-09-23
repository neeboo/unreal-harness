#!/usr/bin/env bash
# Build the dsh plugins into their own directories, ready to pack or publish.
#
# # Why this is not just `tsc`
#
# dsh's package layout is unusual and matching it is required for a plugin to
# load at all:
#
#   lib/index.js                     the ESM entry the manifest points at
#   lib/types/*.js, lib/types/*.d.ts `tsc` output
#   cordis.patch.yml                 names the row dsh inserts
#
# A plain `tsc -p tsconfig.json` writes only `lib/types/`, leaving `main`
# pointing at a file that does not exist. dsh then fails to load the plugin --
# and does so quietly, which is why the Harbor adapter greps the installed
# profile rather than trusting an exit code.
#
# # Why it lived in a scratch directory, and no longer does
#
# These plugins type-check against the *published* `@deepseek-ai/*` packages, not
# the monorepo sources: that is the difference between a plugin that works with
# the harness installed in a container and one that works only with whatever
# commit happens to be checked out. Resolving those packages here needs a source
# of them, and until `@unreal-harness/*` was claimed the output was only ever
# needed for a container run, so it was built into /tmp.
#
# That made the packages unpublishable: `npm pack` shipped two files and no
# `lib/`. This script builds in-tree so `dsh-plugins/*/lib` exists and the
# `files` list in each manifest resolves.
#
# Usage:
#   ./build-plugins.sh [plugin ...]        # default: all three
#
# Environment:
#   DSH_PACKAGES_DIR   directory holding a `@deepseek-ai/*` package set
#                      (default: probe the npx cache, then the local dsh checkout)

set -euo pipefail

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGINS=("$@")
if [ ${#PLUGINS[@]} -eq 0 ]; then
  PLUGINS=(rsi-trace rsi-guided rsi-context)
fi

# ------------------------------------------------------------------ find types
find_packages_dir() {
  if [ -n "${DSH_PACKAGES_DIR:-}" ]; then
    echo "$DSH_PACKAGES_DIR"; return
  fi
  # Any npx cache that has resolved dsh carries the whole @deepseek-ai set.
  local candidate
  candidate="$(ls -d "${HOME}"/.npm/_npx/*/node_modules/@deepseek-ai 2>/dev/null | head -1 || true)"
  if [ -n "$candidate" ] && [ -d "$candidate/dsh-session" ]; then
    echo "$candidate"; return
  fi
  echo ""
}

PACKAGES_DIR="$(find_packages_dir)"
if [ -z "$PACKAGES_DIR" ]; then
  cat >&2 <<'MSG'
No @deepseek-ai package set found.

The plugins type-check against the published harness packages. Either run dsh once
so npx caches them:

  npx -y @deepseek-ai/dsh@0.1.7-alpha.2 --version

or point at an existing set:

  DSH_PACKAGES_DIR=/path/to/node_modules/@deepseek-ai ./build-plugins.sh
MSG
  exit 2
fi
echo "using @deepseek-ai packages from $PACKAGES_DIR"

# tsdown bundles the entry; take it from a dsh checkout or an npx cache.
TSDOWN=""
for candidate in \
  "${HOME}"/dev/deepseek-harness/node_modules/.bin/tsdown \
  "$(dirname "$PACKAGES_DIR")"/../.bin/tsdown \
  "$(dirname "$(dirname "$PACKAGES_DIR")")/.bin/tsdown"
do
  if [ -x "$candidate" ]; then TSDOWN="$candidate"; break; fi
done
if [ -z "$TSDOWN" ]; then
  echo "tsdown not found; install it or run from a dsh checkout" >&2
  exit 2
fi
TSC="$(dirname "$TSDOWN")/../typescript/bin/tsc"
if [ ! -f "$TSC" ]; then
  TSC="$(command -v tsc || true)"
fi
[ -f "$TSC" ] || { echo "tsc not found beside tsdown and not on PATH" >&2; exit 2; }
echo "using tsdown $("$TSDOWN" --version 2>/dev/null || echo '(version unknown)')"
echo "using tsc $TSC"

# ------------------------------------------------------------------- per plugin
for plugin in "${PLUGINS[@]}"; do
  dir="$SELF_DIR/$plugin"
  [ -d "$dir/src" ] || { echo "SKIP $plugin: no src/" >&2; continue; }
  echo "=== $plugin ==="

  # A link farm beside the sources, so `tsc` resolves @deepseek-ai/* and zod from
  # the harness package set rather than from this repo (which has neither).
  staging="$(mktemp -d)"
  mkdir -p "$staging/node_modules/@deepseek-ai"
  cp -R "$dir/src" "$staging/src"
  cp "$dir/package.json" "$staging/package.json"
  [ -f "$dir/cordis.patch.yml" ] && cp "$dir/cordis.patch.yml" "$staging/"
  # Every @deepseek-ai package the plugin may reference, whether declared or not:
  # the plugins are thin and peer-depend on the host for all of them.
  for dep in "$PACKAGES_DIR"/*; do
    [ -d "$dep" ] && ln -sfn "$dep" "$staging/node_modules/@deepseek-ai/$(basename "$dep")"
  done
  # Sibling @unreal-harness packages: rsi-context imports @unreal-harness/judgment,
  # which is built from packages/ in this repo. Without this link it type-checks
  # only where that package happens to be installed.
  mkdir -p "$staging/node_modules/@unreal-harness"
  for sibling in "$SELF_DIR"/../packages/*/; do
    name="$(basename "$sibling")"
    [ -d "$sibling/lib" ] && ln -sfn "$(cd "$sibling" && pwd)" \
      "$staging/node_modules/@unreal-harness/$name"
  done

  # zod is a real dependency, so it must resolve for the type-check.
  zod_dir="$(dirname "$PACKAGES_DIR")/zod"
  [ -d "$zod_dir" ] && ln -sfn "$zod_dir" "$staging/node_modules/zod"
  # tsdown resolves its own config's `import { defineConfig } from 'tsdown'`, so
  # the package must be reachable from the staging directory by name.
  tsdown_pkg=""
  for candidate in \
    "$(dirname "$TSDOWN")/../tsdown" \
    "$(dirname "$TSDOWN")/../node_modules/tsdown" \
    "$(dirname "$(dirname "$TSDOWN")")/tsdown"
  do
    [ -d "$candidate" ] && { tsdown_pkg="$candidate"; break; }
  done
  if [ -n "$tsdown_pkg" ]; then
    ln -sfn "$tsdown_pkg" "$staging/node_modules/tsdown"
  else
    echo "  could not locate the tsdown package next to $TSDOWN" >&2
  fi

  cat > "$staging/tsconfig.json" <<'JSON'
{
  "compilerOptions": {
    "target": "ES2023", "module": "ESNext", "moduleResolution": "bundler",
    "lib": ["ES2023", "DOM"], "strict": true, "skipLibCheck": true,
    "declaration": true, "declarationMap": true, "sourceMap": true,
    "rootDir": "src", "outDir": "lib/types",
    "allowImportingTsExtensions": true, "rewriteRelativeImportExtensions": true
  },
  "include": ["src"]
}
JSON

  cat > "$staging/tsdown.config.ts" <<'TS'
import { defineConfig } from 'tsdown'

// Mirrors the dsh workspace build: consume the tsc-emitted JS and emit the entry
// at lib/index.js. Every host package is marked external EXPLICITLY.
//
// Leaving this to inference is what produced a broken bundle once: rsi-context
// imports a sibling @unreal-harness package, and with that resolvable, the
// bundler followed it into cordis and inlined `class Service` plus cosmokit --
// 71 kB and a second copy of the framework the host already loaded. A dsh plugin
// MUST share the host's cordis instance; a duplicate silently breaks service
// registration, which is exactly the silent-failure shape this repo keeps
// finding. rsi-trace and rsi-guided were unaffected only because their sibling
// links happened to be absent.
export default defineConfig({
  entry: ['lib/types/index.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  // Host packages stay external; a sibling library that this repo publishes
  // itself is bundled, because a peer on an unpublished package would make the
  // plugin uninstallable. The library is pure functions with no host dependency,
  // so inlining it shares no runtime state with the host.
  external: [
    /^@deepseek-ai\//,
    /^zod(\/|$)/,
    /^@unreal-harness\/(?!judgment)/,
  ],
})
TS

  # The invariant companion only compiles inside a dsh checkout, where the
  # `invariants` service exists. It is not part of the published entry, so a
  # failure there must not fail the build.
  if ! ( cd "$staging" && node "$TSC" -p tsconfig.json 2>&1 \
      | grep -v "dsh-invariants\|invariants" || true ); then
    echo "  tsc reported errors for $plugin (continuing; see above)" >&2
  fi
  if ! ( cd "$staging" && "$TSDOWN" >/dev/null 2>&1 ); then
    echo "  tsdown FAILED for $plugin; rerun with the output shown:" >&2
    ( cd "$staging" && "$TSDOWN" 2>&1 | tail -8 ) >&2
    continue
  fi

  rm -rf "$dir/lib"
  cp -R "$staging/lib" "$dir/lib"
  rm -rf "$staging"

  if [ -f "$dir/lib/index.js" ]; then
    echo "  built lib/index.js ($(wc -c < "$dir/lib/index.js" | tr -d ' ') bytes) + $(ls "$dir/lib/types"/*.d.ts 2>/dev/null | wc -l | tr -d ' ') declarations"
  else
    echo "  MISSING lib/index.js after build" >&2
  fi
done

echo
echo "packed size check:"
for plugin in "${PLUGINS[@]}"; do
  [ -d "$SELF_DIR/$plugin/lib" ] || continue
  printf '  %-14s %s\n' "$plugin" "$(cd "$SELF_DIR/$plugin" && npm pack --dry-run 2>&1 | grep -oE 'total files: [0-9]+' || echo '(pack failed)')"
done
