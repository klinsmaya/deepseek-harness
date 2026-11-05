/**
 * Decide whether a command's deletes need confirmation, and describe their impact.
 * @module @deepseek-ai/dsh-delete-guard/decide
 */

import { isAbsolutePath, resolveAgainst } from './parse.ts'
import { homedir } from 'node:os'
import type { Operand, RecognizedDelete } from './parse.ts'
import { recognizeCodeDeletes, recognizeCommandDeletes } from './parse.ts'
import { expandRoots, isInside, measurePath } from './measure.ts'
import type { Measurement } from './measure.ts'

/** Model-facing sentence that starts a confirmation request. */
export const ASK_PREFIX = 'Destructive delete requires confirmation before it runs.'

/** Sentence after the impact list when the user can confirm. */
export const ASK_SUFFIX = 'Confirm this exact delete. Full sandbox access does not skip this check.'

/** Model-facing sentence when approval policy `never` blocks the delete. */
export const DENY_NEVER_PREFIX = 'Destructive delete blocked. Approval policy "never" does not authorize this delete, including under danger-full-access.'

/** What the model can do after a policy `never` denial. */
export const DENY_NEVER_SUFFIX = 'Nothing was removed. Narrow the delete, or switch this session\'s approval policy to "ask" and retry so the user can confirm.'

/** Model-facing sentence when no approval channel can confirm the delete. */
export const DENY_CHANNEL_PREFIX = 'Destructive delete blocked. No approval channel is available, so the delete does not run.'

/** Closing sentence for a denial that has no confirmation channel. */
export const DENY_CHANNEL_SUFFIX = 'Nothing was removed.'

const REASON_ORDER = ['recursive', 'outside workspace', 'session storage', 'above threshold', 'size unavailable'] as const

type Reason = typeof REASON_ORDER[number]

/** One delete target that the check will not run without confirmation. */
export interface DeleteImpact {
  /** Absolute path, or the unresolved operand text. */
  readonly path: string
  /** File count, when the walk finished or stopped early. Absent when the walk failed. */
  readonly fileCount?: number
  /** Byte count paired with {@link fileCount}. */
  readonly byteCount?: number
  /** True when the walk stopped at the entry cap. */
  readonly truncated: boolean
  /** Why this target is held. */
  readonly reasons: readonly Reason[]
}

/** Limits and locations for one check. */
export interface DeleteLimits {
  /** Hold a recursive in-workspace delete with more files than this. */
  readonly fileCountThreshold: number
  /** Hold a recursive in-workspace delete with more bytes than this. */
  readonly byteThreshold: number
  /** Stop measuring after this many visited entries. */
  readonly measureEntryCap: number
  /** Absolute session-storage directories. */
  readonly sessionRoots: readonly string[]
  /** Absolute workspace directory used as the inside/outside boundary. */
  readonly workspace?: string
  /**
   * Directory relative operands resolve against. Defaults to {@link workspace}.
   * A tool `workdir` sets this without moving the workspace boundary.
   */
  readonly pathBase?: string
}

type Measurer = (path: string, cap: number, signal?: AbortSignal) => Promise<Measurement>

/**
 * Find deletes in `command` that must be confirmed.
 * @param command - tool command or program text.
 * @param kind - `code` also scans interpreter deletes; shell text is always scanned as POSIX and PowerShell.
 * @param limits - thresholds, session roots, and workspace.
 * @param signal - aborts measurement.
 * @param measure - path measurement. The default reads the host filesystem.
 * @returns the held targets. An empty list means the command may run.
 * @throws when `signal` is already aborted.
 */
export async function assessDeletes(
  command: string,
  kind: 'shell' | 'code',
  limits: DeleteLimits,
  signal?: AbortSignal,
  measure: Measurer = (path, cap, abort) => measurePath(path, cap, abort),
): Promise<readonly DeleteImpact[]> {
  signal?.throwIfAborted()
  const recognized = [
    ...recognizeCommandDeletes(command, 'posix'),
    ...recognizeCommandDeletes(command, 'powershell'),
    ...kind === 'code' ? recognizeCodeDeletes(command) : [],
  ]
  if (recognized.length === 0) return []
  try {
    const roots = await expandRoots(limits.sessionRoots)
    const hits: DeleteImpact[] = []
    for (const deleteCommand of recognized) {
      for (const operand of deleteCommand.operands) {
        const hit = await consider(operand, deleteCommand, roots, limits, limits.pathBase ?? limits.workspace, measure, signal)
        if (hit !== undefined) hits.push(hit)
      }
    }
    return mergeHits(hits)
  } catch (error: unknown) {
    if (signal?.aborted === true) throw error
    return [{
      path: '(delete target)',
      truncated: false,
      reasons: ['size unavailable'],
    }]
  }
}

/**
 * Render the impact list shared by confirmation and denial text.
 * @param hits - held targets from {@link assessDeletes}.
 * @returns one bullet per target.
 */
export function formatImpacts(hits: readonly DeleteImpact[]): string {
  return hits.map(targetLine).join('\n')
}

/**
 * Build the confirmation text and the denial text for one impact list.
 * @param hits - held targets. Must be non-empty.
 * @param mode - `ask` requests confirmation; `never` and `channel` deny.
 * @returns the model-facing reason and, for `ask`, the bilingual prompt.
 */
