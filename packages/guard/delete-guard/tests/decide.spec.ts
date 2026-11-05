import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assessDeletes, ASK_PREFIX, deletionMessage, DENY_CHANNEL_PREFIX, DENY_NEVER_PREFIX, formatImpacts } from '../src/decide.ts'
import type { DeleteLimits } from '../src/decide.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function temp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-delete-decide-'))
  roots.push(root)
  return root
}

function limits(workspace: string, extra: Partial<DeleteLimits> = {}): DeleteLimits {
  return {
    fileCountThreshold: 10,
    byteThreshold: 1000,
    measureEntryCap: 100,
    sessionRoots: [],
    workspace,
    ...extra,
  }
}

describe('assessDeletes', () => {
  it('allows a single file delete and a small in-workspace recursive delete', async () => {
    const workspace = await temp()
    await writeFile(join(workspace, 'one.txt'), 'hi')
    const small = join(workspace, 'small')
    await mkdir(small)
    await writeFile(join(small, 'a.txt'), 'xy')
    expect(await assessDeletes('rm one.txt', 'shell', limits(workspace))).toEqual([])
    expect(await assessDeletes('rm -rf small', 'shell', limits(workspace))).toEqual([])
    expect(await assessDeletes('ls', 'shell', limits(workspace))).toEqual([])
  })

  it('holds a recursive delete outside the workspace and reports the count', async () => {
    const workspace = await temp()
    const outside = await temp()
    await writeFile(join(outside, 'a.txt'), 'abcd')
    const hits = await assessDeletes(`rm -rf ${outside}`, 'shell', limits(workspace))
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({
      path: outside,
      fileCount: 1,
      byteCount: 4,
      reasons: ['recursive', 'outside workspace'],
    })
    expect(formatImpacts(hits)).toContain(`${outside}: 1 files, 4 bytes`)
  })

  it('holds an in-workspace delete that exceeds the file or byte threshold', async () => {
    const workspace = await temp()
    const tree = join(workspace, 'tree')
    await mkdir(tree)
    await writeFile(join(tree, 'a.txt'), 'x')
    await writeFile(join(tree, 'b.txt'), 'yz')
    const byCount = await assessDeletes('rm -rf tree', 'shell', limits(workspace, { fileCountThreshold: 1 }))
    expect(byCount[0]?.reasons).toContain('above threshold')
    expect(byCount[0]?.fileCount).toBe(2)
    const byBytes = await assessDeletes('rm -rf tree', 'shell', limits(workspace, { byteThreshold: 1 }))
    expect(byBytes[0]?.reasons).toContain('above threshold')
  })

  it('holds session storage even for one file, including a parent of the root', async () => {
    const workspace = await temp()
    const sessions = await temp()
    await writeFile(join(sessions, 'session.jsonl'), 'log')
    const fileHit = await assessDeletes(`rm ${join(sessions, 'session.jsonl')}`, 'shell', limits(workspace, { sessionRoots: [sessions] }))
    expect(fileHit[0]?.reasons).toContain('session storage')
    expect(fileHit[0]?.fileCount).toBe(1)
    const parent = join(workspace, 'parent')
    const nested = join(parent, 'sessions')
    await mkdir(nested, { recursive: true })
    await writeFile(join(nested, 'session.jsonl'), 'log')
    const parentHit = await assessDeletes(`rm -rf ${parent}`, 'shell', limits(workspace, { sessionRoots: [nested] }))
    expect(parentHit[0]?.path).toBe(parent)
    expect(parentHit[0]?.reasons).toContain('session storage')
    const link = join(workspace, 'sessions-link')
    await symlink(sessions, link)
    const throughLink = await assessDeletes(`rm -rf ${link}`, 'shell', limits(workspace, { sessionRoots: [link] }))
    expect(throughLink[0]?.reasons).toContain('session storage')
  })

  it('fails closed for an unresolved recursive delete and a failed measurement', async () => {
    const workspace = await temp()
    const unresolved = await assessDeletes('rm -rf "$DIR"', 'shell', limits(workspace))
    expect(unresolved[0]).toMatchObject({
      path: '$DIR',
      reasons: ['recursive', 'size unavailable'],
    })
    const failed = await assessDeletes('rm -rf /tmp/tree', 'shell', limits(workspace), undefined, () => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' })
    })
    expect(failed[0]?.reasons).toContain('size unavailable')
    const controller = new AbortController()
    controller.abort()
    await expect(assessDeletes('rm -rf /tmp/tree', 'shell', limits(workspace), controller.signal)).rejects.toThrow()
    const late = new AbortController()
    await expect(assessDeletes('rm -rf /tmp/tree', 'shell', limits(workspace), late.signal, async () => {
      late.abort()
      throw new Error('late')
    })).rejects.toThrow('late')
    const file = join(workspace, 'file')
    await writeFile(file, 'x')
    const broken = await assessDeletes('rm -rf /tmp/tree', 'shell', limits(workspace, { sessionRoots: [join(file, 'child')] }))
    expect(broken[0]?.path).toBe('(delete target)')
  })

  it('uses a tool workdir without treating it as the workspace, and reads code deletes', async () => {
    const workspace = await temp()
    const other = await temp()
    await mkdir(join(other, 'tiny'))
    const hits = await assessDeletes('rm -rf tiny', 'shell', limits(workspace, { pathBase: other }))
    expect(hits[0]?.path).toBe(join(other, 'tiny'))
    expect(hits[0]?.reasons).toContain('outside workspace')
    const code = await assessDeletes('fs.rmSync("/no/such/tree", { recursive: true })', 'code', limits(workspace))
    expect(code[0]?.reasons).toEqual(expect.arrayContaining(['recursive', 'outside workspace']))
    const home = await assessDeletes('rm -rf ~/dsh-delete-guard-missing', 'shell', limits(workspace))
    expect(home[0]?.path.startsWith(homedir())).toBe(true)
  })

  it('holds a truncated in-workspace walk', async () => {
    const workspace = await temp()
    const tree = join(workspace, 'tree')
    await mkdir(tree)
    await writeFile(join(tree, 'a.txt'), 'x')
    const hits = await assessDeletes('rm -rf tree', 'shell', limits(workspace, { measureEntryCap: 1 }))
    expect(hits[0]?.truncated).toBe(true)
    expect(hits[0]?.reasons).toContain('size unavailable')
  })
})

