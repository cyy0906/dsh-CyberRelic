// lib/mailbox.js —— 跨设备指令信箱（v0.3.5）
//
// 为什么要有信箱：
//   同步是「拉快照」的单向流，本机只能把自己的状态推上去，没法让另一台设备「做点什么」。
//   信箱就是反向的那条小路：在通道上放一个 JSON，目标设备下一轮同步/60 秒定时器捡起来执行。
//
// 安全边界（这是重点，别把它做成后门）：
//   · 动作只有白名单五个：sync_now / set_scopes / read_config / list_sessions / run_tool；
//     run_tool 也只放行本插件自己的只读工具，**没有任意 shell、没有写文件、没有装插件**。
//   · 每条指令用 config.passphrase 派生 HMAC-SHA256 签名（`sig` 字段），验不过直接丢弃。
//   · 没有口令（passphrase）时信箱整体不工作：不加签的通道等于谁都能往里塞指令。
//   · 指令自带过期时间，过期的不执行。
//
// 通道布局：
//   <remotePrefix>/mailbox/<deviceId>/inbox.json    发给这台设备的指令队列
//   <remotePrefix>/mailbox/<deviceId>/outbox.json   这台设备执行完的结果（回写）
//
// 幂等：
//   执行前先把 id 写进 state.mailbox.executedIds 并落盘（最多留 500 条），
//   所以「执行到一半断电」最多是这一条没跑完，不会重复跑。
//   并发推同一个 inbox 是「后写覆盖」，靠 id 去重 + 客户端重推兜住（见 pushCommand 注释）。
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome, isObject, nowIso, stableStringify } from './util.js'

export const INBOX_FORMAT = 'dsh-sync-fish/mailbox/v1'
export const OUTBOX_FORMAT = 'dsh-sync-fish/mailbox-outbox/v1'
export const MAILBOX_VERSION = 1

/**
 * 指令白名单：加新动作要同时改这里和 lib/index.js 的 runMailboxAction
 *
 * `prompt`（v0.3.6）：把一段文字投给本机的 DSH 会话，让那边的 Agent 干起来。
 * 它借的是 DSH 自己的 schedule 服务（create + run），所以：
 *   · 不是 shell，不是写文件，不是装插件——只是"对那边说一句话"；
 *   · 那边的 Agent 仍然受它自己那台机器的权限策略约束（该弹的授权照弹）；
 *   · 目标默认 new_once（新开一个会话干活），也可以指定已有的 sessionId。
 */
export const ACTIONS = ['sync_now', 'set_scopes', 'read_config', 'list_sessions', 'run_tool', 'prompt']
/** run_tool 只放行本插件自己的只读工具，绝不放行任意工具/命令 */
export const RUN_TOOL_ALLOW = ['sync_now', 'sync_status', 'sync_conflicts', 'mailbox_list', 'mailbox_result']

export const MAX_EXECUTED_IDS = 500
export const MAX_INBOX_MESSAGES = 200
export const MAX_OUTBOX_RESULTS = 200
export const MAX_LOCAL_RESULTS = 20
export const MAX_RESULT_BYTES = 8 * 1024
export const DEFAULT_TTL_MINUTES = 24 * 60

const SIG_CONTEXT = 'dsh-sync-fish/mailbox/v1/hmac'
const ID_RE = /^[A-Za-z0-9_:-]{1,80}$/

// ── 通道路径 ────────────────────────────────────────────────────
// 与 engine.js 的 remotePrefixOf 同一套规则；这里单独写一份是为了避免
// engine ↔ mailbox 互相 import 形成环。
export function mailboxPrefix(config) {
  return String(config?.remotePrefix || 'dsh-sync-fish').replace(/^\/+|\/+$/g, '') || 'dsh-sync-fish'
}

export function safeDeviceId(deviceId) {
  return String(deviceId || '').replace(/[^a-zA-Z0-9_-]/g, '_')
}

export function mailboxDir(config, deviceId) {
  return `${mailboxPrefix(config)}/mailbox/${safeDeviceId(deviceId)}`
}

export function inboxPath(config, deviceId) {
  return `${mailboxDir(config, deviceId)}/inbox.json`
}

export function outboxPath(config, deviceId) {
  return `${mailboxDir(config, deviceId)}/outbox.json`
}

// ── 签名 ────────────────────────────────────────────────────────
/** 口令 → HMAC 密钥（不落盘；口令变了旧指令自然验不过） */
export function mailboxKey(passphrase) {
  return createHmac('sha256', SIG_CONTEXT).update(String(passphrase ?? ''), 'utf8').digest()
}