export function deletionMessage(hits: readonly DeleteImpact[], mode: 'ask' | 'never' | 'channel'): {
  readonly reason: string
  readonly displayReason: { readonly en: string; readonly zh: string }
} {
  const impact = formatImpacts(hits)
  if (mode === 'ask') {
    return {
      reason: `${ASK_PREFIX}\n${impact}\n${ASK_SUFFIX}`,
      displayReason: {
        en: `Confirm this delete?\n${impact}`,
        zh: `确认这次删除？\n${impact}`,
      },
    }
  }
  const reason = mode === 'never'
    ? `${DENY_NEVER_PREFIX}\n${impact}\n${DENY_NEVER_SUFFIX}`
    : `${DENY_CHANNEL_PREFIX}\n${impact}\n${DENY_CHANNEL_SUFFIX}`
  return { reason, displayReason: { en: reason, zh: reason } }
}

async function consider(
  operand: Operand,
  deleteCommand: RecognizedDelete,
  roots: readonly string[],
  limits: DeleteLimits,
  pathBase: string | undefined,
  measure: Measurer,
  signal: AbortSignal | undefined,
): Promise<DeleteImpact | undefined> {
  const placed = placeOperand(operand, deleteCommand.cwd, pathBase)
  if (placed.kind === 'unresolved') {
    const session = roots.some(root => operand.text.includes(root))
    if (!deleteCommand.recursive && !session) return undefined
    return {
      path: operand.text,
      truncated: false,
      reasons: reasonsFor(deleteCommand.recursive, false, session, false, true),
    }
  }
  const session = roots.some(root => isInside(root, placed.path) || isInside(placed.path, root))
  const outside = limits.workspace === undefined || !isInside(limits.workspace, placed.path)
  if (!deleteCommand.recursive && !session) return undefined
  let measurement: Measurement | undefined
  let failed = false
  try {
    measurement = await measure(placed.path, limits.measureEntryCap, signal)
  } catch (error: unknown) {
    if (signal?.aborted === true) throw error
    failed = true
  }
  const exceeded = measurement !== undefined && !failed && (
    measurement.fileCount > limits.fileCountThreshold || measurement.byteCount > limits.byteThreshold
  )
  const incomplete = failed || measurement === undefined || measurement.truncated
  const insideSmall = deleteCommand.recursive && !session && !outside && !incomplete && !exceeded
  if (insideSmall) return undefined
  return {
    path: placed.path,
    ...measurement !== undefined && !failed ? { fileCount: measurement.fileCount, byteCount: measurement.byteCount } : {},
    truncated: measurement?.truncated === true,
    reasons: reasonsFor(deleteCommand.recursive, outside, session, exceeded, incomplete && !exceeded),
  }
}

function reasonsFor(
  recursive: boolean,
  outside: boolean,
  session: boolean,
  over: boolean,
  unavailable: boolean,
): Reason[] {
  const reasons: Reason[] = []
  if (recursive) reasons.push('recursive')
  if (outside) reasons.push('outside workspace')
  if (session) reasons.push('session storage')
  if (over) reasons.push('above threshold')
  if (unavailable) reasons.push('size unavailable')
  return reasons
}

function placeOperand(
  operand: Operand,
  commandCwd: RecognizedDelete['cwd'],
  workspace: string | undefined,
): { kind: 'path'; path: string } | { kind: 'unresolved' } {
  if (operand.unresolved || operand.text.length === 0) return { kind: 'unresolved' }
  const expanded = expandTilde(operand.text)
  if (commandCwd?.kind === 'unresolved' && !isAbsolutePath(expanded)) return { kind: 'unresolved' }
  const base = commandCwd?.kind === 'path' ? commandCwd.path : workspace
  const resolved = resolveAgainst(commandCwd?.kind === 'unresolved' ? undefined : base, expanded)
  if (resolved === undefined) return { kind: 'unresolved' }
  return { kind: 'path', path: resolved }
}

function expandTilde(text: string): string {
  if (text === '~') return homedir()
  if (text.startsWith('~/')) return `${homedir()}/${text.slice(2)}`
  return text
}

function targetLine(hit: DeleteImpact): string {
  const size = hit.fileCount === undefined
    ? 'file count unavailable'
    : hit.truncated
      ? `at least ${hit.fileCount} files, at least ${hit.byteCount ?? 0} bytes`
      : `${hit.fileCount} files, ${hit.byteCount ?? 0} bytes`
  const reasons = REASON_ORDER.filter(reason => hit.reasons.includes(reason))
  return `- ${hit.path}: ${size} (${reasons.join(', ')})`
}

function mergeHits(hits: readonly DeleteImpact[]): DeleteImpact[] {
  const merged = new Map<string, DeleteImpact>()
  for (const hit of hits) {
    const prior = merged.get(hit.path)
    if (prior === undefined) {
      merged.set(hit.path, { ...hit, reasons: [...hit.reasons] })
      continue
    }
    const reasons = REASON_ORDER.filter(reason => prior.reasons.includes(reason) || hit.reasons.includes(reason))
    const counts = prior.fileCount !== undefined ? prior : hit
    merged.set(hit.path, {
      path: hit.path,
      ...counts.fileCount !== undefined ? { fileCount: counts.fileCount, byteCount: counts.byteCount } : {},
      truncated: prior.truncated || hit.truncated,
      reasons,
    })
  }
  return [...merged.values()]
}
