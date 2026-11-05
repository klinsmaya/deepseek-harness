import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PreToolDecision, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import ApprovalService, { setApprovalPolicy, type ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as DeleteGuard from '../src/index.ts'
import { DENY_CHANNEL_PREFIX, DENY_NEVER_PREFIX } from '../src/decide.ts'

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function temp(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function shellTool(name: 'bash' | 'pwsh' | 'terminal_send' | 'run_code' | 'echo', ran: { value: boolean }) {
  const commandKey = name === 'terminal_send' ? 'text' : name === 'run_code' ? 'code' : 'command'
  return defineTool({
    name,
    description: name,
    parameters: {
      [commandKey]: { type: 'string' },
      ...name === 'bash' || name === 'pwsh' ? { workdir: { type: 'string' } } : {},
    },
    output: {
      schema: { type: 'string' },
      render: () => [{ type: 'text', text: 'ran' }],
    },
    async execute() {
      ran.value = true
      return 'ran'
    },
  })
}

async function plain(): Promise<{ ctx: Context; ran: { value: boolean } }> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(DeleteGuard)
  const ran = { value: false }
  ctx.tools.register(shellTool('bash', ran))
  ctx.tools.register(shellTool('pwsh', ran))
  ctx.tools.register(shellTool('terminal_send', ran))
  ctx.tools.register(shellTool('echo', ran))
  return { ctx, ran }
}


function blockText(result: { readonly content: readonly { readonly type: string; readonly text?: string }[] }): string {
  const block = result.content[0]
  if (block === undefined || block.type !== 'text' || block.text === undefined) throw new Error('expected text block')
  return block.text
}

describe('delete-guard plugin', () => {
  it('runs an ordinary command and denies a recursive delete outside the workspace', async () => {
    const { ctx, ran } = await plain()
    const outside = await temp('dsh-delete-outside-')
    await writeFile(join(outside, 'a.txt'), 'abcd')
    const allowed = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('ls'),
      name: 'bash',
      arguments: { command: 'ls' },
    })
    expect(allowed.isError).toBe(false)
    expect(ran.value).toBe(true)
    ran.value = false
    const denied = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('rm'),
      name: 'bash',
      arguments: { command: `rm -rf ${outside}` },
    })
    expect(ran.value).toBe(false)
    expect(denied.isError).toBe(true)
    expect(blockText(denied)).toContain(DENY_CHANNEL_PREFIX)
    expect(blockText(denied)).toContain('1 files, 4 bytes')
    expect(blockText(denied)).toContain(outside)
  })

  it('allows a small in-workspace delete and denies one over the file threshold', async () => {
    const workspace = await temp('dsh-delete-work-')
    const small = join(workspace, 'small')
    await mkdir(small)
    await writeFile(join(small, 'a.txt'), 'x')
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([]))
    await ctx.plugin(DeleteGuard, { fileCountThreshold: 1 })
    const ran = { value: false }
    ctx.tools.register(shellTool('bash', ran))
    const agent = await ctx.agentLoop.create(SessionId('inside'), { provider: 'mock', model: 'mock' }, { cwd: workspace })
    const allowed = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('small'),
      name: 'bash',
      arguments: { command: 'rm -rf small' },
      agent,
    })
    expect(allowed.isError).toBe(false)
    expect(ran.value).toBe(true)
    await writeFile(join(small, 'b.txt'), 'y')
    ran.value = false
    const denied = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('big'),
      name: 'bash',
      arguments: { command: 'rm -rf small' },
      agent,
    })
    expect(ran.value).toBe(false)
    expect(denied.isError).toBe(true)
    expect(blockText(denied)).toContain('2 files')
  })

  it('denies under approval policy never and asks when the policy is ask', async () => {
    const outside = await temp('dsh-delete-ask-')
    await writeFile(join(outside, 'a.txt'), 'z')
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(ApprovalService)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([]))
    await ctx.plugin(DeleteGuard)
    const ran = { value: false }
    ctx.tools.register(shellTool('bash', ran))
    const agent = await ctx.agentLoop.create(SessionId('ask'), { provider: 'mock', model: 'mock' }, { cwd: await temp('dsh-delete-cwd-') })
    setApprovalPolicy(agent.session, 'never')
    const never = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('never'),
      name: 'bash',
      arguments: { command: `rm -rf ${outside}` },
      agent,
    })
    expect(ran.value).toBe(false)
    expect(blockText(never)).toContain(DENY_NEVER_PREFIX)
    setApprovalPolicy(agent.session, 'ask')
    agent.session.append('turn/start', { turn: 1 })
    let asked = ''
    ctx.on('approval/request', (request) => {
      asked = request.reason ?? ''
      return Promise.resolve<ApprovalOutcome>('allowed-once')
    })
    const allowed = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('ask'),
      name: 'bash',
      arguments: { command: `rm -rf ${outside}` },
      agent,
    })
    expect(asked).toContain(outside)
    expect(asked).toContain('1 files, 1 bytes')
    expect(allowed.isError).toBe(false)
    expect(ran.value).toBe(true)
  })

  it('keeps a later denial and reads session roots from persistence', async () => {
    const sessions = await temp('dsh-delete-sessions-')
    await writeFile(join(sessions, 'session.jsonl'), 'log')
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(DeleteGuard)
    ctx.on('tools/pre-execute', (): Promise<PreToolDecision> => Promise.resolve({ kind: 'deny', reason: 'later' }))
    const ran = { value: false }
    ctx.tools.register(shellTool('bash', ran))
    const later = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('later'),
      name: 'bash',
      arguments: { command: `rm -rf ${sessions}` },
    })
    expect(blockText(later)).toContain('later')
    expect(blockText(later)).not.toContain(DENY_CHANNEL_PREFIX)

    const persisted = new Context()
    contexts.push(persisted)
    await mountAgentLoopTestDependencies(persisted)
    await persisted.plugin(JsonlSessionPersistence, { root: sessions, compression: 'none' })
    await persisted.plugin(DeleteGuard, { fileCountThreshold: 100000, byteThreshold: 10 ** 12 })
    const persistedRan = { value: false }
    persisted.tools.register(shellTool('bash', persistedRan))
    const sessionFile = await persisted.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('session'),
      name: 'bash',
      arguments: { command: `rm ${join(sessions, 'session.jsonl')}` },
    })
    expect(persistedRan.value).toBe(false)
    expect(blockText(sessionFile)).toContain('session storage')
  })

  it('checks PowerShell, terminal input, run_code, and a workdir outside the workspace', async () => {
    const workspace = await temp('dsh-delete-base-')
    const other = await temp('dsh-delete-other-')
    await mkdir(join(other, 'tiny'))
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([]))
    await ctx.plugin(DeleteGuard)
    const ran = { value: false }
    ctx.tools.register(shellTool('bash', ran))
    ctx.tools.register(shellTool('pwsh', ran))
    ctx.tools.register(shellTool('terminal_send', ran))
    const agent = await ctx.agentLoop.create(SessionId('dirs'), { provider: 'mock', model: 'mock' }, { cwd: workspace })
    const workdir = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('workdir'),
      name: 'bash',
      arguments: { command: 'rm -rf tiny', workdir: other },
      agent,
    })
    expect(ran.value).toBe(false)
    expect(blockText(workdir)).toContain('outside workspace')
    const powershell = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('pwsh'),
      name: 'pwsh',
      arguments: { command: `Remove-Item -Recurse ${other}` },
      agent,
    })
    expect(powershell.isError).toBe(true)
    const terminal = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('term'),
      name: 'terminal_send',
      arguments: { text: `rm -rf ${other}` },
      agent,
    })
    expect(terminal.isError).toBe(true)
    const code = await ctx.waterfall('tools/pre-execute', {
      callId: ToolCallId('code'),
      rootCallId: ToolCallId('code'),
      name: 'run_code',
      arguments: { code: `fs.rmSync(${JSON.stringify(other)}, { recursive: true })` },
      signal: new AbortController().signal,
      token: Symbol('run-code') as ToolExecutionToken,
      agent,
    }, () => Promise.resolve({ kind: 'allow' as const }))
    expect(code.kind).toBe('deny')
    if (code.kind === 'deny') expect(code.reason).toContain(DENY_CHANNEL_PREFIX)
  })

  it('ignores a non-shell tool, a non-string command, and a relative workdir', async () => {
    const workspace = await temp('dsh-delete-rel-')
    const nested = join(workspace, 'nested')
    await mkdir(nested)
    await writeFile(join(nested, 'a.txt'), 'abcd')
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([]))
    const sessions = await temp('dsh-delete-extra-root-')
    await writeFile(join(sessions, 'session.jsonl'), 'log')
    await ctx.plugin(DeleteGuard, { sessionRoots: [sessions] })
    const ran = { value: false }
    ctx.tools.register(shellTool('bash', ran))
    ctx.tools.register(shellTool('echo', ran))
    const agent = await ctx.agentLoop.create(SessionId('rel'), { provider: 'mock', model: 'mock' }, { cwd: workspace })
    const echo = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('echo'),
      name: 'echo',
      arguments: { command: 'rm -rf /' },
      agent,
    })
    expect(echo.isError).toBe(false)
    const ignored = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('num'),
      name: 'bash',
      arguments: {},
      agent,
    })
    expect(ignored.isError).toBe(false)
    const relative = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('rel'),
      name: 'bash',
      arguments: { command: 'rm -rf .', workdir: 'nested' },
      agent,
    })
    expect(relative.isError).toBe(false)
    const blank = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('blank'),
      name: 'bash',
      arguments: { command: 'ls', workdir: '   ' },
      agent,
    })
    expect(blank.isError).toBe(false)
    const noAgent = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('no-agent'),
      name: 'bash',
      arguments: { command: 'rm -rf tiny', workdir: 'nested' },
    })
    expect(noAgent.isError).toBe(true)
    expect(blockText(noAgent)).toContain('size unavailable')
    const numeric = await ctx.waterfall('tools/pre-execute', {
      callId: ToolCallId('num'),
      rootCallId: ToolCallId('num'),
      name: 'bash',
      arguments: { command: 1, workdir: 2 },
      signal: new AbortController().signal,
      token: Symbol('numeric') as ToolExecutionToken,
      agent,
    }, () => Promise.resolve({ kind: 'allow' as const }))
    expect(numeric.kind).toBe('allow')
    const missingArgs = await ctx.waterfall('tools/pre-execute', {
      callId: ToolCallId('null'),
      rootCallId: ToolCallId('null'),
      name: 'bash',
      arguments: null,
      signal: new AbortController().signal,
      token: Symbol('null') as ToolExecutionToken,
    }, () => Promise.resolve({ kind: 'allow' as const }))
    expect(missingArgs.kind).toBe('allow')
    const stored = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('stored'),
      name: 'bash',
      arguments: { command: `rm ${join(sessions, 'session.jsonl')}` },
    })
    expect(stored.isError).toBe(true)
    expect(blockText(stored)).toContain('session storage')
    const terminal = await ctx.waterfall('tools/pre-execute', {
      callId: ToolCallId('term-empty'),
      rootCallId: ToolCallId('term-empty'),
      name: 'terminal_send',
      arguments: {},
      signal: new AbortController().signal,
      token: Symbol('terminal') as ToolExecutionToken,
      agent,
    }, () => Promise.resolve({ kind: 'allow' as const }))
    expect(terminal.kind).toBe('allow')
    const code = await ctx.waterfall('tools/pre-execute', {
      callId: ToolCallId('code-empty'),
      rootCallId: ToolCallId('code-empty'),
      name: 'run_code',
      arguments: {},
      signal: new AbortController().signal,
      token: Symbol('code') as ToolExecutionToken,
      agent,
    }, () => Promise.resolve({ kind: 'allow' as const }))
    expect(code.kind).toBe('allow')
  })

  it('asks when the approval service has no logged or configured policy', async () => {
    const outside = await temp('dsh-delete-default-ask-')
    await writeFile(join(outside, 'a.txt'), 'z')
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([]))
    new ApprovalService(ctx, {})
    await ctx.plugin(DeleteGuard)
    ctx.tools.register(shellTool('bash', { value: false }))
    const agent = await ctx.agentLoop.create(SessionId('default-ask'), { provider: 'mock', model: 'mock' }, { cwd: await temp('dsh-delete-default-cwd-') })
    agent.session.append('turn/start', { turn: 1 })
    let asked = false
    ctx.on('approval/request', () => {
      asked = true
      return Promise.resolve<ApprovalOutcome>('allowed-once')
    })
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('default-ask'),
      name: 'bash',
      arguments: { command: `rm -rf ${outside}` },
      agent,
    })
    expect(asked).toBe(true)
    expect(result.isError).toBe(false)
  })

  it('rejects a non-absolute session root and a fractional threshold', () => {
    const ctx = new Context()
    contexts.push(ctx)
    expect(() => { DeleteGuard.apply(ctx, { sessionRoots: ['relative'] }) }).toThrow(/absolute paths/)
    expect(() => { DeleteGuard.apply(ctx, { sessionRoots: [''] }) }).toThrow(/absolute paths/)
    expect(() => { DeleteGuard.apply(ctx, { fileCountThreshold: 1.5 }) }).toThrow(/fileCountThreshold/)
    expect(() => { DeleteGuard.apply(ctx, { measureEntryCap: 0 }) }).toThrow(/measureEntryCap/)
  })
})
