/**
 * Workspace snapshots: give each discovery node a filesystem state of its own.
 *
 * A discovery attempt is "resume the parent's saved workspace and try
 * something". Everything else in an attempt is already durable — its history is
 * the session log, its outcome is a recorded score — but the filesystem is not.
 * Without a snapshot a node is only *describable*, not *resumable*, and replay
 * can reason about how effort was allocated but never actually re-run a node.
 *
 * This module is the missing half.
 *
 * # Why hard links rather than copies
 *
 * Nodes form a tree, and a child's workspace differs from its parent's by the few
 * files the attempt touched. Copying the whole tree per node makes storage grow
 * with (nodes × workspace), which for a deep search is unusable. Hard-linking the
 * parent's tree costs one directory walk and no file data: storage grows with
 * *changes*, not with nodes.
 *
 * The catch is that a hard link is shared, so writing through one would silently
 * write into the parent's snapshot and every sibling's. {@link WorkspaceManager.beforeWrite}
 * is the boundary that fixes this: a caller breaks the link before modifying, and
 * the copy-on-write only ever pays for what is actually written.
 *
 * # Why an explicit boundary rather than a filesystem watcher
 *
 * A watcher misses writes that happen between the event and the handler, and a
 * sandbox hook only covers confined executions — dsh's `danger-full-access` mode
 * bypasses confinement entirely. An explicit call before a mutation is a contract
 * a tool author can meet and a test can check, which is worth more than a
 * mechanism that appears automatic and is occasionally wrong.
 * @module
 */