/** 被签名的那份规范化内容（不含 sig 本身） */
export function signedBody(command) {
  return stableStringify({
    v: MAILBOX_VERSION,
    id: String(command?.id || ''),
    to: String(command?.to || ''),
    from: String(command?.from || ''),
    action: String(command?.action || ''),
    createdAt: String(command?.createdAt || ''),
    expiresAt: String(command?.expiresAt || ''),
    payload: command?.payload === undefined ? null : command.payload,
  })
}

export function signCommand(command, passphrase) {
  return createHmac('sha256', mailboxKey(passphrase)).update(signedBody(command), 'utf8').digest('hex')
}

export function verifySignature(command, passphrase) {
  if (!passphrase) return false
  const given = String(command?.sig || '').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(given)) return false
  const expected = Buffer.from(signCommand(command, passphrase), 'hex')
  const actual = Buffer.from(given, 'hex')
  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}

// ── 指令 ────────────────────────────────────────────────────────
function normalizePayload(payload) {
  if (payload === undefined || payload === null) return {}
  try {
    const text = JSON.stringify(payload)
    const parsed = text === undefined ? {} : JSON.parse(text)
    return isObject(parsed) ? parsed : { value: parsed }
  } catch {
    return {}
  }
}

export function newCommandId(now = Date.now()) {
  return `mb_${now.toString(36)}_${randomBytes(4).toString('hex')}`
}

/** 造一条指令并签名（sig 由调用方或本函数填） */
export function makeCommand({
  to,
  from,
  action,
  payload,
  ttlMinutes = DEFAULT_TTL_MINUTES,
  now = Date.now(),
  id = '',
  passphrase = '',
}) {
  const ttl = Number(ttlMinutes) > 0 ? Number(ttlMinutes) : DEFAULT_TTL_MINUTES
  const command = {
    id: id || newCommandId(now),
    to: String(to || ''),
    from: String(from || ''),
    createdAt: nowIso(now),
    expiresAt: nowIso(now + ttl * 60_000),
    action: String(action || ''),
    payload: normalizePayload(payload),
  }
  command.sig = signCommand(command, passphrase)
  return command
}

/**
 * 结构 + 收件人 + 动作校验（不验签、不判过期，调用方分开处理）。
 * @returns {{ok: boolean, code?: string, reason?: string, command?: object}}
 */
export function validateCommand(raw, { deviceId = '' } = {}) {
  if (!isObject(raw)) return { ok: false, code: 'shape', reason: '不是对象' }
  const id = String(raw.id || '')
  if (!ID_RE.test(id)) return { ok: false, code: 'id', reason: 'id 不合法' }
  const to = String(raw.to || '')
  if (!to) return { ok: false, code: 'to', reason: '缺 to' }
  if (deviceId && to !== String(deviceId)) return { ok: false, code: 'not-for-me', reason: `不是给本机的（to=${to}）` }
  const action = String(raw.action || '')
  if (!ACTIONS.includes(action)) return { ok: false, code: 'action', reason: `动作不在白名单：${action || '(空)'}` }
  const createdAt = String(raw.createdAt || '')
  const expiresAt = String(raw.expiresAt || '')
  const createdMs = Date.parse(createdAt)
  const expiresMs = Date.parse(expiresAt)
  if (!Number.isFinite(createdMs)) return { ok: false, code: 'time', reason: 'createdAt 不是时间' }
  if (!Number.isFinite(expiresMs)) return { ok: false, code: 'time', reason: 'expiresAt 不是时间' }
  const payload = raw.payload === undefined || raw.payload === null ? {} : raw.payload
  if (!isObject(payload)) return { ok: false, code: 'payload', reason: 'payload 不是对象' }
  return {
    ok: true,
    command: {
      id,
      to,
      from: String(raw.from || ''),
      createdAt,
      expiresAt,
      action,
      payload,
      sig: String(raw.sig || ''),
    },
    createdMs,
    expiresMs,
  }
}

export function isExpired(command, now = Date.now()) {
  const expiresMs = Date.parse(String(command?.expiresAt || ''))
  return Number.isFinite(expiresMs) ? expiresMs <= now : true
}

// ── inbox / outbox 读写 ─────────────────────────────────────────
function parseInbox(text) {
  if (!text) return []
  let value
  try {
    value = JSON.parse(text)
  } catch {
    return []
  }
  const list = Array.isArray(value) ? value : Array.isArray(value?.messages) ? value.messages : []
  return list.filter((item) => isObject(item))
}

function parseOutbox(text) {
  if (!text) return []
  let value
  try {
    value = JSON.parse(text)
  } catch {
    return []
  }
  const list = Array.isArray(value) ? value : Array.isArray(value?.results) ? value.results : []
  return list.filter((item) => isObject(item))
}

