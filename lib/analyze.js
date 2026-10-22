/**
 * Delete-command analysis: turn a shell command line into the set of paths it
 * would remove, and measure how many bytes those paths hold right now.
 *
 * Best effort by design. Anything this module cannot resolve is reported as
 * unknown instead of silently counting zero, so the guard can tell a measured
 * deletion apart from an opaque one.
 */
import { lstatSync, readdirSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'

const DELETE_VERBS = new Set([
  'rm', 'rmdir', 'unlink', 'shred', 'srm', 'del', 'erase', 'rd', 'deltree',
  'remove-item', 'ri', 'clear-content', 'clc',
])

const PREFIX_WORDS = new Set(['sudo', 'doas', 'env', 'time', 'nice', 'command', 'exec', '&', 'start-process'])

const MEASURE_BUDGET_MS = 4000
const MAX_NODES = 120000

/** Split a command line into simple commands, respecting quotes. */
function splitSegments(command) {
  const segments = []
  let buffer = ''
  let quote = ''
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]
    if (quote) {
      buffer += ch
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      buffer += ch
      continue
    }
    const two = command.slice(i, i + 2)
    if (two === '&&' || two === '||') {
      segments.push(buffer)
      buffer = ''
      i += 1
      continue
    }
    if (ch === ';' || ch === '|' || ch === '\n' || ch === '\r') {
      segments.push(buffer)
      buffer = ''
      continue
    }
    buffer += ch
  }
  segments.push(buffer)
  return segments.map((segment) => segment.trim()).filter(Boolean)
}

/** Quote-aware whitespace tokenizer. */
function tokenize(segment) {
  const tokens = []
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g
  let match
  while ((match = pattern.exec(segment)) !== null) {
    if (match[1] !== undefined) tokens.push({ text: match[1], quoted: true })
    else if (match[2] !== undefined) tokens.push({ text: match[2], quoted: true })
    else tokens.push({ text: match[3], quoted: false })
  }
  return tokens
}

function normalizeVerb(token) {
  let text = String(token).toLowerCase()
  text = text.replace(/^.*[\\/]/, '')
  text = text.replace(/\.(exe|cmd|bat|ps1)$/, '')
  return text
}

function splitCommas(value) {
  if (!value.includes(',')) return [value]
  return value.split(',').map((part) => part.trim()).filter(Boolean)
}

/** Collect delete operations declared by one simple command. */
function collectSegment(segment, sink) {
  const tokens = tokenize(segment)
  if (tokens.length === 0) return
  let index = 0
  while (index < tokens.length && PREFIX_WORDS.has(normalizeVerb(tokens[index].text))) index += 1
  if (index >= tokens.length) return
  const verb = normalizeVerb(tokens[index].text)

  if (verb === 'find' && tokens.some((token) => token.text === '-delete')) {
    const targets = []
    for (let i = index + 1; i < tokens.length; i += 1) {
      const text = tokens[i].text
      if (text === '-delete') break
      if (text.startsWith('-') || text.startsWith('(')) continue
      targets.push(text)
    }
    for (const target of targets.length > 0 ? targets : ['.']) sink.push({ path: target, recursive: true, source: 'find -delete' })
    return
  }

  if (verb === 'git' && tokens[index + 1] && normalizeVerb(tokens[index + 1].text) === 'clean') {
    sink.push({ path: '.', recursive: true, source: 'git clean' })
    return
  }

  if (!DELETE_VERBS.has(verb)) return

  let recursive = false
  let expectPath = false
  const paths = []
  for (let i = index + 1; i < tokens.length; i += 1) {
    const raw = tokens[i].text
    if (expectPath) {
      paths.push(...splitCommas(raw))
      expectPath = false
      continue
    }
    if (!tokens[i].quoted && raw.startsWith('-') && raw.length > 1) {
      const flag = raw.replace(/^-+/, '').toLowerCase()
      if (/^(path|literalpath|lp|pspath)$/.test(flag)) expectPath = true
      else if (/^(r|re|rec|recursive|rf|fr|force)$/.test(flag)) recursive = true
      else if (/^[a-z]*r[a-z]*$/.test(flag) && !/^(force|f|quiet|q|verbose|v|whatif|wi|confirm|cf)$/.test(flag)) recursive = true
      continue
    }
    if (!tokens[i].quoted && raw.startsWith('/') && raw.length <= 2) continue
    paths.push(...splitCommas(raw))
  }
  if (paths.length === 0) {
    sink.push({ path: undefined, recursive, source: verb })
    return
  }
  for (const path of paths) sink.push({ path, recursive, source: verb })
}

/** Script-level deletions: fs.rmSync('x'), rimraf('x'), shutil.rmtree('x'), os.remove('x'). */
function collectScriptOps(command, sink) {
  const pattern = /(?:\.(?:rmSync|rm|unlinkSync|unlink|rmdirSync|rmdir)|rimraf(?:Sync)?|shutil\.rmtree|os\.(?:remove|unlink)|deno\.remove(?:Sync)?)\s*\(\s*(['"])([^'"]*)\1/g
  let match
  while ((match = pattern.exec(command)) !== null) {
    sink.push({ path: match[2], recursive: true, source: 'script call' })
  }
}

function expandVariables(raw) {
  let value = raw
  value = value.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (whole, name) => {
    const found = process.env[name] ?? process.env[name.toUpperCase()]
    return found === undefined ? whole : found
  })
  value = value.replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (whole, name) => {
    const found = process.env[name] ?? process.env[name.toUpperCase()]
    return found === undefined ? whole : found
  })
  value = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, a, b) => {
    const name = a ?? b
    const found = process.env[name]
    return found === undefined ? whole : found
  })
  return value
}

