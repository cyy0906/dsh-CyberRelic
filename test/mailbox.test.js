// test/mailbox.test.js —— 跨设备指令信箱：签名、投递、幂等、过期、越权
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ACTIONS,
  INBOX_FORMAT,
  MAILBOX_VERSION,
  MAX_EXECUTED_IDS,
  appendOutbox,
  ensureMailboxState,
  inboxPath,
  isExpired,
  listSessions,
  makeCommand,
  markExecuted,
  outboxPath,
  pollMailbox,
  pushCommand,
  readInbox,
  readManifestDevices,
  readOutbox,
  resolveTarget,
  signCommand,
  truncateResult,
  validateCommand,
  verifySignature,
  wasExecuted,
} from '../lib/mailbox.js'

const PASS = 'rice-is-life'
const SELF = 'device-self-0001'
const OTHER = 'device-other-0002'
const config = { remotePrefix: 'dsh-sync-fish', passphrase: PASS }

/** 内存通道：跟 FolderChannel / WebdavChannel 同一套 read/write/list/remove/ping 接口 */
function memoryChannel(seed = {}) {
  const files = new Map(Object.entries(seed))
  return {
    type: 'memory',
    files,
    async read(path) {
      return files.has(path) ? files.get(path) : null
    },
    async write(path, text) {
      files.set(path, String(text))
    },
    async list(prefix = '') {
      return [...files.keys()].filter((key) => key.startsWith(prefix))
    },
    async remove(path) {
      files.delete(path)
    },
    async ping() {
      return { ok: true }
    },
  }
}

function freshState() {
  return { deviceId: SELF, deviceName: '电脑', mailbox: { executedIds: [], results: [] } }
}

// ── 签名 ────────────────────────────────────────────────────────
test('签名：同口令认，换口令或改内容都不认', () => {
  const command = makeCommand({ to: SELF, from: OTHER, action: 'sync_now', payload: { dryRun: true }, passphrase: PASS })
  command.sig = signCommand(command, PASS)
  assert.equal(verifySignature(command, PASS), true)
  assert.equal(verifySignature(command, 'another-passphrase'), false)
  assert.equal(verifySignature({ ...command, sig: '' }, PASS), false)
  assert.equal(verifySignature({ ...command, sig: 'zz' }, PASS), false)

  // 改动作 / 改 payload / 改收件人，签名都该失效
  assert.equal(verifySignature({ ...command, action: 'set_scopes' }, PASS), false)
  assert.equal(verifySignature({ ...command, payload: { dryRun: false } }, PASS), false)
  assert.equal(verifySignature({ ...command, to: OTHER }, PASS), false)
  // 改不影响语义的展示字段（fromName）不在签名范围里
  assert.equal(verifySignature({ ...command, fromName: '手机' }, PASS), true)
})

test('指令校验：不是给我的、动作不在白名单、时间不合法都拒', () => {
  const good = makeCommand({ to: SELF, from: OTHER, action: 'read_config', passphrase: PASS })
  assert.equal(validateCommand(good, { deviceId: SELF }).ok, true)

  const notMine = validateCommand({ ...good, to: OTHER }, { deviceId: SELF })
  assert.equal(notMine.ok, false)
  assert.equal(notMine.code, 'not-for-me')

  const badAction = validateCommand({ ...good, action: 'shell' }, { deviceId: SELF })
  assert.equal(badAction.ok, false)
  assert.equal(badAction.code, 'action')

  assert.equal(validateCommand({ ...good, createdAt: 'yesterday' }, { deviceId: SELF }).code, 'time')
  assert.equal(validateCommand(null, { deviceId: SELF }).code, 'shape')

  const expired = makeCommand({ to: SELF, from: OTHER, action: 'sync_now', ttlMinutes: 1, now: Date.now() - 3_600_000, passphrase: PASS })
  assert.equal(isExpired(expired), true)
  assert.equal(isExpired(good), false)
})

// ── 投递 ────────────────────────────────────────────────────────
test('pushCommand 把签名指令写进目标设备的 inbox.json，别的设备不受影响', async () => {
  const channel = memoryChannel()
  const pushed = await pushCommand({
    channel,
    config,
    targetDeviceId: OTHER,
    action: 'sync_now',
    payload: { dryRun: true },
    fromDeviceId: SELF,
    fromName: '电脑',
  })

  assert.equal(pushed.path, `dsh-sync-fish/mailbox/${OTHER}/inbox.json`)
  assert.equal(pushed.total, 1)
  const body = JSON.parse(channel.files.get(pushed.path))
  assert.equal(body.format, INBOX_FORMAT)
  assert.equal(body.version, MAILBOX_VERSION)
  assert.equal(body.deviceId, OTHER)
  assert.equal(body.messages.length, 1)
  assert.equal(body.messages[0].sig.length, 64)
  assert.equal(verifySignature(body.messages[0], PASS), true)
  assert.equal(body.messages[0].fromName, '电脑')

  // 再推一条：同一个 inbox 累加，新的排前面
  const second = await pushCommand({ channel, config, targetDeviceId: OTHER, action: 'read_config', fromDeviceId: SELF })
  assert.equal(second.total, 2)
  const again = await readInbox({ channel, config, deviceId: OTHER })
  assert.equal(again.messages[0].id, second.command.id)
  assert.equal(again.messages[1].id, pushed.command.id)

  // 自己的信箱还是空的
  const mine = await readInbox({ channel, config, deviceId: SELF })
  assert.equal(mine.missing, true)
  assert.equal(mine.messages.length, 0)
})

