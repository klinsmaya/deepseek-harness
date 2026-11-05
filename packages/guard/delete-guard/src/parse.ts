/**
 * Static recognition of delete commands in shell text and short programs.
 * Unresolved expansions stay unresolved so the caller can fail closed.
 * @module @deepseek-ai/dsh-delete-guard/parse
 */

import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'

/** One command operand after quote removal. */
export interface Operand {
  /** Operand text with quotes removed and backslash escapes applied. */
  readonly text: string
  /** True when the operand contains a glob or expansion this parser does not resolve. */
  readonly unresolved: boolean
}

/** A delete this parser recognized in one command or program. */
export interface RecognizedDelete {
  /** True when the command removes a directory tree rather than one file. */
  readonly recursive: boolean
  /** Path operands. Empty results are not returned. */
  readonly operands: readonly Operand[]
  /**
   * Directory set by an earlier `cd` in the same command string.
   * `unresolved` means a later relative path cannot be placed.
   * Omitted when the command should use the tool's working directory.
   */
  readonly cwd?: { readonly kind: 'path'; readonly path: string } | { readonly kind: 'unresolved' }
}

/**
 * Read one token, or an empty unresolved token when the index is past the end.
 * @param words - tokenized command words.
 * @param index - index to read.
 * @returns the word at `index`, or an empty unresolved word.
 */
export function wordAt(words: readonly Word[], index: number): Word {
  return words[index] ?? { text: '', unresolved: true }
}

/**
 * Read one character, or an empty string when the index is past the end.
 * @param input - source text.
 * @param index - index to read.
 * @returns the character, or `''`.
 */
export function charAt(input: string, index: number): string {
  return input[index] ?? ''
}

interface Word {
  readonly text: string
  readonly unresolved: boolean
}

type Cwd = { kind: 'inherit' } | { kind: 'path'; path: string } | { kind: 'unresolved' }

const LAUNCHERS = new Set(['sudo', 'command', 'exec', 'env', 'nice', 'nohup', 'stdbuf', 'ionice', 'time', 'xargs'])
const POSIX_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ash', 'ksh'])
const INTERPRETERS = new Set(['node', 'nodejs', 'python', 'python3', 'perl', 'ruby'])
const PWSH_DELETE = new Set(['remove-item', 'rm', 'del', 'ri', 'rd', 'rmdir', 'erase'])
const PWSH_CD = new Set(['cd', 'set-location', 'sl', 'chdir', 'push-location', 'pushd', 'pop-location', 'popd'])

/**
 * Recognize delete commands in a POSIX or PowerShell command string.
 * @param command - the raw command text.
 * @param shell - which command names and `cd` forms to read.
 * @returns one entry per recognized delete. Nested shells are included.
 */
export function recognizeCommandDeletes(command: string, shell: 'posix' | 'powershell'): RecognizedDelete[] {
  return walk(command, shell, 0, { kind: 'inherit' })
}

/**
 * Recognize filesystem deletes in JavaScript or Python source.
 * A string-literal path is kept; anything else stays unresolved.
 * @param code - program text, including one-liners passed to an interpreter.
 * @returns one entry per recognized call.
 */
