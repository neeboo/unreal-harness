# dsh plugins

These packages are built **inside a dsh checkout**, not here.

They declare `@deepseek-ai/dsh-*` dependencies with `workspace:*`, which only
resolve in the DeepSeek Harness monorepo. Keeping them out of `packages/` is
deliberate: `packages/` is the pnpm workspace that builds standalone, and a member
whose dependencies cannot resolve would break `pnpm install` for everything else.

## Why the split

| Directory | Builds with | Depends on |
|---|---|---|
| `crates/` | `cargo` | nothing but serde |
| `packages/` | `pnpm install && pnpm test` | nothing outside npm |
| `dsh-plugins/` | a dsh checkout | `@deepseek-ai/dsh-*` at `workspace:*` |

The standalone packages hold the decisions and the algorithms — scoring, pricing,
replay, dreaming, workspace snapshots — and they are the ones with fast tests that
run anywhere. The dsh plugins hold the adapters that touch a live session, and
they are thin on purpose: `rsi-context` advises and delegates rather than
reimplementing compaction, and `rsi-trace` is the projection and replay engine.

## Running their tests

```sh
git clone https://github.com/deepseek-ai/deepseek-harness
cd deepseek-harness
pnpm install
cp -R /path/to/unreal-harness/dsh-plugins/rsi-trace   packages/rsi/rsi-trace
cp -R /path/to/unreal-harness/dsh-plugins/rsi-context packages/rsi/rsi-context
# add the tsconfig paths entries and host project references, then:
pnpm exec vitest run packages/rsi/rsi-trace packages/rsi/rsi-context
```

`PHASE0-VERIFICATION.md` documents the exact wiring, including the four
declaration-merge and project-reference details a first-time port gets wrong.

`rsi-context` additionally imports `@neeboo/unreal-harness-judgment`, which is not
published, so a test run there also needs `packages/judgment/lib` copied to
`node_modules/@neeboo/unreal-harness-judgment/`.
