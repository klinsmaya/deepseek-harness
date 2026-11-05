/**
 * Holds shell, terminal, and `run_code` deletes that would remove session
 * storage, recursively leave the workspace, or exceed the configured file
 * or byte threshold. Confirmation goes through `tools/pre-execute`'s `ask`
 * decision. Approval policy `never`, and a call with no approval channel,
 * deny the delete instead of running it.
 * @module @deepseek-ai/dsh-delete-guard
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { isAbsolute, resolve } from 'node:path'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-working-directory'
import { assessDeletes, deletionMessage } from './decide.ts'
import type { DeleteImpact } from './decide.ts'

export const name = 'delete-guard'

export const inject = ['tools']

/** File-count default used when a composition omits `fileCountThreshold`. */
export const DEFAULT_FILE_COUNT_THRESHOLD = 10_000

/** Byte-count default used when a composition omits `byteThreshold`. */
export const DEFAULT_BYTE_THRESHOLD = 1024 * 1024 * 1024

/** Walk-cap default used when a composition omits `measureEntryCap`. */
export const DEFAULT_MEASURE_ENTRY_CAP = 20_000

/** Configuration for the delete check. */
export interface Config {
  /** Hold a recursive in-workspace delete with more files than this (default 10000). */
  fileCountThreshold?: number
  /** Hold a recursive in-workspace delete with more bytes than this (default 1 GiB). */
  byteThreshold?: number
  /**
   * Stop counting after this many visited entries (default 20000). An
   * unfinished walk is held even when the partial count is under the thresholds.
   */
  measureEntryCap?: number
  /**
   * Extra absolute session-storage directories. The mounted session
   * persistence backend's roots are always included.
   */
  sessionRoots?: string[]
}

/** Runtime configuration schema for the delete check. */
export const Config: z<Config> = z.object({
  fileCountThreshold: z.number().default(DEFAULT_FILE_COUNT_THRESHOLD),
  byteThreshold: z.number().default(DEFAULT_BYTE_THRESHOLD),
  measureEntryCap: z.number().default(DEFAULT_MEASURE_ENTRY_CAP),
  sessionRoots: z.array(z.string()).default([]),
})

const SHELL_COMMAND = new Set(['bash', 'pwsh'])
const SHELL_TEXT = new Set(['terminal_send'])
const CODE_TEXT = new Set(['run_code'])

/**
 * Install the delete check on `tools/pre-execute`.
 * @param ctx - plugin context. The listener is disposed with the plugin.
 * @param config - thresholds and extra session roots.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const limits = resolveConfig(config)
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const later = await next()
    if (later.kind !== 'allow') return later
    const command = readCommand(exec)
    if (command === undefined) return later
    const workspace = sessionWorkspace(ctx, exec)
    const pathBase = pathBaseOf(workspace, command.workdir)
    const hits = await assessDeletes(command.text, command.kind, {
      ...limits,
      sessionRoots: [...limits.sessionRoots, ...sessionRootsOf(ctx)],
      ...workspace !== undefined ? { workspace } : {},
      ...pathBase !== undefined ? { pathBase } : {},
    }, exec.signal)
    if (hits.length === 0) return later
    const mode = confirmationMode(ctx, exec)
    const message = deletionMessage(hits, mode)
    if (mode === 'ask') return { kind: 'ask', reason: message.reason, displayReason: message.displayReason }
    return { kind: 'deny', reason: message.reason }
  })
}

function resolveConfig(config: Config): {
  fileCountThreshold: number
  byteThreshold: number
  measureEntryCap: number
  sessionRoots: readonly string[]
} {
  const fileCountThreshold = config.fileCountThreshold ?? DEFAULT_FILE_COUNT_THRESHOLD
  const byteThreshold = config.byteThreshold ?? DEFAULT_BYTE_THRESHOLD
  const measureEntryCap = config.measureEntryCap ?? DEFAULT_MEASURE_ENTRY_CAP
  const sessionRoots = config.sessionRoots ?? []
  assertBound('fileCountThreshold', fileCountThreshold, 0)
  assertBound('byteThreshold', byteThreshold, 0)
  assertBound('measureEntryCap', measureEntryCap, 1)
  for (const root of sessionRoots) {
    if (root.trim().length === 0 || !isAbsolute(root)) {
      throw new Error(`delete-guard: sessionRoots entries must be absolute paths, got ${JSON.stringify(root)}`)
    }
  }
  return {
    fileCountThreshold,
    byteThreshold,
    measureEntryCap,
    sessionRoots: sessionRoots.map(root => resolve(root)),
  }
}

function assertBound(name: string, value: number, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`delete-guard: ${name} must be a safe integer >= ${minimum}, got ${JSON.stringify(value)}`)
  }
}

function readCommand(exec: ToolExecution): { text: string; kind: 'shell' | 'code'; workdir?: string } | undefined {
  const args = exec.arguments
  if (typeof args !== 'object' || args === null) return undefined
  const workdir = readString(args, 'workdir')
  if (SHELL_COMMAND.has(exec.name)) {
    const text = readString(args, 'command')
    return text === undefined ? undefined : { text, kind: 'shell', ...workdir !== undefined ? { workdir } : {} }
  }
  if (SHELL_TEXT.has(exec.name)) {
    const text = readString(args, 'text')
    return text === undefined ? undefined : { text, kind: 'shell' }
  }
  if (CODE_TEXT.has(exec.name)) {
    const text = readString(args, 'code')
    return text === undefined ? undefined : { text, kind: 'code' }
  }
  return undefined
}

function readString(value: object, key: string): string | undefined {
  if (!Object.hasOwn(value, key)) return undefined
  const found: unknown = Object.getOwnPropertyDescriptor(value, key)?.value
  return typeof found === 'string' ? found : undefined
}

function sessionRootsOf(ctx: Context): readonly string[] {
  return ctx.get('sessionPersistence')?.sessionStorageRoots() ?? []
}

function sessionWorkspace(ctx: Context, exec: ToolExecution): string | undefined {
  const session = exec.agent?.session
  if (session === undefined) return undefined
  return ctx.get('workingDirectory')?.get(session) ?? session.header.cwd
}

function pathBaseOf(workspace: string | undefined, workdir: string | undefined): string | undefined {
  if (workdir === undefined || workdir.trim().length === 0) return workspace
  if (isAbsolute(workdir)) return workdir
  if (workspace === undefined) return undefined
  return resolve(workspace, workdir)
}

function confirmationMode(ctx: Context, exec: ToolExecution): 'ask' | 'never' | 'channel' {
  const agent = exec.agent
  const approval = ctx.get('approval')
  if (agent === undefined || approval === undefined) return 'channel'
  const policy = approval.overrideOf(agent.session) ?? approval.config.policy ?? 'ask'
  return policy === 'never' ? 'never' : 'ask'
}

export type { DeleteImpact }
