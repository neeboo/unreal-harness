# Building the RSI plugin for a container run

`rsi-trace` is a dsh plugin, and dsh loads plugins as normal npm packages. The
package is **not on the public npm registry**, so a benchmark container cannot
`pnpm add` it by name. The supported path is to pack it locally and hand the
tarball to the agent adapter, which uploads it and installs it into the profile:

```sh
uv run --project benchmarks/harbor --locked harbor trial start \
  -p /path/to/task \
  --agent harness_harbor.dsh_agent:DshRsi \
  -m deepseek/deepseek-flash \
  --agent-kwarg rsi_plugin=/path/to/deepseek-ai-dsh-rsi-trace-0.1.0.tgz
```

## Why the plugin is not just `tsc`

dsh's own package layout is unusual, and matching it is required for the plugin
to load:

| File | Produced by |
|---|---|
| `lib/index.js` | the bundler (`tsdown`), one ESM entry |
| `lib/types/*.js`, `lib/types/*.d.ts` | `tsc` |
| `cordis.patch.yml` | hand-written; names the row dsh inserts |

A plain `tsc -p tsconfig.json` writes **only** `lib/types/`. A manifest whose
`main` is `lib/index.js` then points at a file that does not exist, and dsh
fails to load the plugin — the same silent-failure shape as everything else in
this area, which is why the adapter greps the profile's `package.json` after
installing rather than trusting an exit code.

## Build recipe

Type-check against the **published** `@deepseek-ai/*` packages rather than the
monorepo sources. That is the difference between a plugin that works against the
harness installed in the container and one that works only against whatever
commit happened to be checked out on the build machine.

```sh
D=$(ls -d ~/.npm/_npx/*/node_modules/@deepseek-ai | head -1)   # any npx cache with dsh

STAGE=$(mktemp -d)
mkdir -p "$STAGE/node_modules/@deepseek-ai"
cp -R dsh-plugins/rsi-trace/src "$STAGE/src"
cp dsh-plugins/rsi-trace/package.json dsh-plugins/rsi-trace/cordis.patch.yml "$STAGE/"
for p in dsh-session dsh-session-projection cordis; do
  ln -sfn "$D/$p" "$STAGE/node_modules/@deepseek-ai/$p"
done
cd "$STAGE" && npm install --no-save --no-fund --no-audit zod@^4

cat > tsconfig.json <<'JSON'
{
  "compilerOptions": {
    "target": "ES2023", "module": "ESNext", "moduleResolution": "bundler",
    "lib": ["ES2023"], "strict": true, "skipLibCheck": true,
    "declaration": true, "sourceMap": true,
    "rootDir": "src", "outDir": "lib/types",
    "allowImportingTsExtensions": true, "rewriteRelativeImportExtensions": true
  },
  "include": ["src"]
}
JSON

# `tsc` for the types and the intermediate JS.
npm install --no-save typescript@5.7
./node_modules/.bin/tsc -p tsconfig.json

# `tsdown` for the entry the manifest actually points at.
cat > tsdown.config.ts <<'TS'
import { defineConfig } from 'tsdown'
export default defineConfig({
  entry: ['lib/types/index.js'], outDir: 'lib', format: ['esm'],
  platform: 'node', target: 'es2024', fixedExtension: false, dts: false, clean: false,
})
TS
npx --yes tsdown@0.22.2

npm pack --pack-destination /tmp
```

Two details that will otherwise cost an afternoon:

* **`npm install` deletes hand-made symlinks under `node_modules`.** Install the
  real dependencies first, then create the `@deepseek-ai/*` links, or use `pnpm`.
* **The row name in `cordis.patch.yml` must equal the package name.** The patch
  inserts a row whose `name` dsh resolves as a module; a mismatch produces a
  plugin that installs cleanly and is never loaded.

## What the container needs

`dsh plugin add` shells out to **pnpm**, and pnpm is not part of Node. Without it
the command exits 127 and dsh writes the reason to
`$DSH_HOME/profiles/<name>/.plugin-manager/logs/<op>/pnpm.log` rather than to
stderr. The adapter installs `pnpm@10` into the same `npm_config_prefix` as dsh
and checks `command -v pnpm` before attempting the add.

## Verifying a build

The tarball should contain exactly the entry, the types, and the patch:

```sh
tar -tzf /tmp/deepseek-ai-dsh-rsi-trace-0.1.0.tgz
# package/lib/index.js
# package/lib/types/*.js
# package/lib/types/*.d.ts
# package/cordis.patch.yml
# package/package.json
```

and the entry should import only what the host already provides:

```sh
grep -oE 'from "[^"]+"' package/lib/index.js | sort -u
# from "@deepseek-ai/cordis"
# from "@deepseek-ai/dsh-session"
# from "zod"
```

If `@deepseek-ai/*` appears bundled rather than external, the plugin will load
against a *copy* of cordis and its services will never connect to the host's.
