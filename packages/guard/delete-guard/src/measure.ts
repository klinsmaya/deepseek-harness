/**
 * Bounded filesystem measurement for a delete target.
 * Symlinks are counted as one entry and are not followed.
 * @module @deepseek-ai/dsh-delete-guard/measure
 */

import { lstat, readdir, realpath } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/** What a measured path contains, or that the path is absent. */
export interface Measurement {
  /** Non-directory entries, including symlinks. */
  readonly fileCount: number
  /** Sum of file sizes. Symlink sizes are the link's own size. */
  readonly byteCount: number
  /** True when the walk stopped at the entry cap before finishing. */
  readonly truncated: boolean
  /** True when the path does not exist. */
  readonly missing: boolean
}

interface ListedEntry {
  readonly name: string
  readonly kind: 'dir' | 'file' | 'symlink'
}

interface EntryStats {
  readonly kind: 'dir' | 'file' | 'symlink'
  readonly size: number
}

/** Filesystem reads the measurement uses. Tests replace this to force failures. */
export interface MeasureFs {
  /** Stat one path without following symlinks. */
  lstat(path: string): Promise<EntryStats>
  /** List one directory without following symlinks. */
  readdir(path: string): Promise<readonly ListedEntry[]>
}

const nodeFs: MeasureFs = {
  async lstat(path) {
    const stats = await lstat(path)
    if (stats.isSymbolicLink()) return { kind: 'symlink', size: stats.size }
    if (stats.isDirectory()) return { kind: 'dir', size: stats.size }
    return { kind: 'file', size: stats.size }
  },
  async readdir(path) {
    const entries = await readdir(path, { withFileTypes: true })
    return entries.map(listedKind)
  },
}

/**
 * Count files and bytes at `target`, stopping after `cap` entries.
 * @param target - absolute or relative path to measure.
 * @param cap - maximum directory entries to visit, including the target.
 * @param signal - aborts the walk before the next entry.
 * @param fs - filesystem reads. The default reads the host filesystem.
 * @returns the count, or a missing result when the path does not exist.
 * @throws when a read fails for a reason other than a missing path, or when `signal` is already aborted.
 */
export async function measurePath(
  target: string,
  cap: number,
  signal?: AbortSignal,
  fs: MeasureFs = nodeFs,
): Promise<Measurement> {
  signal?.throwIfAborted()
  let stats: EntryStats
  try {
    stats = await fs.lstat(target)
  } catch (error: unknown) {
    if (isNotFound(error)) return { fileCount: 0, byteCount: 0, truncated: false, missing: true }
    throw error
  }
  if (stats.kind !== 'dir') {
    return { fileCount: 1, byteCount: stats.size, truncated: false, missing: false }
  }
  let fileCount = 0
  let byteCount = 0
  let visited = 1
  const pending = [target]
  while (pending.length > 0) {
    signal?.throwIfAborted()
    // oxlint-disable-next-line typescript/no-non-null-assertion -- the while condition proves pending is non-empty
    const directory = pending.pop()!
    let entries: readonly ListedEntry[]
    try {
      entries = await fs.readdir(directory)
    } catch (error: unknown) {
      if (isNotFound(error)) return { fileCount, byteCount, truncated: true, missing: false }
      throw error
    }
    for (const entry of entries) {
      visited += 1
      if (visited > cap) return { fileCount, byteCount, truncated: true, missing: false }
      const path = `${directory}${sep}${entry.name}`
      if (entry.kind === 'dir') {
        pending.push(path)
        continue
      }
      signal?.throwIfAborted()
      try {
        const child = await fs.lstat(path)
        fileCount += 1
        byteCount += child.size
      } catch (error: unknown) {
        if (isNotFound(error)) continue
        throw error
      }
    }
  }
  return { fileCount, byteCount, truncated: false, missing: false }
}

/**
 * True when `child` is `parent` or a path inside it.
 * @param parent - directory that may contain `child`.
 * @param child - path to test.
 * @returns whether `child` does not escape `parent`.
 */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

/**
 * Configured roots plus their real paths when those paths exist.
 * A missing root contributes only its configured spelling.
 * @param roots - configured directory paths.
 * @returns absolute paths to compare against a delete target.
 * @throws when resolving an existing root fails for a reason other than absence.
 */
export async function expandRoots(roots: readonly string[]): Promise<readonly string[]> {
  const expanded: string[] = []
  for (const root of roots) {
    const resolved = resolve(root)
    expanded.push(resolved)
    try {
      expanded.push(await realpath(resolved))
    } catch (error: unknown) {
      if (!isNotFound(error)) throw error
    }
  }
  return [...new Set(expanded)]
}

/**
 * True when `error` is a missing-path filesystem error.
 * @param error - a thrown filesystem error.
 * @returns whether the error code is `ENOENT`.
 */
export function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function listedKind(entry: Dirent): ListedEntry {
  if (entry.isSymbolicLink()) return { name: entry.name, kind: 'symlink' }
  if (entry.isDirectory()) return { name: entry.name, kind: 'dir' }
  return { name: entry.name, kind: 'file' }
}