/** 读本机 inbox；没有就是空（老版本设备没这个目录，读回 null） */
export async function readInbox({ channel, config, deviceId }) {
  const path = inboxPath(config, deviceId)
  try {
    const text = await channel.read(path)
    if (text == null || text === '') return { messages: [], path, missing: true, problems: [] }
    const messages = parseInbox(text)
    return { messages, path, missing: false, problems: [] }
  } catch (error) {
    return { messages: [], path, missing: true, problems: [`读信箱失败：${error?.message || error}`] }
  }
}

export async function readOutbox({ channel, config, deviceId }) {
  const path = outboxPath(config, deviceId)
  try {
    const text = await channel.read(path)
    if (text == null || text === '') return { results: [], path, missing: true }
    return { results: parseOutbox(text), path, missing: false }
  } catch (error) {
    return { results: [], path, missing: true, error: String(error?.message || error) }
  }
}

/** 把一条指令塞进目标设备的 inbox（读 → 合并 → 写回） */
export async function pushCommand({
  channel,
  config,
  targetDeviceId,
  action,
  payload,
  ttlMinutes,
  fromDeviceId = '',
  fromName = '',
  now = Date.now(),
  passphrase = config?.passphrase,
}) {
  if (!targetDeviceId) throw new Error('要指定目标设备 id')
  if (!passphrase) throw new Error('信箱要口令签名：先 sync_setup passphrase=… 设一个端到端口令')
  if (!ACTIONS.includes(String(action || ''))) {
    throw new Error(`动作不在白名单：${action || '(空)'}（可选 ${ACTIONS.join(' / ')}）`)
  }
  const command = makeCommand({
    to: targetDeviceId,
    from: fromDeviceId || 'local',
    action,
    payload,
    ttlMinutes,
    now,
    passphrase,
  })
  if (fromName) command.fromName = String(fromName)
  command.sig = signCommand(command, passphrase)

  const path = inboxPath(config, targetDeviceId)
  let existing = []
  try {
    const text = await channel.read(path)
    existing = parseInbox(text)
  } catch {
    existing = []
  }
  // 同一 id 只留一条；新的排前面，旧的截断。两台设备同时往同一个 inbox 写是
  // 「后写覆盖」——所以 sender 侧失败时直接重推一条新 id 即可，别依赖旧指令还在。
  const messages = [command, ...existing.filter((item) => String(item?.id || '') !== command.id)].slice(
    0,
    MAX_INBOX_MESSAGES,
  )
  const body = {
    format: INBOX_FORMAT,
    version: MAILBOX_VERSION,
    deviceId: safeDeviceId(targetDeviceId),
    updatedAt: nowIso(now),
    messages,
  }
  await channel.write(path, JSON.stringify(body, null, 2))
  return { command, path, total: messages.length }
}

/** 执行结果截断到 8KB（按 UTF-8 字节算，不切坏汉字） */
export function truncateResult(value) {
  let text
  if (typeof value === 'string') text = value
  else {
    try {
      text = JSON.stringify(value ?? null)
    } catch {
      text = String(value)
    }
  }
  if (text === undefined) text = ''
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= MAX_RESULT_BYTES) return text
  // 尾部提示也算进 8KB 预算里，否则「截断到 8KB」的结果会超出去
  const suffix = `…[truncated ${buf.length} bytes]`
  const room = Math.max(0, MAX_RESULT_BYTES - Buffer.byteLength(suffix, 'utf8'))
  let end = Math.min(room, buf.length)
  // 退到完整 UTF-8 字符边界：末尾是续字节（10xxxxxx）就继续往前退
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1
  const head = buf.subarray(0, end).toString('utf8')
  return `${head}${suffix}`
}

/** 把若干条结果并到 outbox（读 → 合并 → 写回） */
export async function appendOutbox({ channel, config, deviceId, entries = [], now = Date.now() }) {
  if (!entries.length) return { path: outboxPath(config, deviceId), total: 0, written: 0 }
  const path = outboxPath(config, deviceId)
  let existing = []
  try {
    const text = await channel.read(path)
    existing = parseOutbox(text)
  } catch {
    existing = []
  }
  const seen = new Set()
  const results = []
  for (const entry of [...entries, ...existing]) {
    const id = String(entry?.id || '')
    if (!id || seen.has(id)) continue
    seen.add(id)
    results.push(entry)
    if (results.length >= MAX_OUTBOX_RESULTS) break
  }
  const body = {
    format: OUTBOX_FORMAT,
    version: MAILBOX_VERSION,
    deviceId: safeDeviceId(deviceId),
    updatedAt: nowIso(now),
    results,
  }
  await channel.write(path, JSON.stringify(body, null, 2))
  return { path, total: results.length, written: entries.length }
}

