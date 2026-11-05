/**
 * The default persistence seam reports no local session directory.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionPersistence } from '../src/index.ts'
import type { SessionAccess, SessionHandle, SessionPersistenceSnapshot } from '../src/index.ts'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'

class BarePersistence extends SessionPersistence {
  create(_header: SessionHeader): Promise<SessionHandle> {
    return Promise.reject(new Error('unused'))
  }

  open(_id: SessionId, _access: SessionAccess): Promise<SessionHandle> {
    return Promise.reject(new Error('unused'))
  }

  flush(): Promise<void> {
    return Promise.reject(new Error('unused'))
  }

  stat(): Promise<SessionPersistenceSnapshot | undefined> {
    return Promise.resolve(undefined)
  }

  list(): Promise<readonly SessionPersistenceSnapshot[]> {
    return Promise.resolve([])
  }
}

describe('sessionStorageRoots', () => {
  it('returns no directories for a backend that does not override the method', () => {
    const ctx = new Context()
    const persistence = new BarePersistence(ctx)
    expect(persistence.sessionStorageRoots()).toEqual([])
  })
})
