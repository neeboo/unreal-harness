/**
 * Workspace snapshots: per-node filesystem state, and the copy-on-write boundary
 * that keeps a fork from writing into its parent.
 *
 * The tests that matter are the aliasing ones. A hard-linked fork is only safe if
 * a write breaks the link first, so "the parent is unchanged after a child
 * writes" is the property, and "without the boundary it would have changed" is
 * the negative control that proves the first test is not vacuous.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { lstat, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { WorkspaceError, WorkspaceManager } from '../src/index.ts'

let sandbox: string
let source: string
let manager: WorkspaceManager

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'rsi-workspace-'))
  source = join(sandbox, 'source')
  await mkdir(join(source, 'nested'), { recursive: true })
  await writeFile(join(source, 'a.txt'), 'original a')
  await writeFile(join(source, 'nested', 'b.txt'), 'original b')
  manager = new WorkspaceManager({ root: join(sandbox, 'tree') })
})

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true })
})

async function createTree() {
  await manager.createRoot(source)
  await manager.fork('b0', 'root')
  await manager.fork('b1', 'root')
  await manager.fork('b0_attempt1', 'b0')
}

describe('WorkspaceManager', () => {
  it('adopts a source directory as a real copy, not a link tree', async () => {
    const root = await manager.createRoot(source)
    expect(root.linked).toBe(false)

    // The manager must never mutate the tree it adopted, so the root duplicates
    // rather than sharing inodes with the source.
    const fromSource = await lstat(join(source, 'a.txt'))
    const fromRoot = await lstat(join(root.path, 'a.txt'))
    expect(fromRoot.ino).not.toBe(fromSource.ino)
    expect(await readFile(join(root.path, 'a.txt'), 'utf8')).toBe('original a')
  })

  it('refuses a second root rather than orphaning the first', async () => {
    await manager.createRoot(source)
    // A second root would leave the first unreachable, which is
    // indistinguishable from data loss.
    await expect(manager.createRoot(source)).rejects.toThrow(/already exists/)
  })

  it('refuses a source that is not a directory', async () => {
    await expect(manager.createRoot(join(source, 'a.txt'))).rejects.toThrow(/not a directory/)
  })

  it('forks by hard-linking the parent tree, so storage tracks changes', async () => {
    await createTree()
    const parent = manager.get('b0')!
    const child = manager.get('b0_attempt1')!

    expect(child.linked).toBe(true)
    const shared = await lstat(join(parent.path, 'a.txt'))
    const linked = await lstat(join(child.path, 'a.txt'))
    // Same inode: no file data was copied, and the nested directory came along.
    expect(linked.ino).toBe(shared.ino)
    expect(linked.nlink).toBeGreaterThanOrEqual(2)
    expect(await readFile(join(child.path, 'nested', 'b.txt'), 'utf8')).toBe('original b')
  })

  it('refuses an unknown parent and a taken id', async () => {
    await manager.createRoot(source)
    await expect(manager.fork('x', 'ghost')).rejects.toThrow(/unknown parent/)
    await manager.fork('y', 'root')
    await expect(manager.fork('y', 'root')).rejects.toThrow(/already has a workspace/)
  })

  it('allows a hierarchical node id but refuses a traversing one', async () => {
    await manager.createRoot(source)
    // "branch/b0" is how a tree reads, so a slash is fine.
    const nested = await manager.fork('branch/b0', 'root')
    expect(nested.nodeId).toBe('branch/b0')

    // What must not survive is anything that could address outside the tree.
    await expect(manager.fork('../escape', 'root')).rejects.toThrow(WorkspaceError)
    await expect(manager.fork('/absolute', 'root')).rejects.toThrow(WorkspaceError)
    await expect(manager.fork('a/../../b', 'root')).rejects.toThrow(WorkspaceError)
    await expect(manager.fork('', 'root')).rejects.toThrow(WorkspaceError)
  })

  it('refuses a fork whose destination nests inside its own source', async () => {
    await manager.createRoot(source)
    await manager.fork('b0', 'root')

    // Copying a tree into a directory inside itself makes the walk descend into
    // its own output forever. The recursion is silent until the path length runs
    // out, so it is refused up front.
    await expect(manager.fork('b0/a0', 'b0')).rejects.toThrow(/nest inside its parent/)
    // The same hazard by a different route: forking a node onto itself.
    await expect(manager.fork('b0', 'b0')).rejects.toThrow(WorkspaceError)
  })

  describe('copy-on-write', () => {
    it('makes a shared file private before a write', async () => {
      await createTree()
      const child = manager.get('b0_attempt1')!
      const parent = manager.get('b0')!

      const result = await manager.beforeWrite('b0_attempt1', 'a.txt')
      expect(result.copied).toBe(true)
      expect(result.bytes).toBeGreaterThan(0)

      await writeFile(join(child.path, 'a.txt'), 'child changed')
      // The property: the child's write stayed in the child.
      expect(await readFile(join(child.path, 'a.txt'), 'utf8')).toBe('child changed')
      expect(await readFile(join(parent.path, 'a.txt'), 'utf8')).toBe('original a')
    })

    it('shows the aliasing the boundary prevents, as a negative control', async () => {
      await createTree()
      const child = manager.get('b0_attempt1')!
      const parent = manager.get('b0')!

      // Deliberately skip `beforeWrite`, which is what a caller that ignores the
      // contract does — and what a filesystem watcher would be too late to stop.
      await writeFile(join(child.path, 'a.txt'), 'clobbered')

      // This is the bug the boundary exists to prevent, so it is asserted rather
      // than described: without it, a child's write lands in the parent's
      // snapshot AND in every sibling's.
      expect(await readFile(join(parent.path, 'a.txt'), 'utf8')).toBe('clobbered')
      const sibling = manager.get('b1')!
      const stillShared = await lstat(join(sibling.path, 'a.txt'))
      expect(stillShared.nlink).toBeGreaterThanOrEqual(2)
    })

    it('leaves an already-private file alone', async () => {
      await createTree()
      const node = manager.get('b0')!

      // A file the node created itself has one link and needs no copy.
      await writeFile(join(node.path, 'new.txt'), 'mine')
      const result = await manager.beforeWrite('b0', 'new.txt')
      expect(result.copied).toBe(false)
      expect(result.bytes).toBe(0)
    })

    it('treats a missing file as private, so creating one needs no copy', async () => {
      await createTree()
      expect(await manager.beforeWrite('b0', 'never-existed.txt'))
        .toEqual({ copied: false, bytes: 0 })
    })

    it('refuses a path that escapes the workspace', async () => {
      await createTree()
      await expect(manager.beforeWrite('b0', '../../etc/hosts')).rejects.toThrow(WorkspaceError)
    })

    it('refuses an unknown node', async () => {
      await createTree()
      await expect(manager.beforeWrite('ghost', 'a.txt')).rejects.toThrow(/unknown node/)
    })

    it('can make an entire subtree private for a tool that cannot say what it touches', async () => {
      await createTree()
      const child = manager.get('b0_attempt1')!
      const parent = manager.get('b0')!

      const result = await manager.beforeWriteTree('b0_attempt1')
      expect(result.copied).toBe(2)
      expect(result.bytes).toBeGreaterThan(0)

      await writeFile(join(child.path, 'nested', 'b.txt'), 'changed deep')
      expect(await readFile(join(parent.path, 'nested', 'b.txt'), 'utf8')).toBe('original b')
    })
  })

  describe('collection', () => {
    it('removes workspaces for nodes not retained', async () => {
      await createTree()
      const removed = await manager.collect(['root', 'b0'])

      expect([...removed].sort()).toEqual(['b0_attempt1', 'b1'])
      expect(await manager.exists('b0')).toBe(true)
      expect(await manager.exists('b1')).toBe(false)
      expect(manager.size).toBe(2)
      // The directory is really gone, not just forgotten.
      await expect(stat(join(manager.rootPath, 'nodes', 'b1'))).rejects.toThrow()
    })

    it('disposes the whole tree', async () => {
      await createTree()
      await manager.dispose()
      expect(manager.size).toBe(0)
      await expect(stat(manager.rootPath)).rejects.toThrow()
    })
  })
})