describe('deletionMessage', () => {
  it('renders confirmation and both denial forms', () => {
    const hits = [{ path: '/tmp/tree', fileCount: 2, byteCount: 9, truncated: false, reasons: ['recursive' as const, 'outside workspace' as const] }]
    const ask = deletionMessage(hits, 'ask')
    expect(ask.reason.startsWith(ASK_PREFIX)).toBe(true)
    expect(ask.reason).toContain('/tmp/tree: 2 files, 9 bytes (recursive, outside workspace)')
    expect(ask.displayReason?.zh).toContain('确认这次删除？')
    expect(deletionMessage(hits, 'never').reason.startsWith(DENY_NEVER_PREFIX)).toBe(true)
    expect(deletionMessage(hits, 'channel').reason.startsWith(DENY_CHANNEL_PREFIX)).toBe(true)
    const partial = deletionMessage([{ path: '/tmp/tree', fileCount: 1, byteCount: 1, truncated: true, reasons: ['recursive'] }], 'ask')
    expect(partial.reason).toContain('at least 1 files, at least 1 bytes')
    const unknown = deletionMessage([{ path: '$DIR', truncated: false, reasons: ['size unavailable'] }], 'channel')
    expect(unknown.reason).toContain('file count unavailable')
    const missingBytes = deletionMessage([{ path: '/tmp/tree', fileCount: 1, truncated: true, reasons: ['recursive'] }], 'ask')
    expect(missingBytes.reason).toContain('at least 1 files, at least 0 bytes')
    const exactMissingBytes = deletionMessage([{ path: '/tmp/tree', fileCount: 2, truncated: false, reasons: ['recursive'] }], 'ask')
    expect(exactMissingBytes.reason).toContain('2 files, 0 bytes')
  })
})

describe('merged and tilde targets', () => {
  it('merges duplicate targets and places a bare tilde and an unresolved directory change', async () => {
    const workspace = await temp()
    const duplicated = await assessDeletes('rm -r /tmp/same /tmp/same', 'shell', limits(workspace))
    expect(duplicated).toHaveLength(1)
    const unresolved = await assessDeletes('rm -rf "$A" "$A"', 'shell', limits(workspace))
    expect(unresolved).toHaveLength(1)
    const tilde = await assessDeletes('rm -rf ~', 'shell', limits(workspace))
    expect(tilde[0]?.path).toBe(homedir())
    const moved = await assessDeletes('pushd /tmp && rm -rf foo', 'shell', limits(workspace))
    expect(moved[0]?.path).toBe('foo')
    const absolute = await assessDeletes('pushd /tmp && rm -rf /tmp/abs', 'shell', limits(workspace))
    expect(absolute[0]?.path).toBe('/tmp/abs')
    const fromCd = await assessDeletes('cd /tmp && rm -rf foo', 'shell', limits(workspace))
    expect(fromCd[0]?.path).toBe('/tmp/foo')
    const noBase = await assessDeletes('rm -rf relative-dir', 'shell', limits(workspace, { workspace: undefined, pathBase: undefined }))
    expect(noBase[0]?.path).toBe('relative-dir')
    const named = await assessDeletes('rm -rf /sessions/$ID', 'shell', limits(workspace, { sessionRoots: ['/sessions'] }))
    expect(named[0]?.reasons).toContain('session storage')
  })
})
