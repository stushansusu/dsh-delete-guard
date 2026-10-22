/**
 * Durable per-session bookkeeping for the delete guard: how many bytes the AI
 * has removed, which files, and whether the user has blocked further deletion.
 *
 * State lives outside the session log on purpose: it is a host-side safety
 * ledger, not model context.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { formatBytes } from './analyze.js'

const ENTRY_LIMIT = 2000
const STATE_VERSION = 1

function guardRoot() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'delete-guard')
}

function safeName(value) {
  return String(value || 'unbound').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
}

export function statePaths(sessionId) {
  const root = guardRoot()
  return {
    root,
    stateFile: join(root, 'state', safeName(sessionId) + '.json'),
    reportDir: join(root, 'reports'),
  }
}

function emptyState(sessionId) {
  return {
    version: STATE_VERSION,
    sessionId,
    usedBytes: 0,
    deletedFiles: 0,
    lifetimeBytes: 0,
    unmeasured: 0,
    blocked: false,
    blockedUntil: 0,
    entries: [],
    updatedAt: 0,
  }
}

export function readState(sessionId) {
  const base = emptyState(sessionId)
  const { stateFile } = statePaths(sessionId)
  try {
    if (!existsSync(stateFile)) return base
    const parsed = JSON.parse(readFileSync(stateFile, 'utf8'))
    if (!parsed || parsed.version !== STATE_VERSION) return base
    return {
      ...base,
      ...parsed,
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
    }
  } catch {
    return base
  }
}

export function writeState(sessionId, state) {
  const { stateFile } = statePaths(sessionId)
  try {
    mkdirSync(join(guardRoot(), 'state'), { recursive: true })
    const trimmed = {
      ...state,
      entries: state.entries.slice(-ENTRY_LIMIT),
      updatedAt: Date.now(),
    }
    const temporary = stateFile + '.tmp'
    writeFileSync(temporary, JSON.stringify(trimmed, null, 2), 'utf8')
    renameSync(temporary, stateFile)
    return trimmed
  } catch {
    return state
  }
}

/** Write the human-readable list of what the AI removed, and return its path. */
export function writeReport(sessionId, state, plan, detail, topFiles) {
  const { reportDir } = statePaths(sessionId)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = join(reportDir, safeName(sessionId) + '-' + stamp + '.md')
  const ranked = [...state.entries]
    .filter((entry) => typeof entry === 'object' && entry !== null)
    .sort((a, b) => Number(b.bytes) - Number(a.bytes))
    .slice(0, Math.max(1, topFiles))
  const lines = [
    '# 删除保护报告',
    '',
    '- 会话: ' + sessionId,
    '- 时间: ' + new Date().toLocaleString('zh-CN'),
    '- 累计已删除: ' + formatBytes(state.lifetimeBytes || state.usedBytes) + ' / ' + state.deletedFiles + ' 个文件',
    '- 本次请求: ' + formatBytes(plan.bytes) + ' / ' + plan.files + ' 个文件' + (plan.unknown ? '（部分目标无法测量）' : ''),
    '- 触发原因: ' + detail,
    '',
    '## 已删除文件（按体积排序，前 ' + ranked.length + ' 个）',
    '',
  ]
  for (const entry of ranked) {
    lines.push('- ' + formatBytes(entry.bytes) + '  ' + entry.path)
  }
  if (ranked.length === 0) lines.push('- （尚未记录到可测量的删除）')
  lines.push('')
  try {
    mkdirSync(reportDir, { recursive: true })
    writeFileSync(file, lines.join('\n'), 'utf8')
    return file
  } catch {
    return ''
  }
}

export { formatBytes }
