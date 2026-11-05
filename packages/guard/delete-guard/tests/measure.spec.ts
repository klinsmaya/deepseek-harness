import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { expandRoots, isInside, isNotFound, measurePath } from '../src/measure.ts'
import type { MeasureFs } from '../src/measure.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function temp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-delete-measure-'))
  roots.push(root)
  return root
}

describe('measurePath', () => {
  it('counts a file, a missing path, a directory, and a symlink without following it', async () => {
    const root = await temp()
    await writeFile(join(root, 'one.txt'), 'abcd')
    const file = await measurePath(join(root, 'one.txt'), 20)
    expect(file).toEqual({ fileCount: 1, byteCount: 4, truncated: false, missing: false })
    const missing = await measurePath(join(root, 'absent'), 20)
    expect(missing).toEqual({ fileCount: 0, byteCount: 0, truncated: false, missing: true })
    const dir = join(root, 'tree')
    await mkdir(join(dir, 'nested'), { recursive: true })
    await writeFile(join(dir, 'nested', 'a.txt'), 'xy')
    await symlink(join(dir, 'nested'), join(dir, 'link'))
    const tree = await measurePath(dir, 20)
    expect(tree.fileCount).toBe(2)
    expect(tree.byteCount).toBeGreaterThanOrEqual(2)
    expect(tree.truncated).toBe(false)
    expect(tree.missing).toBe(false)
    const capped = await measurePath(dir, 1)
    expect(capped.truncated).toBe(true)
    expect(capped.fileCount).toBe(0)
  })

  it('stops on abort and reports filesystem failures', async () => {
    await expect(measurePath('/tmp', 10, AbortSignal.abort())).rejects.toThrow()
    const denied: MeasureFs = {
      lstat: () => Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' })),
      readdir: () => Promise.resolve([]),
    }
    await expect(measurePath('/tmp/denied', 10, undefined, denied)).rejects.toThrow('denied')
    const vanished: MeasureFs = {
      lstat: () => Promise.resolve({ kind: 'dir', size: 0 }),
      readdir: () => Promise.reject(Object.assign(new Error('gone'), { code: 'ENOENT' })),
    }
    await expect(measurePath('/tmp/gone', 10, undefined, vanished)).resolves.toMatchObject({ truncated: true, missing: false })
    const childMissing: MeasureFs = {
      async lstat(path) {
        if (path.endsWith('missing')) throw Object.assign(new Error('gone'), { code: 'ENOENT' })
        return { kind: 'dir', size: 0 }
      },
      async readdir() {
        return [{ name: 'missing', kind: 'file' }]
      },
    }
    await expect(measurePath('/tmp/parent', 10, undefined, childMissing)).resolves.toMatchObject({ fileCount: 0, missing: false })
    const childDenied: MeasureFs = {
      async lstat(path) {
        if (path.endsWith('secret')) throw Object.assign(new Error('denied'), { code: 'EACCES' })
        return { kind: 'dir', size: 0 }
      },
      async readdir() {
        return [{ name: 'secret', kind: 'file' }]
      },
    }
    await expect(measurePath('/tmp/parent', 10, undefined, childDenied)).rejects.toThrow('denied')
    const listingDenied: MeasureFs = {
      async lstat() {
        return { kind: 'dir', size: 0 }
      },
      async readdir() {
        throw Object.assign(new Error('denied'), { code: 'EACCES' })
      },
    }
    await expect(measurePath('/tmp/parent', 10, undefined, listingDenied)).rejects.toThrow('denied')
    const controller = new AbortController()
    const aborting: MeasureFs = {
      async lstat() {
        return { kind: 'dir', size: 0 }
      },
      async readdir() {
        controller.abort()
        return [{ name: 'a', kind: 'file' }]
      },
    }
    await expect(measurePath('/tmp/parent', 10, controller.signal, aborting)).rejects.toThrow()
  })
})

describe('path helpers', () => {
  it('treats a directory as inside itself and a sibling as outside', () => {
    expect(isInside('/work/app', '/work/app')).toBe(true)
    expect(isInside('/work/app', '/work/app/src')).toBe(true)
    expect(isInside('/work/app', '/work/app-other')).toBe(false)
    expect(isInside('/work/app', '/work')).toBe(false)
    expect(isNotFound(Object.assign(new Error('missing'), { code: 'ENOENT' }))).toBe(true)
    expect(isNotFound(new Error('other'))).toBe(false)
    expect(isNotFound('no')).toBe(false)
  })

  it('keeps a missing root and adds the real path of a symlink root', async () => {
    const root = await temp()
    const real = join(root, 'real')
    const link = join(root, 'link')
    await mkdir(real)
    await symlink(real, link)
    const expanded = await expandRoots([link, join(root, 'missing')])
    expect(expanded).toContain(link)
    expect(expanded).toContain(real)
    expect(expanded).toContain(join(root, 'missing'))
    const file = join(root, 'file')
    await writeFile(file, 'x')
    await expect(expandRoots([join(file, 'child')])).rejects.toThrow()
  })
})
