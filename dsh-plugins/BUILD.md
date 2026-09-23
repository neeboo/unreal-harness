# Building the RSI plugin for a container run

`rsi-trace` is a dsh plugin, and dsh loads plugins as normal npm packages. Both
paths work:

* **by name**, once the packages are published to the `@unreal-harness` scope;
* **by tarball**, built with `./build-plugins.sh` and handed to the agent adapter,
  which uploads it and installs it into the profile.

The tarball path is what the benchmark uses, because it pins the exact build under
test rather than whatever is currently on the registry:

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

## Publishing

The `@unreal-harness` scope is claimed, and all three plugins build ready to
publish. Publishing needs an npm auth that can bypass the account's publish
policy — a **legacy token cannot**, and the failure is a 403 that names the
requirement:

```
403 Forbidden - PUT .../@unreal-harness%2frsi-trace -
Two-factor authentication or granular access token with bypass 2fa enabled
is required to publish packages.
```

Fix it once, then publish:

```sh
# 1. Create a GRANULAR access token: npmjs.com > Access Tokens > Generate New Token
#    > Granular Access Token. Enable "Bypass 2FA". Give it read+write on the
#    @unreal-harness scope. A legacy token will NOT work.
# 2. Point npm at it.
npm config set //registry.npmjs.org/:_authToken=<token>
npm whoami                       # must print your username

# 3. Build from source, then publish all three.
cd dsh-plugins && ./build-plugins.sh
for p in rsi-trace rsi-guided rsi-context; do
  ( cd "$p" && npm publish --access public )
done
```

Verify afterwards:

```sh
npm view @unreal-harness/rsi-guided version
```

### What each published package needs, and why

| Package | peerDependencies | bundled |
|---|---|---|
| `rsi-trace` | `@deepseek-ai/cordis`, `-dsh-session`, `-dsh-session-projection` | `zod` |
| `rsi-guided` | the above plus `-dsh-system-prompt` | `zod` |
| `rsi-context` | `@deepseek-ai/cordis`, `-dsh-session`, `-dsh-compaction` | `@unreal-harness/judgment` |

Two decisions in that table are deliberate and were both forced by measurement:

- **The host packages stay peers.** A dsh plugin must share the host's cordis
  instance. An earlier build of `rsi-context` inlined cordis and cosmokit — 71 kB,
  with a duplicate `class Service` — because a sibling `@unreal-harness` import
  made the bundler follow the graph into the framework. The build now pins
  `external` explicitly rather than relying on inference.
- **`@unreal-harness/judgment` is bundled, not a peer.** Declaring it as a peer
  would make `rsi-context` uninstallable while `judgment` is unpublished, and a
  `workspace:*` specifier cannot survive `npm publish` anyway. It is pure
  functions with no host dependency, so inlining it shares no runtime state.

### A config-free mount must work

`rsi-context` previously required `config.provider`, so mounting it with no config
threw `Cannot read properties of undefined (reading 'provider')` during
construction and contributed nothing — mounted, loaded, and inert, which is the
failure mode this whole directory keeps rediscovering. Its provider now defaults to
the zero-cost heuristic one and its prices to the off-peak rate card.

### The trap that already caught this once

`npm publish --access public` **succeeded** for all three packages, and they are
still not installable. That is the whole failure mode in one line:

| check | result | meaning |
|---|---|---|
| `npm publish --access public` | `+ @unreal-harness/rsi-guided@0.1.0` | upload succeeded |
| tarball URL, no credentials | `200`, 14 012 bytes, contents correct | the artifact is served |
| packument `registry.npmjs.org/@unreal-harness%2Frsi-guided` | `404` | not discoverable |
| `npm install` in a clean directory | `404 … or you do not have permission` | not installable |

They were published **restricted**, which is npm's default for a scoped package,
and the publishing token was not permitted to change that:

```
403 Forbidden - POST /-/package/@unreal-harness%2frsi-guided/access
```

Its grant was read-write on the packages themselves, not on the org, so it could
publish but not set visibility. A `publishConfig.access: public` in the manifest
does not rescue it either: that field drives the *publish* call, and the call is
being refused for visibility, not for content.

Either fix works:

* **Web:** npmjs.com → the package → Settings → set visibility to Public. Three
  packages, once each.
* **Token:** publish with a token that has org-level read-write, which is allowed
  to change visibility; `--access public` then takes effect by itself.

Verify from a directory with **no `.npmrc`**, because the publishing token can see
its own restricted packages and reports success either way:

```sh
cd "$(mktemp -d)" && npm init -y >/dev/null
npm install @unreal-harness/rsi-guided@0.1.0 \
  --registry=https://registry.npmjs.org/ --no-audit --no-fund
```