function hasWildcard(value) {
  return value.includes('*') || value.includes('?')
}

function normalizeSlashes(value) {
  return value.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
}

function globToRegExp(pattern) {
  let out = '^'
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*'
        i += 1
      } else out += '[^\\\\/]*'
      continue
    }
    if (ch === '?') {
      out += '[^\\\\/]'
      continue
    }
    out += ch.replace(/[.*+^$@@{@@}()|[\]]/g, '\\$&')
  }
  out += '$'
  return new RegExp(out, 'i')
}

function globBase(pattern) {
  const normalized = pattern.replace(/\//g, '\\')
  const parts = normalized.split('\\')
  const base = []
  for (const part of parts.slice(0, -1)) {
    if (hasWildcard(part)) break
    base.push(part)
  }
  const joined = base.join('\\')
  return joined === '' ? '.' : joined
}

/** Expand a wildcard path into concrete existing paths. */
function expandGlob(pattern, budget) {
  const results = []
  const matcher = globToRegExp(normalizeSlashes(pattern))
  const stack = [resolve(globBase(pattern))]
  while (stack.length > 0) {
    if (budget.nodes > MAX_NODES || Date.now() > budget.deadline) {
      budget.truncated = true
      break
    }
    const current = stack.pop()
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    budget.nodes += entries.length
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (matcher.test(normalizeSlashes(full))) results.push(full)
      if (entry.isDirectory() && !entry.isSymbolicLink()) stack.push(full)
    }
  }
  return results
}

/** Sum the bytes a path holds right now, walking directories iteratively. */
function measure(target, budget) {
  let stats
  try {
    stats = lstatSync(target)
  } catch {
    return null
  }
  if (stats.isSymbolicLink()) return { bytes: 0, files: 0, path: target }
  if (stats.isFile()) return { bytes: stats.size, files: 1, path: target }
  if (!stats.isDirectory()) return { bytes: 0, files: 0, path: target }
  let bytes = 0
  let files = 0
  const stack = [target]
  while (stack.length > 0) {
    if (budget.nodes > MAX_NODES || Date.now() > budget.deadline) {
      budget.truncated = true
      break
    }
    const current = stack.pop()
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    budget.nodes += entries.length
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        stack.push(full)
        files += 1
        continue
      }
      try {
        const fileStats = lstatSync(full)
        if (fileStats.isFile()) {
          bytes += fileStats.size
          files += 1
        }
      } catch {
        /* vanished between listing and stat */
      }
    }
  }
  return { bytes, files, path: target }
}

/**
 * Analyze one command line.
 *
 * @param command - the raw command text a shell tool would execute.
 * @param options.cwd - directory relative paths resolve against.
 * @returns whether the command deletes, what it targets, and how many bytes.
 */
export function analyzeCommand(command, options = {}) {
  const cwd = options.cwd || process.cwd()
  const operations = []
  try {
    for (const segment of splitSegments(String(command ?? ''))) collectSegment(segment, operations)
    collectScriptOps(String(command ?? ''), operations)
  } catch {
    return { destructive: true, bytes: 0, files: 0, items: [], unknown: true, reason: 'command could not be parsed' }
  }
  if (operations.length === 0) return { destructive: false, bytes: 0, files: 0, items: [], unknown: false }

  const budget = { nodes: 0, deadline: Date.now() + MEASURE_BUDGET_MS, truncated: false }
  const items = []
  let unknown = operations.some((operation) => operation.path === undefined)
  let bytes = 0
  let files = 0
  let unresolved = 0

  for (const operation of operations) {
    if (operation.path === undefined) continue
    let raw = expandVariables(String(operation.path)).trim()
    if (raw === '') continue
    if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) raw = join(homedir(), raw.slice(1))
    const absolute = isAbsolute(raw) ? raw : resolve(cwd, raw)
    const targets = hasWildcard(absolute) ? expandGlob(absolute, budget) : [absolute]
    for (const target of targets) {
      const measured = measure(target, budget)
      if (measured === null) {
        unresolved += 1
        continue
      }
      bytes += measured.bytes
      files += measured.files
      items.push(measured)
    }
  }

  // Overlapping targets (a directory plus a file inside it) would double-count.
  const accepted = []
  for (const item of [...items].sort((a, b) => a.path.length - b.path.length)) {
    const pathValue = item.path.toLowerCase()
    const nested = accepted.some((other) => {
      const base = other.path.toLowerCase()
      return pathValue.startsWith(base + '\\') || pathValue.startsWith(base + '/')
    })
    if (nested) continue
    accepted.push(item)
  }
  items.length = 0
  items.push(...accepted)
  bytes = 0
  files = 0
  for (const item of items) {
    bytes += item.bytes
    files += item.files
  }

  if (budget.truncated) unknown = true
  if (!unknown && unresolved > 0 && items.length === 0) unknown = true
  return { destructive: true, bytes, files, items, unknown, reason: budget.truncated ? 'measurement truncated' : undefined }
}

/** Human-readable byte size used in dialogs and denial messages. */
export function formatBytes(value) {
  const size = Number(value) || 0
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let index = 0
  let scaled = Math.abs(size)
  while (scaled >= 1024 && index < units.length - 1) {
    scaled /= 1024
    index += 1
  }
  const sign = size < 0 ? '-' : ''
  return sign + (index === 0 ? String(Math.round(scaled)) : scaled.toFixed(1)) + ' ' + units[index]
}

export { dirname }