// ── 本地 state ──────────────────────────────────────────────────
export function ensureMailboxState(state) {
  if (!isObject(state.mailbox)) state.mailbox = {}
  const box = state.mailbox
  if (!Array.isArray(box.executedIds)) box.executedIds = []
  box.executedIds = box.executedIds.map(String).filter(Boolean)
  if (box.executedIds.length > MAX_EXECUTED_IDS) box.executedIds = box.executedIds.slice(-MAX_EXECUTED_IDS)
  if (!Array.isArray(box.results)) box.results = []
  if (box.results.length > MAX_LOCAL_RESULTS) box.results = box.results.slice(0, MAX_LOCAL_RESULTS)
  if (typeof box.lastPollAt !== 'string') box.lastPollAt = ''
  if (typeof box.lastError !== 'string') box.lastError = ''
  return box
}

export function markExecuted(state, commandId) {
  const box = ensureMailboxState(state)
  const id = String(commandId || '')
  if (!id) return box
  box.executedIds = [...box.executedIds.filter((item) => item !== id), id].slice(-MAX_EXECUTED_IDS)
  return box
}

export function wasExecuted(state, commandId) {
  const box = ensureMailboxState(state)
  return box.executedIds.includes(String(commandId || ''))
}

// ── 拉取并执行 ──────────────────────────────────────────────────
/**
 * 拉本机 inbox → 验签 → 去重 → 执行 → 回写 outbox。
 *
 * @param {object} options
 *   channel   : 通道对象（makeChannel 的产物）
 *   config    : 配置
 *   state     : 同步 state（会写 mailbox.executedIds）
 *   deviceId  : 本机 id
 *   host      : { run(command) → 任意结果 }
 *   persist   : () => void        执行前把 state 落盘的钩子（幂等的关键）
 *   now       : 当前毫秒时间戳（测试用）
 *   log       : 日志函数
 */
export async function pollMailbox({
  channel,
  config,
  state,
  deviceId,
  host,
  persist = () => {},
  now = Date.now(),
  log = () => {},
}) {
  const box = ensureMailboxState(state)
  if (!config?.passphrase) {
    box.lastError = '没有口令，信箱不工作'
    return {
      ok: false,
      skipped: 'no-passphrase',
      message: '信箱要口令签名：先 sync_setup passphrase=…',
      handled: [],
      skippedItems: [],
      problems: [],
    }
  }
  if (typeof host?.run !== 'function') throw new Error('pollMailbox 需要 host.run')

  const inbox = await readInbox({ channel, config, deviceId })
  const problems = [...inbox.problems]
  const handled = []
  const skippedItems = []
  const counts = { ok: 0, error: 0, skipped: 0 }

  for (const raw of inbox.messages) {
    const id = String(raw?.id || '')
    const validation = validateCommand(raw, { deviceId })
    if (!validation.ok) {
      counts.skipped += 1
      skippedItems.push({ id: id || '(无 id)', reason: validation.reason, code: validation.code })
      continue
    }
    if (!verifySignature(raw, config.passphrase)) {
      // 验不过的绝不执行，也不进 executedIds（免得别人拿垃圾 id 污染本机状态）
      counts.skipped += 1
      skippedItems.push({ id, reason: '签名验不过（口令不同或被改过）', code: 'signature' })
      if (problems.length < 20) problems.push(`丢弃一条签名不对的指令 ${id}`)
      continue
    }
    if (wasExecuted(state, id)) {
      counts.skipped += 1
      skippedItems.push({ id, reason: '已经执行过', code: 'done' })
      continue
    }

    const command = validation.command
    if (isExpired(command, now)) {
      // 过期的记一条 outbox error 让发送方知道，同时记进 executedIds 免得每轮重看
      markExecuted(state, id)
      persist()
      const entry = {
        id,
        action: command.action,
        status: 'error',
        startedAt: nowIso(now),
        finishedAt: nowIso(now),
        result: '',
        error: '指令已过期（expiresAt 早于现在）',
      }
      handled.push(entry)
      counts.error += 1
      continue
    }

    // 先落状态再执行：中途崩了最多是这条没结果，不会重复跑
    markExecuted(state, id)
    persist()

    const startedAt = nowIso()
    let entry
    try {
      const result = await host.run(command)
      entry = {
        id,
        action: command.action,
        status: 'ok',
        startedAt,
        finishedAt: nowIso(),
        result: truncateResult(result),
        error: '',
      }
      counts.ok += 1
    } catch (error) {
      entry = {
        id,
        action: command.action,
        status: 'error',
        startedAt,
        finishedAt: nowIso(),
        result: '',
        error: String(error?.message || error).slice(0, 2000),
      }
      counts.error += 1
    }
    handled.push(entry)
    box.results = [entry, ...box.results.filter((item) => String(item?.id || '') !== id)].slice(0, MAX_LOCAL_RESULTS)
  }

  if (handled.length) {
    try {
      await appendOutbox({ channel, config, deviceId, entries: handled, now })
    } catch (error) {
      problems.push(`回写 outbox 失败：${error?.message || error}`)
    }
  }
  box.lastPollAt = nowIso(now)
  box.lastError = problems.length ? problems.slice(0, 3).join('；') : ''
  persist()
  if (handled.length) log(`信箱：执行 ${handled.length} 条（ok ${counts.ok}，error ${counts.error}）`)
  return {
    ok: true,
    skipped: '',
    message: handled.length
      ? `信箱执行 ${handled.length} 条：成功 ${counts.ok}，失败 ${counts.error}`
      : inbox.missing
        ? '信箱还是空的（这台设备还没有 inbox）'
        : '信箱里没有新指令',
    inboxPath: inbox.path,
    handled,
    skippedItems,
    counts,
    problems,
  }
}

