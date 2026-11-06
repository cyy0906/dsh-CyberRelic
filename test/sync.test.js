// test/sync.test.js —— 两台「模拟机」用同一个本地文件夹通道跑同步
//
// 做法：每台机器一个临时 DSH_HOME，切换 process.env.DSH_HOME 后加载配置/状态各跑一轮。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadConfig } from '../lib/config.js'
import { loadState, saveState } from '../lib/state.js'
import { runSync } from '../lib/engine.js'

const root = mkdtempSync(join(tmpdir(), 'dsh-sync-fish-test-'))
const channelDir = join(root, 'channel')
const homeA = join(root, 'machine-a')
const homeB = join(root, 'machine-b')

async function syncAt(home, options) {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const config = loadConfig({
      deviceName: options.deviceName,
      channel: { type: 'folder', root: channelDir },
      passphrase: options.passphrase || '',
    })
    const state = loadState()
    const result = await runSync({ config, state })
    saveState(state)
    return result
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
}

function writeStore(home, sid, memories, extra = {}) {
  mkdirSync(join(home, 'fish-memory'), { recursive: true })
  const store = {
    version: 2,
    purgeEpoch: extra.purgeEpoch || '',
    policy: {},
    memories,
    traces: extra.traces || [],
    deleted: extra.deleted || [],
  }
  writeFileSync(join(home, 'fish-memory', `${sid}.json`), JSON.stringify(store, null, 2))
}

function readStore(home, sid) {
  return JSON.parse(readFileSync(join(home, 'fish-memory', `${sid}.json`), 'utf8'))
}

function writeSkill(home, name, text) {
  mkdirSync(join(home, 'skills'), { recursive: true })
  writeFileSync(join(home, 'skills', name), text)
}

function readSkill(home, name) {
  return readFileSync(join(home, 'skills', name), 'utf8')
}

const mem = (id, text, createdAt) => ({ id, text, importance: 0.5, createdAt })

test('两台机的鱼记忆会互相合并，并保留各自的 purgeEpoch', async () => {
  writeStore(homeA, 'session-a', [mem('m1', '主人最爱米饭', '2026-01-01T00:00:00.000Z')], { purgeEpoch: 'epoch-a' })
  writeStore(homeB, 'session-b', [mem('m2', '主人经常熬夜', '2026-01-02T00:00:00.000Z')], { purgeEpoch: 'epoch-b' })

  await syncAt(homeA, { deviceName: 'A' })
  await syncAt(homeB, { deviceName: 'B' })
  await syncAt(homeA, { deviceName: 'A' })

  const a = readStore(homeA, 'session-a')
  const b = readStore(homeB, 'session-b')
  assert.deepEqual(a.memories.map((m) => m.id).sort(), ['m1', 'm2'])
  assert.deepEqual(b.memories.map((m) => m.id).sort(), ['m1', 'm2'])
  assert.equal(a.purgeEpoch, 'epoch-a')
  assert.equal(b.purgeEpoch, 'epoch-b')
})

test('删除墓碑会传播到另一台机', async () => {
  const bs = readStore(homeB, 'session-b')
  bs.memories = bs.memories.filter((m) => m.id !== 'm2')
  bs.deleted = [{ id: 'm2', text: '主人经常熬夜', deletedAt: '2026-02-01T00:00:00.000Z' }]
  writeFileSync(join(homeB, 'fish-memory', 'session-b.json'), JSON.stringify(bs, null, 2))

  await syncAt(homeB, { deviceName: 'B' })
  await syncAt(homeA, { deviceName: 'A' })

  const a = readStore(homeA, 'session-a')
  assert.ok(!a.memories.some((m) => m.id === 'm2'), 'm2 应该被删掉')
  assert.ok(a.deleted.some((m) => m.id === 'm2'), '墓碑应该保留')
  assert.equal(a.purgeEpoch, 'epoch-a')
})