test('没有口令就不投递也不执行', async () => {
  const channel = memoryChannel()
  await assert.rejects(
    () => pushCommand({ channel, config: { remotePrefix: 'x' }, targetDeviceId: OTHER, action: 'sync_now', passphrase: '' }),
    /口令/,
  )
  const state = freshState()
  const result = await pollMailbox({
    channel,
    config: { remotePrefix: 'x', passphrase: '' },
    state,
    deviceId: SELF,
    host: { run: async () => assert.fail('没口令不该执行') },
  })
  assert.equal(result.ok, false)
  assert.equal(result.skipped, 'no-passphrase')
})

// ── 执行 ────────────────────────────────────────────────────────
test('pollMailbox 执行指令、写 outbox、记 executedIds', async () => {
  const channel = memoryChannel()
  const pushed = await pushCommand({
    channel,
    config,
    targetDeviceId: SELF,
    action: 'sync_now',
    payload: { dryRun: true },
    fromDeviceId: OTHER,
  })

  const state = freshState()
  const seen = []
  let persisted = 0
  const result = await pollMailbox({
    channel,
    config,
    state,
    deviceId: SELF,
    host: {
      async run(command) {
        seen.push(command.id)
        // 执行前就应该已经落过盘（幂等的前提）
        assert.equal(state.mailbox.executedIds.includes(command.id), true)
        return { ok: true, message: '同步完成' }
      },
    },
    persist: () => {
      persisted += 1
      assert.equal(state.mailbox.executedIds.includes(pushed.command.id), true)
    },
  })

  assert.equal(result.ok, true)
  assert.deepEqual(seen, [pushed.command.id])
  assert.equal(result.counts.ok, 1)
  assert.equal(result.counts.error, 0)
  assert.ok(persisted >= 1)
  assert.equal(wasExecuted(state, pushed.command.id), true)
  assert.equal(state.mailbox.results[0].status, 'ok')

  const outbox = await readOutbox({ channel, config, deviceId: SELF })
  assert.equal(outbox.results.length, 1)
  assert.equal(outbox.results[0].id, pushed.command.id)
  assert.equal(outbox.results[0].status, 'ok')
  assert.match(outbox.results[0].result, /同步完成/)
  assert.equal(outbox.results[0].error, '')
})

test('幂等：同一条指令跑第二遍不再执行', async () => {
  const channel = memoryChannel()
  const pushed = await pushCommand({ channel, config, targetDeviceId: SELF, action: 'sync_now', fromDeviceId: OTHER })
  const state = freshState()
  let calls = 0
  const host = {
    async run() {
      calls += 1
      return { ok: true }
    },
  }

  const first = await pollMailbox({ channel, config, state, deviceId: SELF, host })
  assert.equal(first.counts.ok, 1)
  const second = await pollMailbox({ channel, config, state, deviceId: SELF, host })
  assert.equal(calls, 1, '第二遍不该再执行')
  assert.equal(second.counts.ok, 0)
  assert.equal(second.skippedItems[0].code, 'done')
  assert.equal(second.skippedItems[0].id, pushed.command.id)

  // 同一份 state 落盘再读回来也认得出「执行过」
  const reloaded = JSON.parse(JSON.stringify(state))
  assert.equal(wasExecuted(reloaded, pushed.command.id), true)
})

test('执行抛错：outbox 记 error，不重试、不卡住后面的指令', async () => {
  const channel = memoryChannel()
  const broken = await pushCommand({ channel, config, targetDeviceId: SELF, action: 'read_config', fromDeviceId: OTHER })
  const fine = await pushCommand({ channel, config, targetDeviceId: SELF, action: 'sync_now', fromDeviceId: OTHER })

  const state = freshState()
  const result = await pollMailbox({
    channel,
    config,
    state,
    deviceId: SELF,
    host: {
      async run(command) {
        if (command.action === 'read_config') throw new Error('配置读不出来')
        return { ok: true }
      },
    },
  })

  assert.equal(result.counts.ok, 1)
  assert.equal(result.counts.error, 1)
  const outbox = await readOutbox({ channel, config, deviceId: SELF })
  const failed = outbox.results.find((item) => item.id === broken.command.id)
  assert.equal(failed.status, 'error')
  assert.match(failed.error, /配置读不出来/)
  assert.equal(outbox.results.some((item) => item.id === fine.command.id && item.status === 'ok'), true)
  assert.equal(wasExecuted(state, broken.command.id), true, '失败也算处理过，别每轮重试')
})

