---
description: "Discovery-tree tracing for RSI-style exploration harnesses: the durable `rsi/node` event, a `ctx.sessionProjections` fold, and the `ctx.rsiTrace` reader."
kind: "package-reference"
---

# @deepseek-ai/dsh-rsi-trace

English | [中文](README.zh.md)

## Summary

`dsh-rsi-trace` turns a session's event log into a **discovery tree** — a tree of exploration attempts in which each node is one attempt and each edge is a fork. It adds no storage: it declares the durable `rsi/node` event, registers a `ctx.sessionProjections` unit that folds the log into the tree, and exposes `ctx.rsiTrace` for readers.

Mount it when a session explores rather than merely converses: when attempts branch from earlier attempts, carry a score, and are meant to be replayed or audited later. It is the trace/read half of an exploration harness — a replay engine, a policy runtime, and a workspace-snapshot store are separate concerns that consume it.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin. It provides `ctx.sessionProjections` registration and `ctx.rsiTrace` in one load, so neither can be present without the other.

```yaml
- name: '@deepseek-ai/dsh-rsi-trace'
```

A session records its own node, then reports outcomes as they arrive:

```ts
// The attempt starts.
agent.session.append('rsi/node', {
  nodeId: 'root/b0',
  parent: 'root',
  branch: 0,
  attempt: 0,
  siblingOrder: 0,
  status: 'open',
})

// The evaluator returns. This UPDATES the node; it does not create a second one.
agent.session.append('rsi/node', {
  nodeId: 'root/b0',
  parent: 'root',
  branch: 0,
  attempt: 0,
  siblingOrder: 0,
  status: 'scored',
  score: 0.42,
})
```

Read it back through the service:

| Method | Returns |
|---|---|
| `ctx.rsiTrace.tree(session)` | the whole folded tree, or `undefined` before any state exists |
| `ctx.rsiTrace.nodes(session)` | this session's owned nodes in **creation order** |
| `ctx.rsiTrace.childrenOf(session, parentId)` | one node's children in creation order |
| `ctx.rsiTrace.current(session)` | the node this session currently represents |

`rebuildDiscoveryTree(header, inheritedEventCount, events)` is exported for callers that rebuild from a raw log without a live projection.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

A discovery node is **one attempt**, and its identity is the session that produced it. The tree is therefore not a new store: it is a projection of the session event log, and `rsi/node` is an ordinary durable event.

Two decisions carry the design.

**Lineage comes from session metadata, not from events.** `init(header, inheritedEventCount)` reads `header.parentSession` and `header.isSeeded`, so a fork edge is free — dsh already records it. The fold then skips every event before `inheritedEventCount`, so an inherited prefix never restates itself as the child's own work. A fork child's tree is exactly its own attempts.

**Create-only fields are distinguished from updatable ones.** `seq` (the position of the first record that created the node) and `turns` are create-only; `status` and `score` are updatable. A later record for the same node updates it in place. This matters because replay's youngest-first rule reads creation order: if an update moved `seq`, the tree would silently reorder.

The projection's `stateVersion` must be bumped whenever the serialized fields or the fold semantics change, so persisted rows from an older unit are discarded rather than forward-applied into garbage.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Session](../session/README.md) — the append-only log and its vocabulary.
- [Session projection](../../session/session-projection/README.md) — the fold seam this package registers on.
- [Session persistence](../../session/session-persistence/README.md) — how the log is made durable.

<a id="model-experience"></a>
## Model Experience

None directly. `rsi/node` is **log-only**: it is not a `SurfaceEventType`, so it can never produce a surface node and the model never sees it. The service adds no tools and no prompt sections.

#### KV Cache effect

None. A discovery record appends to the log without touching the model-visible surface, so it neither extends nor invalidates a cached prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The tree is only as complete as the records.** A session that never appends `rsi/node` has a valid but empty tree; this package cannot infer attempts from turns alone, because which turn begins an attempt is a harness decision, not a log fact.
- **No replay, no policy runtime, no workspace snapshot.** Replaying recorded children, executing policy code, and materializing per-node filesystem state are deliberately out of scope. This package answers "what is the tree", not "what would have happened".
- **`siblingOrder` is trusted, not derived.** The youngest-first replay rule depends on it, so a writer that records it carelessly produces a well-formed tree with the wrong traversal order.
- **No tree-wide views.** The reader is session-scoped, matching the projection's own scope. Aggregating a root's full descendant tree across sessions is the corpus reader's job (see `session-query`).
- **Scores are opaque numbers.** No normalization, no comparison across tasks; a consumer that needs a scale owns that decision.
