import { homedir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { charAt, isAbsolutePath, recognizeCodeDeletes, recognizeCommandDeletes, resolveAgainst, wordAt } from '../src/parse.ts'

describe('recognizeCommandDeletes', () => {
  it('recognizes recursive rm forms and leaves a single-file rm alone', () => {
    expect(recognizeCommandDeletes('rm -rf /tmp/tree', 'posix')).toEqual([
      { recursive: true, operands: [{ text: '/tmp/tree', unresolved: false }] },
    ])
    expect(recognizeCommandDeletes('rm -fr /tmp/tree', 'posix')[0]?.recursive).toBe(true)
    expect(recognizeCommandDeletes('/bin/rm --recursive /tmp/tree', 'posix')[0]?.recursive).toBe(true)
    expect(recognizeCommandDeletes('rm -f /tmp/one', 'posix')).toEqual([
      { recursive: false, operands: [{ text: '/tmp/one', unresolved: false }] },
    ])
    expect(recognizeCommandDeletes('rm -rf -- "-weird"', 'posix')[0]?.operands).toEqual([
      { text: '-weird', unresolved: false },
    ])
    expect(recognizeCommandDeletes('rm -rf "/tmp/my dir"', 'posix')[0]?.operands[0]?.text).toBe('/tmp/my dir')
    expect(recognizeCommandDeletes('rm -rf /tmp/my\\ dir', 'posix')[0]?.operands[0]?.text).toBe('/tmp/my dir')
  })

  it('does not treat an echoed command as a delete', () => {
    expect(recognizeCommandDeletes('echo rm -rf /tmp/tree', 'posix')).toEqual([])
    expect(recognizeCommandDeletes('git status', 'posix')).toEqual([])
    expect(recognizeCommandDeletes('git clean -f', 'posix')).toEqual([])
  })

  it('keeps expansions unresolved and resolves a prior absolute cd', () => {
    expect(recognizeCommandDeletes('rm -rf "$DIR"', 'posix')[0]?.operands).toEqual([
      { text: '$DIR', unresolved: true },
    ])
    expect(recognizeCommandDeletes('rm -rf *', 'posix')[0]?.operands[0]?.unresolved).toBe(true)
    expect(recognizeCommandDeletes("rm -rf '~/.dsh'", 'posix')[0]?.operands[0]).toEqual({
      text: '~/.dsh', unresolved: false,
    })
    const moved = recognizeCommandDeletes('cd /tmp && rm -rf foo', 'posix')
    expect(moved).toEqual([
      { recursive: true, operands: [{ text: 'foo', unresolved: false }], cwd: { kind: 'path', path: '/tmp' } },
    ])
    expect(recognizeCommandDeletes('pushd /tmp && rm -rf foo', 'posix')[0]?.cwd).toEqual({ kind: 'unresolved' })
    expect(recognizeCommandDeletes('cd sub && rm -rf foo', 'posix')[0]?.cwd).toEqual({ kind: 'unresolved' })
  })

  it('recognizes find, git clean, launchers, and a nested shell', () => {
    expect(recognizeCommandDeletes('find /var/data -delete', 'posix')).toEqual([
      { recursive: true, operands: [{ text: '/var/data', unresolved: false }] },
    ])
    expect(recognizeCommandDeletes('find -delete', 'posix')[0]?.operands[0]?.text).toBe('.')
    expect(recognizeCommandDeletes('find /var -exec rm -rf {} +', 'posix')[0]?.recursive).toBe(true)
    expect(recognizeCommandDeletes('git clean -fdx', 'posix')[0]).toMatchObject({ recursive: true, operands: [{ text: '.' }] })
    expect(recognizeCommandDeletes('git clean --force --directory build', 'posix')[0]?.operands[0]?.text).toBe('build')
    expect(recognizeCommandDeletes('sudo -n rm -rf /tmp/tree', 'posix')[0]?.operands[0]?.text).toBe('/tmp/tree')
    expect(recognizeCommandDeletes('xargs -0 rm -rf /tmp/tree', 'posix')[0]?.recursive).toBe(true)
    expect(recognizeCommandDeletes('env FOO=1 rm -rf /tmp/tree', 'posix')[0]?.recursive).toBe(true)
    expect(recognizeCommandDeletes("bash -lc 'rm -rf /tmp/tree'", 'posix')[0]?.operands[0]?.text).toBe('/tmp/tree')
    expect(recognizeCommandDeletes('rimraf /tmp/tree', 'posix')[0]?.recursive).toBe(true)
    expect(recognizeCommandDeletes('unlink /tmp/one', 'posix')[0]?.recursive).toBe(false)
  })

  it('fails closed when shells are nested past the depth limit', () => {
    let command = 'rm -rf /tmp/tree'
    for (let depth = 0; depth < 6; depth += 1) command = `bash -c ${JSON.stringify(command)}`
    expect(recognizeCommandDeletes(command, 'posix')[0]?.operands[0]?.text).toBe('(nested command)')
  })

  it('recognizes PowerShell recursive deletes and directory changes', () => {
    expect(recognizeCommandDeletes('Remove-Item -Recurse -Force C:\\data', 'powershell')).toEqual([
      { recursive: true, operands: [{ text: 'C:\\data', unresolved: false }] },
    ])
    expect(recognizeCommandDeletes('rm -r -Path C:\\data', 'powershell')[0]?.recursive).toBe(true)
    expect(recognizeCommandDeletes('Remove-Item -Recurse:$false C:\\data', 'powershell')[0]?.recursive).toBe(false)
    expect(recognizeCommandDeletes('Set-Location C:\\data; Remove-Item -Recurse item', 'powershell')[0]?.cwd).toEqual({ kind: 'path', path: 'C:\\data' })
    expect(recognizeCommandDeletes('Set-Location /data; Remove-Item -Recurse item', 'powershell')[0]?.cwd).toEqual({ kind: 'path', path: '/data' })
    expect(recognizeCommandDeletes('Push-Location C:\\data; Remove-Item -Recurse item', 'powershell')[0]?.cwd).toEqual({ kind: 'unresolved' })
  })

  it('reads interpreter one-liners', () => {
    const node = recognizeCommandDeletes('node -e \'fs.rmSync("/tmp/tree", { recursive: true })\'', 'posix')
    expect(node.some(deleteCommand => deleteCommand.recursive && deleteCommand.operands[0]?.text === '/tmp/tree')).toBe(true)
    const python = recognizeCommandDeletes('python3 -c \'import shutil; shutil.rmtree("/tmp/tree")\'', 'posix')
    expect(python.some(deleteCommand => deleteCommand.recursive && deleteCommand.operands[0]?.text === '/tmp/tree')).toBe(true)
  })
})

describe('indexed reads', () => {
  it('returns the entry or an empty stand-in', () => {
    expect(wordAt([{ text: 'rm', unresolved: false }], 0)).toEqual({ text: 'rm', unresolved: false })
    expect(wordAt([], 0)).toEqual({ text: '', unresolved: true })
    expect(charAt('ab', 0)).toBe('a')
    expect(charAt('ab', 5)).toBe('')
  })
})

describe('path resolution', () => {
  it('keeps a Windows drive path absolute on POSIX and joins a relative tail', () => {
    expect(isAbsolutePath('C:\\data')).toBe(true)
    expect(isAbsolutePath('rel')).toBe(false)
    expect(resolveAgainst(undefined, 'rel')).toBeUndefined()
    expect(resolveAgainst('/tmp', 'child')).toBe('/tmp/child')
    const joined = resolveAgainst('C:\\data', 'item')
    if (process.platform === 'win32') expect(joined?.toLowerCase()).toContain('item')
    else expect(joined).toBe('C:\\data\\item')
    expect(resolveAgainst('C:/data', 'item')).toBe(process.platform === 'win32' ? resolveAgainst('C:/data', 'item') : 'C:/data/item')
  })
})

describe('command edges', () => {
  it('covers directory changes, empty deletes, and quoted literals', () => {
    expect(recognizeCommandDeletes('cd && rm -rf foo', 'posix')[0]?.cwd).toEqual({ kind: 'path', path: homedir() })
    expect(recognizeCommandDeletes('cd - && rm -rf foo', 'posix')[0]?.cwd).toEqual({ kind: 'unresolved' })
    expect(recognizeCommandDeletes('cd /tmp && cd sub && rm -rf foo', 'posix')[0]?.cwd).toEqual({ kind: 'path', path: '/tmp/sub' })
    expect(recognizeCommandDeletes('rm', 'posix')).toEqual([])
    expect(recognizeCommandDeletes('rm -rf', 'posix')).toEqual([])
    expect(recognizeCommandDeletes('bash -c', 'posix')).toEqual([])
    expect(recognizeCommandDeletes('find /tmp -name x', 'posix')).toEqual([])
    expect(recognizeCommandDeletes('git clean', 'posix')).toEqual([])
    expect(recognizeCommandDeletes("rm -rf '$DIR'", 'posix')[0]?.operands[0]?.unresolved).toBe(false)
    expect(recognizeCommandDeletes('rm -rf ~user/tree', 'posix')[0]?.operands[0]?.unresolved).toBe(true)
    expect(recognizeCommandDeletes('rmdir /tmp/empty', 'posix')[0]?.recursive).toBe(false)
    expect(recognizeCommandDeletes('node script.js', 'posix')).toEqual([])
    expect(recognizeCommandDeletes('rm -rf a | rm -f b', 'posix')).toHaveLength(2)
    expect(recognizeCommandDeletes('sudo', 'posix')).toEqual([])
    expect(recognizeCommandDeletes('del -LiteralPath C:\\data', 'powershell')[0]?.operands[0]?.text).toBe('C:\\data')
    expect(recognizeCommandDeletes("rm -rf 'a b'", 'posix')[0]?.operands[0]?.text).toBe('a b')
    expect(recognizeCommandDeletes('&& rm -rf /tmp/a', 'posix')[0]?.operands[0]?.text).toBe('/tmp/a')
    expect(recognizeCommandDeletes('rm  -rf /tmp/a', 'posix')[0]?.operands[0]?.text).toBe('/tmp/a')
    expect(recognizeCommandDeletes('rm -rf /tmp/foo\\', 'posix')[0]?.operands[0]?.text).toBe('/tmp/foo\\')
    expect(recognizeCommandDeletes("bash --command 'rm -rf /tmp/a'", 'posix')[0]?.operands[0]?.text).toBe('/tmp/a')
    expect(recognizeCommandDeletes('rm -rf ""', 'posix')).toEqual([])
    expect(recognizeCommandDeletes('rimraf --glob', 'posix')).toEqual([])
    expect(recognizeCommandDeletes('rm --force /tmp/a', 'posix')[0]?.recursive).toBe(false)
    expect(recognizeCommandDeletes('find "" -delete', 'posix')[0]?.operands[0]?.text).toBe('.')
    expect(recognizeCommandDeletes('find /tmp -execdir rm {} +', 'posix')[0]?.recursive).toBe(true)
    expect(recognizeCommandDeletes('find /tmp -ok echo {} \\;', 'posix')).toEqual([])
    expect(recognizeCommandDeletes('find /tmp -exec echo {} +', 'posix')).toEqual([])
    expect(recognizeCommandDeletes('git clean -fd -- build', 'posix')[0]?.operands[0]?.text).toBe('build')
    expect(recognizeCommandDeletes('git clean --ignored --force', 'posix')[0]?.operands[0]?.text).toBe('.')
    expect(recognizeCommandDeletes('git clean --only-ignored -f', 'posix')[0]?.recursive).toBe(true)
    expect(recognizeCommandDeletes('git clean -fd ""', 'posix')[0]?.operands[0]?.text).toBe('.')
    expect(recognizeCommandDeletes('Remove-Item -Recurse:false C:\\data', 'powershell')[0]?.recursive).toBe(false)
    expect(recognizeCommandDeletes('Remove-Item -Recurse:$true C:\\data', 'powershell')[0]?.recursive).toBe(true)
    expect(recognizeCommandDeletes('Remove-Item -LiteralPath', 'powershell')).toEqual([])
    expect(recognizeCommandDeletes('Remove-Item -Force', 'powershell')).toEqual([])
    expect(recognizeCommandDeletes('cd ~ && rm -rf foo', 'posix')[0]?.cwd).toEqual({ kind: 'path', path: homedir() })
    expect(recognizeCommandDeletes('cd ~/sub && rm -rf foo', 'posix')[0]?.cwd).toEqual({ kind: 'path', path: `${homedir()}/sub` })
    expect(recognizeCommandDeletes('python3 --command "os.remove(\'a.txt\')"', 'posix').length).toBeGreaterThan(0)
    expect(recognizeCommandDeletes('bash -l echo hi', 'posix')).toEqual([])
    expect(recognizeCommandDeletes('git clean -x -f', 'posix')[0]?.recursive).toBe(true)
  })
})

describe('recognizeCodeDeletes', () => {
  it('marks a literal recursive remove and an unresolved unlink', () => {
    expect(recognizeCodeDeletes('fs.rmSync("/tmp/tree", { recursive: true })')).toEqual([
      { recursive: true, operands: [{ text: '/tmp/tree', unresolved: false }] },
    ])
    expect(recognizeCodeDeletes('fs.unlinkSync(target)')[0]).toEqual({
      recursive: false,
      operands: [{ text: '(code path)', unresolved: true }],
    })
    expect(recognizeCodeDeletes('shutil.rmtree(path)')[0]?.recursive).toBe(true)
    expect(recognizeCodeDeletes('os.remove("one.txt")')[0]?.recursive).toBe(false)
  })
})
