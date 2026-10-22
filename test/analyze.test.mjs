/**
 * Command-analysis tests. Run with: node --test test/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { analyzeCommand } = await import('../lib/analyze.js')

const root = mkdtempSync(join(tmpdir(), 'delete-guard-analyze-'))
mkdirSync(join(root, 'sub'))
writeFileSync(join(root, 'a.bin'), Buffer.alloc(1024))
writeFileSync(join(root, 'sub', 'b.bin'), Buffer.alloc(2048))
const q = (value) => '"' + value + '"'
const quoted = q(root)

test('detects rm -rf and measures recursively', () => {
  const plan = analyzeCommand('rm -rf ' + quoted, { cwd: '/' })
  assert.equal(plan.destructive, true)
  assert.equal(plan.bytes, 1024 + 2048)
  assert.equal(plan.unknown, false)
})

test('detects PowerShell Remove-Item with -LiteralPath', () => {
  const plan = analyzeCommand('Remove-Item -LiteralPath ' + quoted + ' -Recurse -Force', { cwd: '/' })
  assert.equal(plan.destructive, true)
  assert.equal(plan.bytes, 1024 + 2048)
})

test('detects cmd del with switches', () => {
  const plan = analyzeCommand('del /f /q ' + q(join(root, 'a.bin')), { cwd: '/' })
  assert.equal(plan.destructive, true)
  assert.equal(plan.bytes, 1024)
})

test('expands a wildcard target', () => {
  const plan = analyzeCommand('rm -rf ' + q(join(root, '*.bin')), { cwd: '/' })
  assert.equal(plan.destructive, true)
  assert.equal(plan.bytes, 1024)
})

test('does not double count a directory and a file inside it', () => {
  const plan = analyzeCommand('rm -rf ' + q(join(root, '*')), { cwd: '/' })
  assert.equal(plan.bytes, 1024 + 2048)
})

test('detects deletions hidden in a script call', () => {
  const plan = analyzeCommand('node -e "require(\'fs\').rmSync(' + quoted + ', {recursive:true})"', { cwd: '/' })
  assert.equal(plan.destructive, true)
  assert.equal(plan.bytes, 1024 + 2048)
})

test('detects git clean in the working directory', () => {
  const plan = analyzeCommand('git clean -fdx', { cwd: root })
  assert.equal(plan.destructive, true)
  assert.ok(plan.bytes >= 1024 + 2048)
})

test('leaves read-only commands alone', () => {
  assert.equal(analyzeCommand('Get-ChildItem -Recurse ' + quoted, { cwd: '/' }).destructive, false)
  assert.equal(analyzeCommand('echo hello', { cwd: '/' }).destructive, false)
})

test('marks unparseable targets instead of pretending they are empty', () => {
  const plan = analyzeCommand('Get-ChildItem -Recurse | Remove-Item', { cwd: '/' })
  assert.equal(plan.destructive, true)
  assert.equal(plan.unknown, true)
})

test.after(() => {
  rmSync(root, { recursive: true, force: true })
})