test('同一个 id 两边都改 → 记冲突，取时间较新的一条', async () => {
  const aStore = readStore(homeA, 'session-a')
  aStore.memories = aStore.memories.map((m) =>
    m.id === 'm1' ? { ...m, text: '主人最爱米饭（A 改）', editedAt: '2026-03-01T00:00:00.000Z' } : m,
  )
  writeFileSync(join(homeA, 'fish-memory', 'session-a.json'), JSON.stringify(aStore, null, 2))
  await syncAt(homeA, { deviceName: 'A' })

  const bStore = readStore(homeB, 'session-b')
  bStore.memories = bStore.memories.map((m) =>
    m.id === 'm1' ? { ...m, text: '主人最爱米饭（B 改）', editedAt: '2026-03-02T00:00:00.000Z' } : m,
  )
  writeFileSync(join(homeB, 'fish-memory', 'session-b.json'), JSON.stringify(bStore, null, 2))
  const result = await syncAt(homeB, { deviceName: 'B' })

  assert.equal(result.conflicts.length, 1)
  assert.equal(result.conflicts[0].kind, 'memory')
  assert.equal(result.conflicts[0].id, 'm1')
  const b = readStore(homeB, 'session-b')
  assert.equal(b.memories.find((m) => m.id === 'm1').text, '主人最爱米饭（B 改）')
})

test('技能文件三方合并：冲突保留本地，远端另存', async () => {
  writeSkill(homeA, 'foo.md', 'v1')
  writeSkill(homeB, 'other.md', '只有 B 有')

  await syncAt(homeA, { deviceName: 'A' })
  await syncAt(homeB, { deviceName: 'B' })
  await syncAt(homeA, { deviceName: 'A' })

  assert.equal(readSkill(homeA, 'other.md'), '只有 B 有')
  assert.equal(readSkill(homeB, 'foo.md'), 'v1')

  writeSkill(homeA, 'foo.md', 'v2')
  await syncAt(homeA, { deviceName: 'A' })
  writeSkill(homeB, 'foo.md', 'v3')
  const conflictResult = await syncAt(homeB, { deviceName: 'B' })

  const fileConflicts = conflictResult.conflicts.filter((c) => c.kind === 'file')
  assert.equal(fileConflicts.length, 1)
  assert.equal(fileConflicts[0].key, '~/.dsh/skills/foo.md')
  assert.equal(readSkill(homeB, 'foo.md'), 'v3')

  const conflictRoot = join(homeB, 'sync-fish', 'conflicts')
  assert.ok(existsSync(conflictRoot), '冲突副本目录应该存在')
  const copies = readdirSync(conflictRoot, { recursive: true }).filter((name) => String(name).includes('foo.md'))
  assert.ok(copies.length >= 1, '远端内容应该另存一份')

  await syncAt(homeA, { deviceName: 'A' })
  assert.equal(readSkill(homeA, 'foo.md'), 'v3', 'A 没改过，应该接受 B 的版本')
})

test('加密开关：快照里看不到明文，另一台机要同一口令才能读', async () => {
  const encryptedRoot = join(root, 'channel-enc')
  process.env.DSH_HOME = homeA
  try {
    const config = loadConfig({
      deviceName: 'A',
      channel: { type: 'folder', root: encryptedRoot },
      passphrase: 'hunter2',
    })
    const state = loadState()
    await runSync({ config, state })
    saveState(state)

    const devicesDir = join(encryptedRoot, 'dsh-sync-fish', 'devices')
    const file = readdirSync(devicesDir).find((name) => name.endsWith('.json'))
    const raw = readFileSync(join(devicesDir, file), 'utf8')
    assert.ok(!raw.includes('主人最爱米饭'), '快照里不应该有明文记忆')
    assert.ok(raw.includes('dsh-sync-fish/enc/v1'))
  } finally {
    delete process.env.DSH_HOME
  }

  // 没口令的机器读不了（而且不能把自己的明文快照写进加密通道）
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = homeB
  try {
    const config = loadConfig({
      deviceName: 'B',
      channel: { type: 'folder', root: encryptedRoot },
    })
    const state = loadState()
    const deviceId = state.deviceId
    await assert.rejects(() => runSync({ config, state }), /加密/)
    const own = join(encryptedRoot, 'dsh-sync-fish', 'devices', `${deviceId}.json`)
    assert.ok(!existsSync(own) || !readFileSync(own, 'utf8').includes('"format":"dsh-sync-fish/device/v1"'), '不应写入明文快照')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})

test('dryRun 不写任何本地文件', async () => {
  const before = readFileSync(join(homeA, 'fish-memory', 'session-a.json'), 'utf8')
  process.env.DSH_HOME = homeA
  try {
    const config = loadConfig({ deviceName: 'A', channel: { type: 'folder', root: channelDir } })
    const state = loadState()
    await runSync({ config, state, dryRun: true })
    assert.equal(readFileSync(join(homeA, 'fish-memory', 'session-a.json'), 'utf8'), before)
  } finally {
    delete process.env.DSH_HOME
  }
})
