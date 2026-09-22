/**
 * # @neeboo/unreal-harness-workspace
 *
 * Give each discovery node a filesystem state of its own, so an attempt is
 * *resumable* rather than merely *describable*.
 *
 * Everything else about an attempt is already durable: its history is the session
 * log, its outcome is a recorded score. The filesystem was the gap, and without
 * it replay could reason about how effort was allocated but never re-run a node.
 *
 * Forks are hard-linked, so storage grows with what an attempt *changes* rather
 * than with how many attempts exist. The cost of that choice is aliasing, and
 * {@link WorkspaceManager.beforeWrite} is the explicit boundary that pays it: a
 * caller breaks the link before mutating, and copy-on-write costs only what is
 * actually written.
 *
 * The boundary is a call rather than a filesystem watcher on purpose. A watcher
 * misses writes between the event and the handler, and a sandbox hook only covers
 * confined executions — a full-access mode bypasses confinement entirely. A
 * contract a tool author can meet and a test can check beats a mechanism that
 * looks automatic and is occasionally wrong.
 * @module
 */

export { WorkspaceError, WorkspaceManager } from './snapshot.ts'
export type {
  UnlinkResult,
  WorkspaceManagerOptions,
  WorkspaceNode,
} from './snapshot.ts'
