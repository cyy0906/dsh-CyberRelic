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

test('apply 注册五个 sync_* 工具，并挂上 agent/created 与定时器', async () => {
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
    assert.deepEqual(names, ['sync_conflicts', 'sync_now', 'sync_phone', 'sync_setup', 'sync_status'])
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