export function recognizeCodeDeletes(code: string): RecognizedDelete[] {
  const found: RecognizedDelete[] = []
  const patterns: readonly { readonly source: RegExp; readonly recursive: boolean }[] = [
    { source: /\brmSync\s*\(/g, recursive: false },
    { source: /\brmdirSync\s*\(/g, recursive: false },
    { source: /\bunlinkSync\s*\(/g, recursive: false },
    { source: /\bfs\.rmdir\s*\(/g, recursive: false },
    { source: /\bfs\.promises\.rm\s*\(/g, recursive: false },
    { source: /\bfs\.rm\s*\(/g, recursive: false },
    { source: /\brmtree\s*\(/g, recursive: true },
    { source: /\bos\.remove\s*\(/g, recursive: false },
    { source: /\bos\.unlink\s*\(/g, recursive: false },
    { source: /\bos\.rmdir\s*\(/g, recursive: false },
  ]
  for (const pattern of patterns) {
    pattern.source.lastIndex = 0
    for (let match = pattern.source.exec(code); match !== null; match = pattern.source.exec(code)) {
      const window = code.slice(match.index, match.index + 180)
      const recursive = pattern.recursive || /recursive\s*[:=]\s*true/i.test(window)
      const literal = /(['"`])([^'"`]+)\1/.exec(window)
      const operand: Operand = literal?.[2] !== undefined
        ? { text: literal[2], unresolved: false }
        : { text: '(code path)', unresolved: true }
      found.push({ recursive, operands: [operand] })
    }
  }
  return found
}

function walk(command: string, shell: 'posix' | 'powershell', depth: number, cwd: Cwd): RecognizedDelete[] {
  if (depth > 4) {
    return [{ recursive: true, operands: [{ text: '(nested command)', unresolved: true }], cwd: 'unresolved' }]
  }
  const ignoreCase = shell === 'powershell'
  const found: RecognizedDelete[] = []
  let current = cwd
  for (const segment of splitSegments(command)) {
    const peeled = peelLaunchers(tokenize(segment, shell === 'powershell'), ignoreCase)
    if (peeled.length === 0) continue
    if (isDirectoryChange(peeled, shell)) {
      current = nextCwd(peeled, current)
      continue
    }
    const script = nestedScript(peeled)
    if (script !== undefined) {
      found.push(...walk(script, 'posix', depth + 1, current))
      continue
    }
    const code = interpreterCode(peeled, ignoreCase)
    if (code !== undefined) {
      found.push(...recognizeCodeDeletes(code).map(deleteCommand => withCwd(deleteCommand, current)))
      found.push(...walk(code, 'posix', depth + 1, current))
      continue
    }
    const parsed = shell === 'posix' ? parsePosix(peeled) : parsePowershell(peeled)
    if (parsed !== undefined) found.push(withCwd(parsed, current))
  }
  return found
}

function withCwd(parsed: RecognizedDelete, cwd: Cwd): RecognizedDelete {
  if (cwd.kind === 'path') return { ...parsed, cwd: { kind: 'path', path: cwd.path } }
  if (cwd.kind === 'unresolved') return { ...parsed, cwd: { kind: 'unresolved' } }
  return parsed
}

function splitSegments(input: string): string[] {
  const parts: string[] = []
  let quote: '"' | "'" | undefined
  let start = 0
  const push = (end: number): void => {
    const part = input.slice(start, end).trim()
    if (part.length > 0) parts.push(part)
  }
  for (let index = 0; index < input.length; index += 1) {
    const ch = charAt(input, index)
    if (ch === '\\' && quote !== "'") {
      index += 1
      continue
    }
    if (quote === undefined && (ch === '"' || ch === "'")) {
      quote = ch
      continue
    }
    if (quote === ch) {
      quote = undefined
      continue
    }
    if (quote !== undefined) continue
    if (ch === '\n' || ch === '\r' || ch === ';') {
      push(index)
      start = index + 1
      continue
    }
    const pair = input.slice(index, index + 2)
    if (pair === '&&' || pair === '||') {
      push(index)
      index += 1
      start = index + 1
      continue
    }
    if (ch === '|' || ch === '&') {
      push(index)
      start = index + 1
    }
  }
  push(input.length)
  return parts
}

function tokenize(input: string, preserveBackslash: boolean): Word[] {
  const words: Word[] = []
  let text = ''
  let unresolved = false
  let quote: '"' | "'" | undefined
  let started = false
  const flush = (): void => {
    if (!started) return
    words.push({ text, unresolved })
    text = ''
    unresolved = false
    started = false
  }
  for (let index = 0; index < input.length; index += 1) {
    const ch = charAt(input, index)
    if (quote === undefined && (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r')) {
      flush()
      continue
    }
    if (!preserveBackslash && ch === '\\' && quote !== "'") {
      const next = input[index + 1]
      started = true
      if (next === undefined) text += ch
      else {
        index += 1
        text += next
      }
      continue
    }
    if (quote === undefined && (ch === '"' || ch === "'")) {
      quote = ch
      started = true
      continue
    }
    if (quote === ch) {
      quote = undefined
      started = true
      continue
    }
    if (quote !== "'") {
      if (ch === '$' || ch === '`') unresolved = true
      if (quote === undefined && (ch === '*' || ch === '?' || ch === '[')) unresolved = true
      const next = input[index + 1]
      if (quote === undefined && ch === '~' && text.length === 0 && next !== undefined && next !== '/' && next !== ' ' && next !== '\t') {
        unresolved = true
      }
    }
    started = true
    text += ch
  }
  flush()
  return words
}

function peelLaunchers(words: readonly Word[], ignoreCase: boolean): Word[] {
  let rest = words
  for (let guard = 0; guard < 6 && rest.length > 0; guard += 1) {
    if (!LAUNCHERS.has(baseName(wordAt(rest, 0).text, ignoreCase))) break
    let index = 1
    while (index < rest.length) {
      const word = wordAt(rest, index)
      if (word.text.startsWith('-') || word.text.includes('=')) {
        index += 1
        continue
      }
      break
    }
    rest = rest.slice(index)
  }
  return [...rest]
}

function isDirectoryChange(words: readonly Word[], shell: 'posix' | 'powershell'): boolean {
  const name = baseName(wordAt(words, 0).text, shell === 'powershell')
  if (shell === 'powershell' && PWSH_CD.has(name)) return true
  return shell === 'posix' && (name === 'cd' || name === 'pushd' || name === 'popd')
}

function nextCwd(words: readonly Word[], current: Cwd): Cwd {
  const name = baseName(wordAt(words, 0).text, true)
  if (name === 'pushd' || name === 'popd' || name === 'push-location' || name === 'pop-location') return { kind: 'unresolved' }
  const operand = words[1]
  if (operand === undefined) return { kind: 'path', path: homedir() }
  if (operand.unresolved || operand.text === '-' || operand.text.length === 0) return { kind: 'unresolved' }
  const expanded = expandTilde(operand.text)
  const base = current.kind === 'path' ? current.path : undefined
  const resolved = resolveAgainst(base, expanded)
  if (resolved === undefined) return { kind: 'unresolved' }
  return { kind: 'path', path: resolved }
}

function nestedScript(words: readonly Word[]): string | undefined {
  if (!POSIX_SHELLS.has(baseName(wordAt(words, 0).text, true))) return undefined
  for (let index = 1; index < words.length; index += 1) {
    const word = wordAt(words, index)
    if (word.text === '-c' || word.text === '--command') return words[index + 1]?.text
    if (word.text.startsWith('-') && !word.text.startsWith('--') && word.text.includes('c')) return words[index + 1]?.text
  }
  return undefined
}

function interpreterCode(words: readonly Word[], ignoreCase: boolean): string | undefined {
  if (!INTERPRETERS.has(baseName(wordAt(words, 0).text, ignoreCase))) return undefined
  for (let index = 1; index < words.length; index += 1) {
    const word = wordAt(words, index)
    if (word.text === '-e' || word.text === '--eval' || word.text === '-c' || word.text === '--command') {
      return words[index + 1]?.text
    }
  }
  return undefined
}

function parsePosix(words: readonly Word[]): RecognizedDelete | undefined {
  const name = baseName(wordAt(words, 0).text, false)
  if (name === 'rm') return parseRm(words, true)
  if (name === 'unlink' || name === 'rmdir') return parseRm(words, false)
  if (name === 'rimraf') return parseOperands(words, true)
  if (name === 'find') return parseFind(words)
  if (name === 'git') return parseGitClean(words)
  return undefined
}

function parseRm(words: readonly Word[], honorRecursive: boolean): RecognizedDelete | undefined {
  let recursive = false
  let options = true
  const operands: Operand[] = []
  for (const word of words.slice(1)) {
    if (options && word.text === '--') {
      options = false
      continue
    }
    if (options && word.text.startsWith('-') && word.text.length > 1) {
      if (honorRecursive && recursiveFlag(word.text)) recursive = true
      continue
    }
    if (word.text.length === 0) continue
    operands.push(word)
  }
  if (operands.length === 0) return undefined
  return { recursive, operands }
}

function parseOperands(words: readonly Word[], recursive: boolean): RecognizedDelete | undefined {
  const operands = words.slice(1).filter(word => word.text.length > 0 && !word.text.startsWith('-'))
  if (operands.length === 0) return undefined
  return { recursive, operands }
}

function recursiveFlag(text: string): boolean {
  if (text === '--recursive' || text === '--dir') return true
  if (text.startsWith('--')) return false
  return text.includes('r') || text.includes('R')
}

function parseFind(words: readonly Word[]): RecognizedDelete | undefined {
  const paths: Operand[] = []
  let index = 1
  while (index < words.length && !wordAt(words, index).text.startsWith('-')) {
    if (wordAt(words, index).text.length > 0) paths.push(wordAt(words, index))
    index += 1
  }
  let removes = false
  for (; index < words.length; index += 1) {
    const text = wordAt(words, index).text
    if (text === '-delete') removes = true
    if ((text === '-exec' || text === '-execdir' || text === '-ok') && index + 1 < words.length) {
      const command = baseName(wordAt(words, index + 1).text, false)
      if (command === 'rm' || command === 'unlink' || command === 'rmdir') removes = true
    }
  }
  if (!removes) return undefined
  return { recursive: true, operands: paths.length > 0 ? paths : [{ text: '.', unresolved: false }] }
}

function parseGitClean(words: readonly Word[]): RecognizedDelete | undefined {
  if (words[1]?.text !== 'clean') return undefined
  let force = false
  let directories = false
  const operands: Operand[] = []
  for (const word of words.slice(2)) {
    if (word.text === '--') continue
    if (word.text.startsWith('-')) {
      if (word.text === '--force') force = true
      if (word.text === '--directory' || word.text === '--ignored' || word.text === '--only-ignored') directories = true
      if (!word.text.startsWith('--')) {
        if (word.text.includes('f')) force = true
        if (word.text.includes('d') || word.text.includes('x') || word.text.includes('X')) directories = true
      }
      continue
    }
    if (word.text.length > 0) operands.push(word)
  }
  if (!force || !directories) return undefined
  return { recursive: true, operands: operands.length > 0 ? operands : [{ text: '.', unresolved: false }] }
}

function parsePowershell(words: readonly Word[]): RecognizedDelete | undefined {
  const name = baseName(wordAt(words, 0).text, true)
  if (!PWSH_DELETE.has(name)) return undefined
  let recursive = false
  const operands: Operand[] = []
  for (let index = 1; index < words.length; index += 1) {
    const word = wordAt(words, index)
    const lower = word.text.toLowerCase()
    if (lower === '-recurse' || lower === '-recursive' || lower === '-r') {
      recursive = true
      continue
    }
    if (lower.startsWith('-recurse:') || lower.startsWith('-recursive:') || lower.startsWith('-r:')) {
      if (!lower.endsWith(':false') && !lower.endsWith(':$false')) recursive = true
      continue
    }
    if (lower === '-path' || lower === '-literalpath') {
      const next = words[index + 1]
      if (next !== undefined && next.text.length > 0) operands.push(next)
      index += 1
      continue
    }
    if (word.text.startsWith('-') || word.text.length === 0) continue
    operands.push(word)
  }
  if (operands.length === 0) return undefined
  return { recursive, operands }
}

function baseName(text: string, ignoreCase: boolean): string {
  const slash = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'))
  const base = slash >= 0 ? text.slice(slash + 1) : text
  return ignoreCase ? base.toLowerCase() : base
}

/**
 * True for a POSIX absolute path or a Windows drive path.
 * @param text - a path operand.
 * @returns whether the operand does not need a base directory.
 */
export function isAbsolutePath(text: string): boolean {
  return isAbsolute(text) || /^[A-Za-z]:[\\/]/.test(text)
}

/**
 * Resolve `text` against `base`. A Windows drive path is preserved on POSIX.
 * @param base - absolute directory for a relative operand.
 * @param text - operand text, with a leading tilde already expanded.
 * @returns the absolute path, or `undefined` when a relative operand has no base.
 */
export function resolveAgainst(base: string | undefined, text: string): string | undefined {
  if (/^[A-Za-z]:[\\/]/.test(text) && !isAbsolute(text)) return text
  if (isAbsolute(text)) return resolve(text)
  if (base === undefined) return undefined
  if (/^[A-Za-z]:[\\/]/.test(base) && !isAbsolute(base)) {
    const separator = base.includes('/') ? '/' : '\\'
    return `${base.replace(/[\\/]+$/, '')}${separator}${text}`
  }
  return resolve(base, text)
}

function expandTilde(text: string): string {
  if (text === '~') return homedir()
  if (text.startsWith('~/')) return `${homedir()}/${text.slice(2)}`
  return text
}
