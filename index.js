/**
 * Delete Guard — stop the AI from wiping a disk by accident.
 *
 * Every shell-tool call whose command deletes files is measured before it runs.
 * The session keeps a running total of removed bytes; once a request would push
 * that total past the configured threshold (300 MB by default) the call is
 * terminated before it executes and the user is asked, in a dialog, what to do
 * with the list of files the AI already removed.
 */
import { analyzeCommand, formatBytes } from './lib/analyze.js'
import { readState, writeState, writeReport } from './lib/state.js'

export const name = 'delete-guard'
export const inject = ['tools']

const DEFAULTS = {
  enabled: true,
  limitBytes: 300 * 1024 * 1024,
  limitFiles: 0,
  tools: ['pwsh', 'bash'],
  askTimeoutSeconds: 180,
  reportTopFiles: 30,
  continueLabel: '继续删除（重置计数）',
  stopLabel: '停止并保持阻止（推荐）',
}

export function apply(ctx, rawConfig) {
  const provided = rawConfig && typeof rawConfig === 'object' ? rawConfig : {}
  const config = { ...DEFAULTS, ...provided }
  const limitBytes = Number(config.limitBytes) > 0 ? Number(config.limitBytes) : DEFAULTS.limitBytes
  const limitFiles = Number(config.limitFiles) > 0 ? Number(config.limitFiles) : 0
  const timeoutMs = Math.max(5, Number(config.askTimeoutSeconds) || DEFAULTS.askTimeoutSeconds) * 1000
  const watchedTools = new Set(Array.isArray(config.tools) && config.tools.length > 0 ? config.tools : DEFAULTS.tools)
  const charges = new Map()

  function log(level, message) {
    try {
      const logger = ctx.logger
      if (logger && typeof logger[level] === 'function') logger[level]('[delete-guard] ' + message)
    } catch {
      /* logging is never worth failing a tool call over */
    }
  }

  function sessionOf(exec) {
    return exec && exec.agent && exec.agent.session ? exec.agent.session.id : 'unbound'
  }

  function workingDirectoryOf(exec) {
    const args = exec && exec.arguments
    if (args && typeof args.workdir === 'string' && args.workdir.trim() !== '') return args.workdir
    try {
      const service = ctx.reflect.get('workingDirectory')
      if (service && exec.agent) return service.get(exec.agent.session)
    } catch {
      /* fall through */
    }
    return process.cwd()
  }

  function charge(exec, sessionId, state, plan) {
    const now = Date.now()
    state.usedBytes += plan.bytes
    state.deletedFiles += plan.files
    state.lifetimeBytes += plan.bytes
    if (plan.unknown) state.unmeasured += 1
    const added = []
    for (const item of plan.items.slice(0, 200)) {
      const entry = { path: item.path, bytes: item.bytes, at: now, tool: exec.name, callId: exec.callId }
      state.entries.push(entry)
      added.push(entry)
    }
    writeState(sessionId, state)
    charges.set(exec.token, { sessionId, bytes: plan.bytes, files: plan.files, entries: added, unknown: plan.unknown })
    if (charges.size > 500) charges.clear()
  }

  function refund(record) {
    const state = readState(record.sessionId)
    state.usedBytes = Math.max(0, state.usedBytes - record.bytes)
    state.lifetimeBytes = Math.max(0, state.lifetimeBytes - record.bytes)
    state.deletedFiles = Math.max(0, state.deletedFiles - record.files)
    if (record.unknown) state.unmeasured = Math.max(0, state.unmeasured - 1)
    if (record.entries.length > 0) {
      const drop = new Set(record.entries.map((entry) => entry.path + '@' + entry.at))
      state.entries = state.entries.filter((entry) => !drop.has(entry.path + '@' + entry.at))
    }
    writeState(record.sessionId, state)
  }

  function questionText(state, plan, reportPath, reason) {
    const total = formatBytes(state.usedBytes)
    const batch = formatBytes(plan.bytes)
    const ranked = [...state.entries]
      .filter((entry) => entry && typeof entry === 'object')
      .sort((a, b) => Number(b.bytes) - Number(a.bytes))
      .slice(0, Math.max(1, Number(config.reportTopFiles) || 30))
    const lines = [
      '删除保护已触发，本次删除在执行前被强制终止。',
      '',
      '已删除累计：' + total + '（上限 ' + formatBytes(limitBytes) + '），共 ' + state.deletedFiles + ' 个文件',
      '本次请求：' + batch + '，' + plan.files + ' 个文件' + (plan.unknown ? '（部分目标无法测量）' : ''),
      '触发原因：' + reason,
      '',
      'AI 已删除的文件（按体积排序，最多 ' + ranked.length + ' 条）：',
    ]
    if (ranked.length === 0) lines.push('（本次会话尚未记录到可测量的文件）')
    for (const entry of ranked) lines.push('- ' + formatBytes(entry.bytes) + '  ' + entry.path)
    if (reportPath) {
      lines.push('', '完整清单：' + reportPath)
    }
    lines.push('', '是否允许 AI 继续删除？选择“继续”会把本会话的删除计数清零并放行本次删除。')
    return lines.join('\n')
  }

  async function askUser(exec, sessionId, state, plan, reason) {
    const reportPath = writeReport(sessionId, state, plan, reason, Number(config.reportTopFiles) || 30)
    const service = (() => {
      try {
        return ctx.reflect.get('userQuestions')
      } catch {
        return undefined
      }
    })()
    if (!service) return { allow: false, detail: '用户确认界面不可用，已按停止处理' }
    if (!exec.agent) return { allow: false, detail: '调用没有关联会话，已按停止处理' }

    const question = {
      id: 'delete-guard',
      header: '删除保护已触发',
      question: questionText(state, plan, reportPath, reason),
      options: [
        { label: config.stopLabel, description: '拒绝本次删除，并在你再次确认前持续阻止新的删除。' },
        { label: config.continueLabel, description: '放行本次删除，并把本会话的累计删除量清零重新计算。' },
      ],
    }
    const request = { questions: [question], agent: exec.agent, signal: exec.signal }
    try {
      const answer = typeof service.askTimed === 'function'
        ? await service.askTimed(request, exec.callId, timeoutMs)
        : await service.ask(request)
      if (answer && answer.pending === true) return { allow: false, detail: '用户在限定时间内没有选择，已按停止处理' }
      const first = Array.isArray(answer && answer.answers) ? answer.answers[0] : undefined
      const chosen = []
      if (first && Array.isArray(first.selected)) chosen.push(...first.selected)
      if (first && typeof first.custom === 'string' && first.custom.trim() !== '') chosen.push(first.custom)
      const text = chosen.filter((value) => typeof value === 'string').join(' ')
      const allow = text.includes('继续') || text.includes(config.continueLabel)
      return { allow, detail: allow ? '用户选择继续删除' : ('用户选择停止' + (text ? '：' + text : '')) }
    } catch (error) {
      const message = error && error.message ? error.message : String(error)
      return { allow: false, detail: '用户未确认（' + message + '），已按停止处理' }
    }
  }

  function denialText(state, plan, decision, reportPath) {
    const lines = [
      '删除保护已触发：本会话累计删除 ' + formatBytes(state.usedBytes) + '，本次请求还要删除 ' + formatBytes(plan.bytes) +
        '（' + plan.files + ' 个文件），超过上限 ' + formatBytes(limitBytes) + '。本次删除已在执行前被强制终止。',
      '处置结果：' + decision.detail + '。',
    ]
    if (reportPath) lines.push('已删除文件清单：' + reportPath)
    const top = [...state.entries]
      .filter((entry) => entry && typeof entry === 'object')
      .sort((a, b) => Number(b.bytes) - Number(a.bytes))
      .slice(0, 8)
    if (top.length > 0) {
      lines.push('已删除（体积最大的几项）：')
      for (const entry of top) lines.push('- ' + formatBytes(entry.bytes) + '  ' + entry.path)
    }
    lines.push('把清单交给用户确认；在用户明确同意前不要重试删除，也不要换成别的命令绕过这个限制。')
    return lines.join('\n')
  }

  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!config.enabled) return next()
    if (!exec || !watchedTools.has(exec.name)) return next()
    const args = exec.arguments
    const command = args && typeof args.command === 'string' ? args.command : ''
    if (command.trim() === '') return next()

    let plan
    try {
      plan = analyzeCommand(command, { cwd: workingDirectoryOf(exec) })
    } catch (error) {
      log('warn', 'analysis failed: ' + (error && error.message ? error.message : error))
      return next()
    }
    if (!plan.destructive) return next()

    const sessionId = sessionOf(exec)
    const state = readState(sessionId)
    const now = Date.now()
    const exceedsBytes = state.usedBytes + plan.bytes > limitBytes
    const exceedsFiles = limitFiles > 0 && state.deletedFiles + plan.files > limitFiles
    const cooling = state.blocked === true && Number(state.blockedUntil) > now

    if (!state.blocked && !exceedsBytes && !exceedsFiles) {
      charge(exec, sessionId, state, plan)
      return next()
    }
    if (cooling) {
      return { kind: 'deny', reason: denialText(state, plan, { detail: '仍在阻止状态，稍后或在对话框中选择继续后才放行' }, '') }
    }

    const reason = state.blocked
      ? '此前已被用户阻止，本次需要重新确认才能继续删除'
      : exceedsBytes
        ? '累计删除 ' + formatBytes(state.usedBytes + plan.bytes) + ' 超过上限 ' + formatBytes(limitBytes)
        : '累计删除文件数 ' + (state.deletedFiles + plan.files) + ' 超过上限 ' + limitFiles
    const decision = await askUser(exec, sessionId, state, plan, reason)

    if (decision.allow) {
      state.usedBytes = 0
      state.deletedFiles = 0
      state.blocked = false
      state.blockedUntil = 0
      writeState(sessionId, state)
      charge(exec, sessionId, state, plan)
      log('info', 'user allowed deletion after guard triggered on session ' + sessionId)
      return next()
    }

    state.blocked = true
    state.blockedUntil = now + 15000
    writeState(sessionId, state)
    log('info', 'deletion terminated on session ' + sessionId + ': ' + decision.detail)
    return { kind: 'deny', reason: denialText(state, plan, decision, '') }
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const record = charges.get(exec.token)
    if (record === undefined) return next()
    charges.delete(exec.token)
    if (result && result.isError === true) refund(record)
    return next()
  })

  log('info', 'active: ' + formatBytes(limitBytes) + ' threshold, watching ' + [...watchedTools].join(', '))
}
