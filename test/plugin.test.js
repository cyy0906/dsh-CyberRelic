// test/plugin.test.js —— 插件入口：注册了哪些工具、触发器能不能安全空跑
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

function fakeContext() {
  const registered = []
  const handlers = {}
  const intervals = []
  const timeouts = []
  const effects = []
  return {
    registered,
    handlers,
    intervals,
    timeouts,
    effects,
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    },
    on(event, handler) {
      handlers[event] = handler
    },
    effect(fn) {
      effects.push(fn)
      return fn()
    },
    interval(fn, ms) {
      intervals.push({ fn, ms })
      return () => {}
    },
    timeout(fn, ms) {
      timeouts.push({ fn, ms })
      return () => {}
    },
    get() {
      return undefined
    },
  }
}

async function withHome(fn) {
  const previous = process.env.DSH_HOME
  const home = mkdtempSync(join(tmpdir(), 'sync-fish-plugin-'))
  process.env.DSH_HOME = home
  try {
    return await fn(home)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
}

test('apply 注册八个工具，并挂上 agent/created 与定时器', async () => {
  await withHome(async (home) => {
    const shared = join(home, 'shared')
    mkdirSync(shared, { recursive: true })
    mkdirSync(join(home, 'sync-fish'), { recursive: true })
    writeFileSync(
      join(home, 'sync-fish', 'config.json'),
      JSON.stringify({
        deviceName: 'machine-a',
        channel: { type: 'folder', root: shared },
        files: [],
      }),
      'utf8',
    )

    const { apply } = await import('../lib/index.js')
    const ctx = fakeContext()
    await apply(ctx, {})

    const names = ctx.registered.map((tool) => tool.name).sort()
    assert.deepEqual(names, [
      'mailbox_list',
      'mailbox_push',
      'mailbox_result',
      'sync_conflicts',
      'sync_now',
      'sync_phone',
      'sync_setup',
      'sync_status',
    ])
    for (const tool of ctx.registered) {
      assert.equal(tool.output?.schema?.type, 'object')
      assert.equal(typeof tool.execute, 'function')
      assert.equal(typeof tool.output.render, 'function')
      // object 参数必须显式写 additionalProperties：宿主的 defineTool 会拒
      for (const [key, schema] of Object.entries(tool.parameters || {})) {
        if (schema?.type === 'object') {
          assert.notEqual(schema.additionalProperties, undefined, `${tool.name}.${key} 缺 additionalProperties`)
        }
      }
    }
    assert.ok(ctx.handlers['agent/created'], 'agent/created 钩子应该挂上')
    assert.ok(ctx.effects.length >= 1, '应该注册定时清理 effect')

    const status = await ctx.registered.find((tool) => tool.name === 'sync_status').execute({})
    assert.equal(status.ok, true)
    assert.equal(status.channel.type, 'folder')
    // 空文件夹也能 ping 通（folder 通道自己写探针文件）
    assert.equal(status.channelReachable, true)
  })
})

test('sync_setup 能把通道写进配置，坏配置不落盘', async () => {
  await withHome(async (home) => {
    const { apply } = await import('../lib/index.js')
    const ctx = fakeContext()
    await apply(ctx, {})

    const setup = ctx.registered.find((tool) => tool.name === 'sync_setup')

    const bad = await setup.execute({ channel: 'folder' })
    assert.equal(bad.ok, false)
    assert.match(bad.message, /root/)

    const good = await setup.execute({ channel: 'folder', root: join(home, 'shared'), test: false })
    assert.equal(good.ok, true)

    const status = await ctx.registered.find((tool) => tool.name === 'sync_status').execute({})
    assert.equal(status.channel.root, join(home, 'shared'))
  })
})

test('信箱工具：发给自己能立刻执行，回执和清单都对得上，发错设备会给出提示', async () => {
  await withHome(async (home) => {
    const shared = join(home, 'shared')
    mkdirSync(shared, { recursive: true })
    const { apply } = await import('../lib/index.js')
    const ctx = fakeContext()
    await apply(ctx, {})

    const setup = ctx.registered.find((tool) => tool.name === 'sync_setup')
    const saved = await setup.execute({
      channel: 'folder',
      root: shared,
      deviceName: '自测电脑',
      passphrase: 'rice-is-life',
      test: false,
    })
    assert.equal(saved.ok, true)
    assert.equal(saved.config.mailbox.signed, true)

    const push = ctx.registered.find((tool) => tool.name === 'mailbox_push')
    const once = await push.execute({ deviceId: 'self', action: 'sync_now', payload: { dryRun: true } })
    assert.equal(once.ok, true, once.message)
    assert.equal(once.executed, true, '发给自己应该当场执行')
    assert.equal(once.status, 'ok', once.message)
    assert.match(once.message, /已投递/)

    const list = ctx.registered.find((tool) => tool.name === 'mailbox_list').execute({})
    const listed = await list
    assert.equal(listed.ok, true)
    assert.equal(listed.enabled, true)
    assert.equal(listed.signed, true)
    assert.equal(listed.executedCount, 1)
    assert.equal(listed.pending.length, 0, '执行过的不该还算待执行')
    assert.match(listed.message, /待执行：0 条/)

    const result = await ctx.registered
      .find((tool) => tool.name === 'mailbox_result')
      .execute({ id: once.id })
    assert.equal(result.ok, true)
    assert.equal(result.status, 'ok')

    // 通道上还没有别的设备时，发错名字要能说清楚
    const missing = await push.execute({ deviceId: '平板', action: 'read_config' })
    assert.equal(missing.ok, false)
    assert.match(missing.message, /没找到设备/)

    // 有别的设备、但它还是旧版（快照没写 pluginVersion）：投得进去，但要提醒白投
    const remote = join(shared, 'dsh-sync-fish')
    mkdirSync(join(remote, 'mailbox', 'old-phone-0003'), { recursive: true })
    writeFileSync(
      join(remote, 'manifest.json'),
      JSON.stringify({ format: 'dsh-sync-fish/manifest/v1', devices: { 'old-phone-0003': { name: '旧手机' } } }),
      'utf8',
    )
    const stale = await push.execute({ deviceId: '旧手机', action: 'sync_now' })
    assert.equal(stale.ok, true, stale.message)
    assert.equal(stale.executed, false)
    assert.match(stale.message, /版本未知/)
    assert.match(stale.warning, /旧版/)
    const delivered = JSON.parse(
      (await import('node:fs')).readFileSync(join(remote, 'mailbox', 'old-phone-0003', 'inbox.json'), 'utf8'),
    )
    assert.equal(delivered.messages.length, 1)
    assert.equal(delivered.messages[0].sig.length, 64)
  })
})

test('agent/created 空跑不抛错，新会话会拿到全局记忆', async () => {
  await withHome(async (home) => {
    mkdirSync(join(home, 'fish-memory'), { recursive: true })
    writeFileSync(
      join(home, 'fish-memory', 'session-1.json'),
      JSON.stringify({
        version: 2,
        purgeEpoch: 'epoch-1',
        memories: [{ id: 'm1', text: '主人喜欢米饭', at: '2026-11-01T00:00:00.000Z' }],
        traces: [],
        deleted: [],
      }),
      'utf8',
    )

    const { apply } = await import('../lib/index.js')
    const ctx = fakeContext()
    await apply(ctx, {})

    ctx.handlers['agent/created']({ agent: { id: 'session-2' } })
    const fresh = JSON.parse(
      (await import('node:fs')).readFileSync(join(home, 'fish-memory', 'session-2.json'), 'utf8'),
    )
    assert.equal(fresh.purgeEpoch, '')
    assert.equal(fresh.memories.length, 1)
    assert.equal(fresh.memories[0].id, 'm1')
  })
})
