/** The JSONL backend reports its configured root as session storage. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'

let root: string | undefined
let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('sessionStorageRoots', () => {
  it('returns the absolute configured root', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-jsonl-roots-'))
    ctx = new Context()
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    expect(ctx.sessionPersistence.sessionStorageRoots()).toEqual([resolve(root)])
  })
})