// ── 设备名 ↔ id ─────────────────────────────────────────────────
/** 读 manifest 里的设备表（老通道没有 manifest 就返回空） */
export async function readManifestDevices(channel, config) {
  const path = `${mailboxPrefix(config)}/manifest.json`
  try {
    const text = await channel.read(path)
    if (!text) return { devices: {}, missing: true }
    const parsed = JSON.parse(text)
    const devices = isObject(parsed?.devices) ? parsed.devices : {}
    return { devices, missing: false }
  } catch {
    return { devices: {}, missing: true }
  }
}

/**
 * 把「self / 设备名 / 设备 id」解析成设备 id。
 * 名字来自 manifest（别的设备同步时写的 deviceName）。
 */
export function resolveTarget(target, { selfId = '', devices = {} } = {}) {
  const wanted = String(target || '').trim()
  if (!wanted || /^(self|me|自己|本机)$/i.test(wanted)) return { ok: true, deviceId: String(selfId), name: 'self' }
  if (Object.prototype.hasOwnProperty.call(devices, wanted)) {
    return { ok: true, deviceId: wanted, name: devices[wanted]?.name || wanted }
  }
  const lower = wanted.toLowerCase()
  for (const [id, info] of Object.entries(devices)) {
    if (String(info?.name || '').toLowerCase() === lower) {
      return { ok: true, deviceId: id, name: info?.name || id }
    }
  }
  const available = Object.entries(devices)
    .map(([id, info]) => `${info?.name || id}（${id}）`)
    .join('、')
  return {
    ok: false,
    deviceId: '',
    reason: `没找到设备「${wanted}」${available ? `；通道里有：${available}` : '；通道里还没有别的设备'}`,
  }
}

// ── 会话列表（list_sessions 动作） ──────────────────────────────
/**
 * 列本机会话目录（只读，不解析内容）：
 *   ~/.dsh/sessions/<工作区 slug>/session-<uuid>/session.v4.jsonl.zstd
 */
export function listSessions({ home = dshHome(), limit = 30 } = {}) {
  const root = join(home, 'sessions')
  const out = []
  let workspaceDirs = []
  try {
    workspaceDirs = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  } catch {
    return { total: 0, sessions: [], root }
  }
  for (const workspace of workspaceDirs) {
    const wsDir = join(root, workspace.name)
    let sessionDirs = []
    try {
      sessionDirs = readdirSync(wsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    } catch {
      continue
    }
    for (const session of sessionDirs) {
      const dir = join(wsDir, session.name)
      let mtime = 0
      let bytes = 0
      try {
        mtime = statSync(dir).mtimeMs
      } catch {
        mtime = 0
      }
      for (const file of ['session.v4.jsonl.zstd', 'session.jsonl', 'session.v3.jsonl.zstd']) {
        try {
          const stat = statSync(join(dir, file))
          bytes = stat.size
          mtime = Math.max(mtime, stat.mtimeMs)
          break
        } catch {
          /* 换下一个可能的名字 */
        }
      }
      out.push({
        id: session.name.replace(/^session-/, ''),
        dir: session.name,
        workspace: workspace.name,
        updatedAt: mtime ? nowIso(mtime) : '',
        bytes,
      })
    }
  }
  out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  return { total: out.length, sessions: out.slice(0, Math.max(1, Number(limit) || 30)), root }
}