test('过期指令：不执行，但回一条 error 让发送方知道', async () => {
  const channel = memoryChannel()
  const stale = makeCommand({
    to: SELF,
    from: OTHER,
    action: 'sync_now',
    ttlMinutes: 1,
    now: Date.now() - 7 * 24 * 3_600_000,
    passphrase: PASS,
  })
  stale.sig = signCommand(stale, PASS)
  await channel.write(inboxPath(config, SELF), JSON.stringify({ format: INBOX_FORMAT, messages: [stale] }))

  const state = freshState()
  const result = await pollMailbox({
    channel,
    config,
    state,
    deviceId: SELF,
    host: { run: async () => assert.fail('过期了不该执行') },
  })
  assert.equal(result.counts.error, 1)
  assert.equal(wasExecuted(state, stale.id), true)
  const outbox = await readOutbox({ channel, config, deviceId: SELF })
  assert.match(outbox.results[0].error, /过期/)
})

test('签名不对、不是给本机、动作乱写的：都只跳过，不执行也不污染 executedIds', async () => {
  const channel = memoryChannel()
  const forged = makeCommand({ to: SELF, from: OTHER, action: 'sync_now', passphrase: 'other-passphrase' })
  forged.sig = signCommand(forged, 'other-passphrase')
  const notMine = makeCommand({ to: OTHER, from: OTHER, action: 'sync_now', passphrase: PASS })
  notMine.sig = signCommand(notMine, PASS)
  const bogusAction = makeCommand({ to: SELF, from: OTHER, action: 'shell', passphrase: PASS })
  bogusAction.sig = signCommand(bogusAction, PASS)

  await channel.write(
    inboxPath(config, SELF),
    JSON.stringify({ format: INBOX_FORMAT, messages: [forged, notMine, bogusAction] }),
  )

  const state = freshState()
  let calls = 0
  const result = await pollMailbox({
    channel,
    config,
    state,
    deviceId: SELF,
    host: {
      async run() {
        calls += 1
        return { ok: true }
      },
    },
  })
  assert.equal(calls, 0)
  assert.equal(result.counts.skipped, 3)
  assert.equal(state.mailbox.executedIds.length, 0)
  assert.ok(result.skippedItems.some((item) => item.code === 'signature'))
  assert.ok(result.skippedItems.some((item) => item.code === 'not-for-me'))
  assert.ok(result.skippedItems.some((item) => item.code === 'action'))
  assert.ok(result.problems.some((text) => /签名不对/.test(text)))
})

test('老设备 / 没信箱：inbox 不存在就是空跑，不报错', async () => {
  const channel = memoryChannel()
  const state = freshState()
  const result = await pollMailbox({ channel, config, state, deviceId: SELF, host: { run: async () => ({}) } })
  assert.equal(result.ok, true)
  assert.match(result.message, /空/)
  assert.equal(result.handled.length, 0)
  assert.equal(state.mailbox.executedIds.length, 0)
})

// ── 结果截断 ────────────────────────────────────────────────────
test('结果超过 8KB 会被截断，且不切坏汉字', async () => {
  const big = '鲸'.repeat(5000) // 15000 字节
  const text = truncateResult({ ok: true, message: big })
  assert.ok(Buffer.byteLength(text, 'utf8') <= 8 * 1024)
  assert.ok(Buffer.byteLength(text, 'utf8') > 8 * 1024 - 8)
  assert.equal(text.includes('\uFFFD'), false, '不能出现 UTF-8 替换字符')
  assert.ok(text.startsWith('{"ok":true,"message":"鲸鲸'))

  const channel = memoryChannel()
  const pushed = await pushCommand({ channel, config, targetDeviceId: SELF, action: 'read_config', fromDeviceId: OTHER })
  const state = freshState()
  await pollMailbox({
    channel,
    config,
    state,
    deviceId: SELF,
    host: { run: async () => ({ ok: true, blob: big }) },
  })
  const outbox = await readOutbox({ channel, config, deviceId: SELF })
  const entry = outbox.results.find((item) => item.id === pushed.command.id)
  assert.ok(Buffer.byteLength(entry.result, 'utf8') <= 8 * 1024)
})