import { copyFile, lstat, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { link, readlink, symlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

/** Why a workspace operation was refused. */
export class WorkspaceError extends Error {
  override readonly name = 'WorkspaceError'

  constructor(
    readonly code:
      | 'unknown-node'
      | 'duplicate-node'
      | 'root-conflict'
      | 'outside-root'
      | 'not-a-directory',
    message: string,
  ) {
    super(message)
  }
}

/** One node's filesystem state. */
export interface WorkspaceNode {
  readonly nodeId: string
  /** Parent node id, absent for the root. */
  readonly parent?: string
  /** Absolute path to this node's workspace directory. */
  readonly path: string
  /** Whether the directory was populated from a parent by hard links. */
  readonly linked: boolean
}

/** What a copy-on-write did, so a caller can report or test it. */
export interface UnlinkResult {
  /** Whether the file was shared and is now private. */
  readonly copied: boolean
  /** Bytes copied, `0` when nothing was shared. */
  readonly bytes: number
}

/** How the manager is configured. */
export interface WorkspaceManagerOptions {
  /**
   * Directory under which every node's workspace lives.
   *
   * Created if absent. Every derived path is asserted to stay inside it, so a
   * node id can never address outside the tree.
   */
  readonly root: string
}

/**
 * Copy a tree, either duplicating file data or hard-linking it.
 *
 * Errors are raised rather than skipped: a half-linked workspace would look
 * complete while a shared file silently aliases the parent's, which is worse
 * than a failed fork.
 * @param source - directory to read from.
 * @param destination - directory to create.
 * @param mode - `copy` duplicates data; `link` shares inodes.
 */
async function copyTree(
  source: string,
  destination: string,
  mode: 'copy' | 'link',
): Promise<void> {
  const info = await lstat(source)
  if (info.isSymbolicLink()) {
    // Symlink targets are recreated as symlinks: dereferencing one could pull a
    // file in from outside the workspace, including from outside the node tree.
    const target = await readLinkTarget(source)
    await mkdir(dirname(destination), { recursive: true })
    await symlink(target, destination)
    return
  }
  if (!info.isDirectory()) {
    await mkdir(dirname(destination), { recursive: true })
    if (mode === 'link') await link(source, destination)
    else await copyFile(source, destination)
    return
  }

  await mkdir(destination, { recursive: true })
  const entries = await readdir(source, { withFileTypes: true })
  for (const entry of entries) {
    await copyTree(join(source, entry.name), join(destination, entry.name), mode)
  }
}

/** Read a symlink's raw target without following it. */
function readLinkTarget(path: string): Promise<string> {
  return readlink(path)
}

/**
 * Per-node workspace directories, hard-linked from parent to child.
 */
export class WorkspaceManager {
  private readonly root: string
  private readonly nodes = new Map<string, WorkspaceNode>()

  constructor(options: WorkspaceManagerOptions) {
    this.root = resolve(options.root)
  }

  /** The directory every node's workspace lives under. */
  get rootPath(): string {
    return this.root
  }

  /**
   * Create the tree's root workspace.
   *
   * @param sourcePath - an existing directory to adopt as the initial state.
   * @returns the created root node.
   * @throws {WorkspaceError} when a root already exists or the source is not a
   * directory. Creating a second root would leave the first unreachable from any
   * tree, which is indistinguishable from data loss.
   */
  async createRoot(sourcePath: string): Promise<WorkspaceNode> {
    if (this.nodes.has('root')) {
      throw new WorkspaceError('root-conflict', 'a root workspace already exists')
    }
    const source = resolve(sourcePath)
    const info = await stat(source).catch(() => undefined)
    if (info === undefined || !info.isDirectory()) {
      throw new WorkspaceError('not-a-directory', `root source is not a directory: ${source}`)
    }

    await mkdir(this.root, { recursive: true })
    const path = this.pathFor('root')
    await rm(path, { recursive: true, force: true })
    // The root is a real COPY, not a link tree: the manager must never mutate the
    // tree it adopted, which is what linking would risk.
    await copyTree(source, path, 'copy')
    const node: WorkspaceNode = { nodeId: 'root', path, linked: false }
    this.nodes.set('root', node)
    return node
  }

  /**
   * Fork a node's workspace from its parent by hard-linking the parent's tree.
   *
   * @param nodeId - the new node's id.
   * @param parentId - the node to inherit from.
   * @returns the created node.
   * @throws {WorkspaceError} when the parent is unknown or the id is taken.
   */
  async fork(nodeId: string, parentId: string): Promise<WorkspaceNode> {
    if (this.nodes.has(nodeId)) {
      throw new WorkspaceError('duplicate-node', `node "${nodeId}" already has a workspace`)
    }
    const parent = this.nodes.get(parentId)
    if (parent === undefined) {
      throw new WorkspaceError('unknown-node', `unknown parent node "${parentId}"`)
    }

    const path = this.pathFor(nodeId)
    // A destination INSIDE its own source makes the tree walk consume what it is
    // creating: it descends into the directory it just made, forever. This is
    // reachable whenever a hierarchical id nests under an existing node, so it is
    // checked rather than assumed unreachable.
    if (path === parent.path || path.startsWith(`${parent.path}/`)) {
      throw new WorkspaceError(
        'outside-root',
        `node "${nodeId}" would nest inside its parent's workspace "${parentId}", ` +
        'which makes the fork copy its own output',
      )
    }
    await rm(path, { recursive: true, force: true })
    await mkdir(dirname(path), { recursive: true })
    // Hard links, built explicitly rather than delegated: `cp`'s link behaviour is
    // platform- and version-dependent, and a forked workspace that silently became
    // a full copy would be a storage bug with no error to notice.
    await copyTree(parent.path, path, 'link')
    const node: WorkspaceNode = { nodeId, parent: parentId, path, linked: true }
    this.nodes.set(nodeId, node)
    return node
  }

  /**
   * Look up a node.
   * @param nodeId - the node to find.
   * @returns the node, or `undefined` when it has no workspace.
   */
  get(nodeId: string): WorkspaceNode | undefined {
    return this.nodes.get(nodeId)
  }

  /** Every node, in creation order. */
  all(): readonly WorkspaceNode[] {
    return [...this.nodes.values()]
  }

  /** How many nodes have a workspace. */
  get size(): number {
    return this.nodes.size
  }

  /** The directory for a node, or `undefined` when it has none. */
  pathOf(nodeId: string): string | undefined {
    return this.nodes.get(nodeId)?.path
  }

  /**
   * Make a file private before a caller writes to it.
   *
   * The copy-on-write boundary. Call this before mutating any file that may have
   * been hard-linked from a parent, or the write will land in the parent's
   * snapshot — and in every sibling's.
   *
   * A shared file is detected by its link count rather than by bookkeeping, so a
   * file the caller copied or created itself is correctly reported as unshared
   * and left alone.
   * @param nodeId - the node about to be written through.
   * @param relativePath - the file, relative to the node's workspace.
   * @returns whether a copy was needed, and how large it was.
   * @throws {WorkspaceError} when the node is unknown or the path escapes it.
   */
  async beforeWrite(nodeId: string, relativePath: string): Promise<UnlinkResult> {
    const node = this.requireNode(nodeId)
    const target = this.resolveInside(node, relativePath)

    const info = await lstat(target).catch(() => undefined)
    // A new file has nothing to share, and a directory is not written through.
    if (info === undefined || !info.isFile()) return { copied: false, bytes: 0 }
    if (info.nlink <= 1) return { copied: false, bytes: 0 }

    // Copy beside the target and rename, so a failure cannot leave a half-written
    // file where the caller's content used to be.
    const temporary = `${target}.unlink-${process.pid}-${Date.now()}`
    await copyFile(target, temporary, constants.COPYFILE_EXCL)
    await rm(target)
    await copyFile(temporary, target)
    await rm(temporary)
    return { copied: true, bytes: info.size }
  }

  /**
   * Make an entire subtree private.
   *
   * For a tool that will touch many files and cannot say which in advance — a
   * build, a formatter, a test runner. Coarser than {@link beforeWrite} and
   * correspondingly more expensive, which is why it is a separate entry point
   * rather than the default.
   * @param nodeId - the node about to be written through.
   * @param relativePath - the subtree root, relative to the node's workspace.
   * @returns how many files were made private and the bytes copied.
   */
  async beforeWriteTree(
    nodeId: string,
    relativePath = '.',
  ): Promise<{ readonly copied: number; readonly bytes: number }> {
    const node = this.requireNode(nodeId)
    const base = this.resolveInside(node, relativePath)
    let copied = 0
    let bytes = 0

    const walk = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        const full = join(directory, entry.name)
        if (entry.isDirectory()) { await walk(full); continue }
        if (!entry.isFile()) continue
        const result = await this.beforeWrite(nodeId, full.slice(node.path.length + 1))
        if (result.copied) { copied += 1; bytes += result.bytes }
      }
    }
    await walk(base)
    return { copied, bytes }
  }

  /**
   * Remove workspaces for nodes not in `keep`.
   *
   * The garbage collector this module needs and that a spill store cannot do for
   * it: a forked node inherits its parent's artifacts, so an artifact cannot be
   * freed while any descendant still needs it. Freeing at the tree level is the
   * only correct granularity.
   * @param keep - node ids to retain.
   * @returns the nodes whose workspaces were removed.
   */
  async collect(keep: readonly string[]): Promise<readonly string[]> {
    const retained = new Set(keep)
    const removed: string[] = []
    for (const node of this.nodes.values()) {
      if (retained.has(node.nodeId)) continue
      await rm(node.path, { recursive: true, force: true })
      this.nodes.delete(node.nodeId)
      removed.push(node.nodeId)
    }
    return removed
  }

  /**
   * Remove every workspace and forget every node.
   *
   * For test teardown and for a deployment discarding a finished search.
   */
  async dispose(): Promise<void> {
    await rm(this.root, { recursive: true, force: true })
    this.nodes.clear()
  }

  /** Whether a node's directory currently exists on disk. */
  async exists(nodeId: string): Promise<boolean> {
    const node = this.nodes.get(nodeId)
    if (node === undefined) return false
    return access(node.path).then(() => true, () => false)
  }

  private requireNode(nodeId: string): WorkspaceNode {
    const node = this.nodes.get(nodeId)
    if (node === undefined) {
      throw new WorkspaceError('unknown-node', `unknown node "${nodeId}"`)
    }
    return node
  }

  private pathFor(nodeId: string): string {
    // A node id becomes a relative path, so hierarchical ids ("b0/a0") are fine —
    // they are how a tree reads. What must not survive is anything that could
    // address outside the tree. Rejecting beats sanitising: a sanitised id would
    // silently address a DIFFERENT node than the caller named.
    const segments = nodeId.split('/')
    const safe = nodeId !== ''
      && !nodeId.startsWith('/')
      && segments.every(segment =>
        segment !== ''
        && segment !== '.'
        && segment !== '..'
        && /^[A-Za-z0-9._-]+$/.test(segment))
    if (!safe) {
      throw new WorkspaceError(
        'outside-root',
        `node id "${nodeId}" must be a relative path of safe segments`,
      )
    }
    return join(this.root, 'nodes', nodeId)
  }

  private resolveInside(node: WorkspaceNode, relativePath: string): string {
    const full = resolve(node.path, relativePath)
    if (full !== node.path && !full.startsWith(`${node.path}/`)) {
      throw new WorkspaceError(
        'outside-root',
        `path "${relativePath}" escapes the workspace of "${node.nodeId}"`,
      )
    }
    return full
  }
}
