import test from 'node:test'
import assert from 'node:assert/strict'
import { mergePluginConfigs, sanitizeConfig, mergeValue, restoreDenied } from '../lib/plugin-configs.js'

test('sanitizeConfig 去掉机器相关与机密的键', () => {
  const input = {
    enabled: true,
    pythonPath: 'C:\\py\\python.exe',
    adbPath: 'C:\\adb.exe',
    nested: { workspace: 'D:\\work', keep: 1, token: 'x' },
    roles: [{ name: 'a', password: 'p' }],
  }
  const out = sanitizeConfig(input)
  assert.deepEqual(out, { enabled: true, nested: { keep: 1 }, roles: [{ name: 'a' }] })
  // 原对象不能被改
  assert.equal(input.nested.keep, 1)
})

test('mergeValue：只有一边改的 key 会被带过来', () => {
  const base = { a: 1, b: 2, c: { d: 3 } }
  const local = { a: 9, b: 2, c: { d: 3 } }
  const remote = { a: 1, b: 8, c: { d: 4 } }
  const result = mergeValue(local, base, remote)
  assert.deepEqual(result.value, { a: 9, b: 8, c: { d: 4 } })
  assert.deepEqual(result.conflicts, [])
})

test('mergeValue：两边改成不同的值 → 保留本地并报冲突', () => {
  const result = mergeValue({ x: 1 }, { x: 0 }, { x: 2 })
  assert.deepEqual(result.value, { x: 1 })
  assert.deepEqual(result.conflicts, ['x'])
})

test('mergePluginConfigs：按 entry 合并并给出要写的变更', () => {
  const local = {
    'agent-default-model': { name: 'agent-default-model', config: { provider: 'deepseek-account', model: 'deepseek-flash' } },
    'web': { name: 'web', config: { searchProvider: 'modsearch' } },
  }
  const base = {
    'agent-default-model': { config: { provider: 'deepseek-account', model: 'deepseek-flash' } },
    'web': { config: { searchProvider: 'modsearch' } },
  }
  const remotes = {
    'agent-default-model': { name: 'agent-default-model', config: { provider: 'deepseek-account', model: 'deepseek-pro' } },
    'web': { name: 'web', config: { searchProvider: 'modsearch', fetchProvider: 'fs-quality-fetch' } },
  }
  const merged = mergePluginConfigs({ local, base, remotes })
  assert.equal(merged.merged['agent-default-model'].config.model, 'deepseek-pro')
  assert.equal(merged.merged.web.config.fetchProvider, 'fs-quality-fetch')
  assert.equal(merged.changes.length, 2)
  assert.equal(merged.conflicts.length, 0)
})

test('mergePluginConfigs：本机自己改过的键不被远端覆盖', () => {
  const local = { 'bili-scroll': { name: 'bili-scroll', config: { perDay: 5 } } }
  const base = { 'bili-scroll': { config: { perDay: 3 } } }
  const remotes = { 'bili-scroll': { name: 'bili-scroll', config: { perDay: 9 } } }
  const merged = mergePluginConfigs({ local, base, remotes })
  assert.equal(merged.merged['bili-scroll'].config.perDay, 5)
  assert.equal(merged.conflicts[0].keys[0], 'perDay')
})

test('restoreDenied：写回前把本机的路径/密码补回来', () => {
  const raw = { enabled: true, pythonPath: 'C:\\py\\python.exe', nested: { a: 1, workspace: 'D:\\w' } }
  const sanitized = { enabled: false, nested: { a: 2 } }
  const next = restoreDenied(sanitized, raw)
  assert.deepEqual(next, { enabled: false, pythonPath: 'C:\\py\\python.exe', nested: { a: 2, workspace: 'D:\\w' } })
})