// ── 设备表 / 名字解析 ────────────────────────────────────────────
test('resolveTarget：self、设备名、设备 id、找不到', async () => {
  assert.equal(resolveTarget('self', { selfId: SELF }).deviceId, SELF)
  assert.equal(resolveTarget('', { selfId: SELF }).deviceId, SELF)
  assert.equal(resolveTarget('本机', { selfId: SELF }).deviceId, SELF)

  const devices = { [OTHER]: { name: '手机' }, 'device-third-0003': { name: '书房电脑' } }
  assert.equal(resolveTarget('手机', { selfId: SELF, devices }).deviceId, OTHER)
  assert.equal(resolveTarget('手机', { selfId: SELF, devices }).name, '手机')
  assert.equal(resolveTarget(OTHER, { selfId: SELF, devices }).deviceId, OTHER)
  assert.equal(resolveTarget('书房电脑', { selfId: SELF, devices }).deviceId, 'device-third-0003')

  const missing = resolveTarget('平板', { selfId: SELF, devices })
  assert.equal(missing.ok, false)
  assert.match(missing.reason, /手机/)
})

test('readManifestDevices：没有 manifest 就空，有就解出来', async () => {
  const channel = memoryChannel()
  const empty = await readManifestDevices(channel, config)
  assert.equal(empty.missing, true)
  assert.deepEqual(empty.devices, {})

  await channel.write(
    'dsh-sync-fish/manifest.json',
    JSON.stringify({ format: 'dsh-sync-fish/manifest/v1', devices: { [OTHER]: { name: '手机' } } }),
  )
  const found = await readManifestDevices(channel, config)
  assert.equal(found.missing, false)
  assert.equal(found.devices[OTHER].name, '手机')

  await channel.write('dsh-sync-fish/manifest.json', 'not json at all')
  const broken = await readManifestDevices(channel, config)
  assert.deepEqual(broken.devices, {})
})

// ── 状态维护 ────────────────────────────────────────────────────
test('executedIds 截到 500 条，appendOutbox 去重且新的排前面', async () => {
  const state = freshState()
  for (let i = 0; i < MAX_EXECUTED_IDS + 20; i += 1) markExecuted(state, `mb_${i}`)
  assert.equal(state.mailbox.executedIds.length, MAX_EXECUTED_IDS)
  assert.equal(state.mailbox.executedIds.at(-1), `mb_${MAX_EXECUTED_IDS + 19}`)
  assert.equal(wasExecuted(state, 'mb_0'), false, '最老的应该被挤掉')

  // 已经执行过的 id 再记一次，应该排到末尾而不是重复
  markExecuted(state, 'mb_500')
  assert.equal(state.mailbox.executedIds.filter((id) => id === 'mb_500').length, 1)
  assert.equal(state.mailbox.executedIds.at(-1), 'mb_500')

  const box = ensureMailboxState({})
  assert.deepEqual(box.executedIds, [])
  assert.equal(box.lastPollAt, '')

  const channel = memoryChannel()
  await appendOutbox({
    channel,
    config,
    deviceId: SELF,
    entries: [{ id: 'a', status: 'ok' }, { id: 'b', status: 'ok' }],
  })
  await appendOutbox({ channel, config, deviceId: SELF, entries: [{ id: 'b', status: 'error' }, { id: 'c', status: 'ok' }] })
  const outbox = await readOutbox({ channel, config, deviceId: SELF })
  assert.deepEqual(
    outbox.results.map((item) => `${item.id}:${item.status}`),
    ['b:error', 'c:ok', 'a:ok'],
  )
  assert.equal(outbox.path, outboxPath(config, SELF))
})

test('listSessions 能列出会话目录，缺目录不抛错', () => {
  const home = mkdtempSync(join(tmpdir(), 'mailbox-sessions-'))
  const ws = join(home, 'sessions', 'default-workspace')
  const one = join(ws, 'session-aaaa')
  mkdirSync(one, { recursive: true })
  writeFileSync(join(one, 'session.v4.jsonl.zstd'), 'x'.repeat(32))
  mkdirSync(join(ws, 'session-bbbb'), { recursive: true })

  const listed = listSessions({ home, limit: 10 })
  assert.equal(listed.total, 2)
  const ids = listed.sessions.map((item) => item.id).sort()
  assert.deepEqual(ids, ['aaaa', 'bbbb'])
  const withFile = listed.sessions.find((item) => item.id === 'aaaa')
  assert.equal(withFile.bytes, 32)
  assert.equal(withFile.workspace, 'default-workspace')
  assert.ok(withFile.updatedAt)

  const missing = listSessions({ home: join(home, 'nope') })
  assert.equal(missing.total, 0)
  assert.deepEqual(missing.sessions, [])
})

test('ACTIONS 就是那五个，没有 shell / 写文件', () => {
  assert.deepEqual(ACTIONS, ['sync_now', 'set_scopes', 'read_config', 'list_sessions', 'run_tool'])
  assert.equal(ACTIONS.includes('shell'), false)
  assert.equal(ACTIONS.includes('exec'), false)
})
