/**
 * Behaviour tests for the delete guard. Run with: node --test test/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'delete-guard-home-'))
const work = mkdtempSync(join(tmpdir(), 'delete-guard-work-'))
process.env.DSH_HOME = home

const { apply } = await import('../index.js')

const listeners = new Map()
let asked = []
let choice = ''

const fakeQuestions = {
  async askTimed(request) {
    asked.push(request)
    return { answers: [{ id: 'delete-guard', selected: [choice] }] }
  },
}

const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  on(event, handler) { listeners.set(event, handler) },
  reflect: {
    get(name) {
      if (name === 'userQuestions') return fakeQuestions
      if (name === 'workingDirectory') return { get: () => work }
      return undefined
    },
  },
}

apply(ctx, { limitBytes: 4 * 1024 * 1024, askTimeoutSeconds: 30 })

const session = { id: 'session-test' }
const stateFile = join(home, 'delete-guard', 'state', 'session-test.json')
const readState = () => JSON.parse(readFileSync(stateFile, 'utf8'))

function makeExec(command, token, isError = false) {
  return {
    exec: {
      name: 'pwsh',
      token,
      callId: 'call-' + token,
      agent: { session },
      signal: new AbortController().signal,
      arguments: { command },
    },
    isError,
  }
}

async function run(exec, isError = false) {
  let forwarded = false
  const decision = await listeners.get('tools/pre-execute')(exec, async () => {
    forwarded = true
    return { kind: 'allow' }
  })
  if (forwarded) {
    await listeners.get('tools/post-execute')(exec, { isError }, async () => ({ kind: 'accept' }))
  }
  return { decision, forwarded }
}

function makeFixtures(bytes) {
  const target = mkdtempSync(join(work, 'target-'))
  writeFileSync(join(target, 'payload.bin'), Buffer.alloc(bytes))
  return target
}

test('allows and charges a deletion under the threshold', async () => {
  const target = makeFixtures(1024 * 1024)
  const { exec } = makeExec('Remove-Item -LiteralPath "' + target + '" -Recurse -Force', 't1')
  const result = await run(exec)
  assert.equal(result.forwarded, true)
  assert.equal(readState().usedBytes, 1024 * 1024)
  assert.equal(readState().deletedFiles, 1)
})

test('terminates the call once the threshold would be exceeded and asks the user', async () => {
  choice = '停止并保持阻止（推荐）'
  const target = makeFixtures(4 * 1024 * 1024)
  const before = asked.length
  const { exec } = makeExec('Remove-Item -LiteralPath "' + target + '" -Recurse -Force', 't2')
  const result = await run(exec)
  assert.equal(result.forwarded, false)
  assert.equal(result.decision.kind, 'deny')
  assert.match(result.decision.reason, /强制终止/)
  assert.equal(asked.length, before + 1)
  assert.equal(asked.at(-1).questions[0].header, '删除保护已触发')
  assert.equal(readState().blocked, true)
})

test('denies without a second dialog during the cooldown window', async () => {
  const target = makeFixtures(1024 * 1024)
  const before = asked.length
  const { exec } = makeExec('rm -rf "' + target + '"', 't3')
  const result = await run(exec)
  assert.equal(result.forwarded, false)
  assert.equal(asked.length, before)
})

test('继续 resets the counter and lets the deletion through', async () => {
  const state = readState()
  state.blockedUntil = 0
  writeFileSync(stateFile, JSON.stringify(state))
  choice = '继续删除（重置计数）'
  const target = makeFixtures(2 * 1024 * 1024)
  const { exec } = makeExec('Remove-Item -LiteralPath "' + target + '" -Recurse -Force', 't4')
  const result = await run(exec)
  assert.equal(result.forwarded, true)
  const after = readState()
  assert.equal(after.blocked, false)
  assert.equal(after.usedBytes, 2 * 1024 * 1024)
})

test('refunds the charge when the tool call fails', async () => {
  const state = readState()
  state.blocked = false
  state.blockedUntil = 0
  writeFileSync(stateFile, JSON.stringify(state))
  const target = makeFixtures(1024 * 1024)
  const { exec } = makeExec('rm -rf "' + target + '"', 't5')
  const before = readState().usedBytes
  let forwarded = false
  await listeners.get('tools/pre-execute')(exec, async () => { forwarded = true; return { kind: 'allow' } })
  assert.equal(forwarded, true)
  await listeners.get('tools/post-execute')(exec, { isError: true }, async () => ({ kind: 'accept' }))
  assert.equal(readState().usedBytes, before)
})

test('ignores commands that do not delete anything', async () => {
  const target = makeFixtures(1024)
  const before = readState().usedBytes
  const { exec } = makeExec('Get-ChildItem -Recurse "' + target + '"', 't6')
  const result = await run(exec)
  assert.equal(result.forwarded, true)
  assert.equal(readState().usedBytes, before)
})

test.after(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(work, { recursive: true, force: true })
})
