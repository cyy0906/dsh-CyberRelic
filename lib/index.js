// lib/index.js —— DSH 插件入口：sync_* 工具 + 设置页 API + 启动/定时/新会话触发
//
// 设计取舍：
//  · 不导出 Config（不引 schemastery，少一个 optional peer 的坑）；
//    配置走 $DSH_HOME/sync-fish/config.json，由 sync_setup 工具或设置页写。
//  · 所有可能失败的东西（定时器、事件钩子、通道探测、HTTP 服务）都各自
//    try/catch —— 同步坏掉不能把宿主拖下水。
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { setTimeout as nodeSetTimeout, clearTimeout as nodeClearTimeout, setInterval as nodeSetInterval, clearInterval as nodeClearInterval } from 'node:timers'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshHome } from './util.js'
import { loadHostDeps } from './hostdeps.js'
import { configPath, describeConfig, loadConfig, saveConfig, validateConfig } from './config.js'
import { loadState, saveState, statePath } from './state.js'
import { runSync } from './engine.js'
import { makeChannel } from './channel.js'
import { buildTargets, normalizeTargets } from './files.js'
import { findAdb, installToPhone, listDevices } from './phone.js'
import { createApi } from './server.js'
import { checkUpdate } from './update.js'
import { sanitizeConfig, restoreDenied } from './plugin-configs.js'
import {
  collectLocalMemory,
  ensureStoreForSession,
  fishMode,
  listStoreFiles,
  readGlobalLib,
  writeGlobalLib,
} from './memory.js'

export const name = 'sync-fish'
export const inject = ['tools', 'webServer']

// 本插件自己的版本（package.json），设置页「检查更新」拿它跟 GitHub Release 比。
const VERSION = (() => {
  try {
    const file = fileURLToPath(new URL('../package.json', import.meta.url))
    return String(JSON.parse(readFileSync(file, 'utf8')).version || '')
  } catch {
    return ''
  }
})()

const LOG_MAX_BYTES = 256 * 1024

function logPath() {
  return join(dshHome(), 'sync-fish', 'log.txt')
}

/** 简单日志：追写 + 超限清空。日志失败绝不影响主流程 */
function log(message) {
  try {
    const file = logPath()
    mkdirSync(dirname(file), { recursive: true })
    try {
      if (statSync(file).size > LOG_MAX_BYTES) writeFileSync(file, '')
    } catch {
      /* 文件还不存在 */
    }
    appendFileSync(file, `[${new Date().toISOString()}] ${message}\n`)
  } catch {
    /* 忽略 */
  }
}

function summarize(result) {
  const mem = result.memory || {}
  const files = result.files || {}
  const lines = [
    `同步完成（${result.deviceName || '本机'}，${result.channel?.type || ''}，${result.durationMs}ms）`,
    mem.enabled === false ? '记忆：已关闭' : `记忆：全局 ${mem.records ?? 0} 条，注入 +${mem.added ?? 0}`,
    `文件：${files.total ?? 0} 个，写回 ${files.written?.length ?? 0} 个，恢复 ${files.restored?.length ?? 0} 个`,
  ]
  if (result.remoteDevices?.length) lines.push(`看到的其它设备：${result.remoteDevices.join('、')}`)
  if (result.conflicts?.length) lines.push(`冲突 ${result.conflicts.length} 条（用 sync_conflicts 看）`)
  if (result.warnings?.length) lines.push(`提示 ${result.warnings.length} 条`)
  return lines.join('\n')
}

function pick(object, keys) {
  const out = {}
  for (const key of keys) if (object[key] !== undefined) out[key] = object[key]
  return out
}

// 顶层 await：模块加载时就把宿主的 defineTool 决议好，apply 本身保持同步
let hostDeps
try {
  hostDeps = await loadHostDeps()
} catch {
  hostDeps = { defineTool: (options) => options, notes: [] }
}

export function apply(ctx, pluginConfig) {
  const overrides = pluginConfig && typeof pluginConfig === 'object' ? pluginConfig : {}
  const { defineTool } = hostDeps
  for (const note of hostDeps.notes || []) log(note)

  const runtime = {
    running: null,
    lastRunAt: '',
    lastReason: '',
    lastError: '',
    pendingTimeout: null,
    startedAt: new Date().toISOString(),
  }

  const currentConfig = () => loadConfig(overrides)

  // ── 其他插件设置（cordis 配置）的宿主适配器 ──────────────────
  const pluginConfigHost = createPluginConfigHost(ctx)

  // ── 同步一轮 ─────────────────────────────────────────────────
  async function syncOnce({ dryRun = false, reason = 'manual' } = {}) {
    if (runtime.running) return runtime.running
    const task = (async () => {
      const config = currentConfig()
      if (!config.enabled && reason !== 'manual') {
        return { ok: false, skipped: 'disabled', message: '自动同步是关着的（enabled=false）' }
      }
      const validation = validateConfig(config)
      if (validation.errors.length) {
        const message = validation.errors.join('；')
        runtime.lastError = message
        log(`配置不完整（${reason}）：${message}`)
        return { ok: false, message: `还没配置好：${message}` }
      }

      const state = loadState()
      log(`开始同步（${reason}${dryRun ? '，演练' : ''}，设备 ${config.deviceName}）`)
      try {
        const result = await runSync({
          config,
          state,
          dryRun,
          log: (msg) => log(`  ${msg}`),
          host: pluginConfigHost,
        })
        if (!dryRun) {
          state.deviceName = config.deviceName
          saveState(state)
        }
        runtime.lastRunAt = result.finishedAt
        runtime.lastReason = reason
        runtime.lastError = ''
        return { ...result, ok: true, message: summarize(result) }
      } catch (error) {
        const message = String(error?.message || error)
        runtime.lastError = message
        runtime.lastReason = reason
        log(`同步失败（${reason}）：${message}`)
        return { ok: false, message: `同步失败：${message}`, code: error?.code || 'SYNC_FAILED' }
      }
    })()
    runtime.running = task
    try {
      return await task
    } finally {
      runtime.running = null
    }
  }

  function clearScheduled() {
    if (runtime.pendingTimeout) {
      try {
        nodeClearTimeout(runtime.pendingTimeout)
      } catch {
        /* 已经触发过了 */
      }
      runtime.pendingTimeout = null
    }
  }

  function scheduleSync(delayMs, reason) {
    clearScheduled()
    try {
      const timer = nodeSetTimeout(() => {
        runtime.pendingTimeout = null
        void syncOnce({ reason })
      }, Math.max(1000, delayMs))
      timer.unref?.()
      runtime.pendingTimeout = timer
    } catch (error) {
      log(`排同步失败：${error?.message || error}`)
    }
  }

  // ── 新会话：先把全局记忆注进去（本地操作，不联网） ──────────
  function prepareSessionMemory(sid) {
    try {
      let global = readGlobalLib()
      if (!global) {
        const local = collectLocalMemory()
        if (local.view.memories.length || local.view.deleted.length) {
          writeGlobalLib(local.view)
          global = local.view
        }
      }
      if (!global) return
      const result = ensureStoreForSession(sid, global)
      if (result?.changed) {
        log(`新会话注入记忆 ${sid}：${result.created ? '新建库，' : ''}+${result.added || 0}`)
      }
    } catch (error) {
      log(`注入新会话记忆失败（${sid}）：${error?.message || error}`)
    }
  }

  try {
    ctx.on('agent/created', (payload) => {
      try {
        const sid = payload?.agent?.id ? String(payload.agent.id) : ''
        if (sid) prepareSessionMemory(sid)
        const config = currentConfig()
        if (config.enabled) scheduleSync((Number(config.debounceSeconds) || 120) * 1000, 'agent')
      } catch (error) {
        log(`agent/created 处理失败：${error?.message || error}`)
      }
    })
  } catch (error) {
    log(`agent/created 钩子挂不上：${error?.message || error}`)
  }

  // ── 通道探测 ─────────────────────────────────────────────────
  async function probeChannel(config) {
    try {
      const channel = makeChannel(config.channel)
      await channel.ping()
      return { ok: true, type: channel.type, error: '' }
    } catch (error) {
      return { ok: false, type: config.channel?.type || '', error: String(error?.message || error) }
    }
  }

  // ── 状态（工具和设置页共用） ────────────────────────────────
  async function buildStatus({ probe = false } = {}) {
    const config = currentConfig()
    const state = loadState()
    const global = readGlobalLib()
    const described = describeConfig(config)
    const validation = validateConfig(config)
    const probeResult = probe ? await probeChannel(config) : { ok: false, type: config.channel?.type || '', error: '未探测' }
    const conflicts = Array.isArray(state.conflicts) ? state.conflicts.length : 0
    const memoryRecords = global ? global.memories.length : 0
    const stores = listStoreFiles().length
    const targets = buildTargets(config)
    return {
      message:
        `设备：${described.deviceName}（${state.deviceId || '还没生成 id'}）\n` +
        `通道：${described.channel.type}${probeResult.ok ? ' ✓ 连得上' : ` ✗ ${probeResult.error}`}\n` +
        `加密：${described.encrypted ? '开' : '关'}\n` +
        `上次同步：${state.lastSyncAt || '还没同步过'}${runtime.running ? '（正在跑）' : ''}\n` +
        `记忆：全局库 ${memoryRecords} 条 / 本地 ${stores} 个会话库（模式 ${fishMode()}）\n` +
        `同步分类：${Object.entries(described.scopes)
          .map(([key, value]) => `${key}=${value ? '开' : '关'}`)
          .join(' ')}\n` +
        `待处理冲突：${conflicts} 条`,
      config: described,
      enabled: described.enabled,
      deviceId: state.deviceId,
      deviceName: described.deviceName,
      channel: described.channel,
      channelReachable: probeResult.ok,
      channelError: probeResult.ok ? '' : probeResult.error,
      encrypted: described.encrypted,
      lastSyncAt: state.lastSyncAt,
      lastRunAt: runtime.lastRunAt,
      lastError: runtime.lastError || '',
      running: Boolean(runtime.running),
      conflicts,
      scopes: described.scopes,
      memory: { globalRecords: memoryRecords, stores, mode: fishMode() },
      files: {
        targets: targets.map((item) => item.key),
        lastWritten: state.lastResult?.files?.written?.length ?? 0,
      },
      devices: state.lastResult?.remoteDevices || [],
      intervalMinutes: described.intervalMinutes,
      syncOnStart: described.syncOnStart,
      debounceSeconds: described.debounceSeconds,
      validation,
      paths: { config: configPath(), state: statePath(), log: logPath(), data: join(dshHome(), 'sync-fish') },
      configPath: configPath(),
      statePath: statePath(),
      logPath: logPath(),
      dataDir: join(dshHome(), 'sync-fish'),
    }
  }

  // ── 配置写入（工具和设置页共用） ────────────────────────────
  function applyConfigPatch(patch = {}) {
    const next = loadConfig()
    for (const key of ['enabled', 'deviceName', 'intervalMinutes', 'syncOnStart', 'debounceSeconds', 'remotePrefix', 'passphrase']) {
      if (patch[key] !== undefined) next[key] = key === 'passphrase' ? String(patch[key]) : patch[key]
    }
    if (patch.clearPassphrase) next.passphrase = ''
    if (patch.channel && typeof patch.channel === 'object') {
      next.channel = { ...next.channel, ...pick(patch.channel, ['type', 'root', 'url', 'username', 'password', 'prefix']) }
      if (patch.channel.clearPassword) next.channel.password = ''
    }
    if (patch.scopes && typeof patch.scopes === 'object') {
      next.scopes = {
        ...next.scopes,
        ...pick(patch.scopes, ['memory', 'skills', 'plugins', 'pluginConfigs', 'tasks', 'workspaces']),
      }
    }
    if (patch.phone && typeof patch.phone === 'object') {
      next.phone = { ...next.phone, ...pick(patch.phone, ['adbPath', 'deviceName']) }
    }
    if (patch.tts && typeof patch.tts === 'object') {
      next.tts = { ...next.tts, ...pick(patch.tts, ['enabled', 'azureRegion', 'voice', 'rate', 'pitch', 'maxChars']) }
      if (patch.tts.azureKey !== undefined) next.tts.azureKey = String(patch.tts.azureKey)
      if (patch.tts.clearKey) next.tts.azureKey = ''
    }
    if (patch.memory && typeof patch.memory === 'object') {
      next.memory = { ...next.memory, ...pick(patch.memory, ['injectExisting', 'maxRecords']) }
    }
    if (patch.extraTargets !== undefined) next.extraTargets = normalizeTargets(patch.extraTargets)
    if (patch.targets !== undefined && patch.extraTargets === undefined) next.extraTargets = normalizeTargets(patch.targets)

    const validation = validateConfig(next)
    if (validation.errors.length) {
      return { ok: false, message: `配置没保存：${validation.errors.join('；')}`, validation }
    }
    const file = saveConfig(next)
    return { ok: true, message: `配置已保存到 ${file}`, savedTo: file, validation }
  }

  function phoneInfo() {
    const config = currentConfig()
    const adb = findAdb(config)
    const listed = adb.ok ? listDevices(adb.path) : { ok: false, devices: [], raw: '', error: '没找到 adb' }
    return {
      adb: { path: adb.path, found: adb.ok, devices: listed.devices, error: listed.error || '' },
      packageName: 'io.github.ccch1mneyyy.dsh_app',
      phoneName: config.phone?.deviceName || '手机',
    }
  }

  // ── 工具 ─────────────────────────────────────────────────────
  const textOutput = (fallback) => ({
    schema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean' },
        message: { type: 'string' },
      },
    },
    render(_args, value) {
      if (value && typeof value.message === 'string' && value.message) {
        return [{ type: 'text', text: (value.ok === false ? '✗ ' : '') + value.message }]
      }
      return [{ type: 'text', text: value?.ok === false ? '✗ 没成功' : fallback }]
    },
  })

  const syncNowTool = defineTool({
    name: 'sync_now',
    description:
      '立刻跑一轮跨设备同步：按开关合并鱼记忆、技能、插件设置、任务和工作区，然后把本机快照写到同步通道。' +
      '刚改完设置/技能想马上推到别的设备时用它；只想看会做什么、不落地，就传 dryRun=true。',
    parameters: {
      dryRun: { type: 'boolean', description: '演练：只算要合并和写入什么，不写本地文件，也不写远端快照。' },
    },
    output: textOutput('同步完成'),
    async execute(args) {
      return syncOnce({ dryRun: Boolean(args?.dryRun), reason: 'manual' })
    },
  })

  const syncStatusTool = defineTool({
    name: 'sync_status',
    description:
      '看跨设备同步的状态：通道配置（口令隐去）、设备 id、上次同步时间和结果、待处理冲突数、鱼记忆全局库条数、' +
      '各同步分类开关、本地会话库个数，以及通道是否连得上。',
    parameters: {},
    output: textOutput('状态如下'),
    async execute() {
      return { ok: true, ...(await buildStatus({ probe: true })) }
    },
  })

  const syncConflictsTool = defineTool({
    name: 'sync_conflicts',
    description:
      '看跨设备同步留下的冲突记录（同一份文件两台机都改过、同一段记忆两台机改成不同内容）。' +
      '冲突文件副本已经存在 $DSH_HOME/sync-fish/conflicts/ 下，这里只看记录；传 clear=true 清空记录队列。',
    parameters: {
      clear: { type: 'boolean', description: '清空冲突记录队列（磁盘上的冲突副本不删）。' },
    },
    output: textOutput('没有冲突记录'),
    async execute(args) {
      const state = loadState()
      const list = Array.isArray(state.conflicts) ? state.conflicts : []
      if (args?.clear) {
        state.conflicts = []
        saveState(state)
        return {
          ok: true,
          message: `清掉了 ${list.length} 条冲突记录（冲突副本还在 ${join(dshHome(), 'sync-fish', 'conflicts')}）`,
          cleared: list.length,
          conflicts: [],
        }
      }
      const conflicts = list.slice(0, 20).map((item) => ({
        kind: item.kind || '',
        key: item.key || item.id || '',
        remoteDevice: item.remoteDevice || '',
        at: item.at || '',
      }))
      return {
        ok: true,
        message: list.length ? `有 ${list.length} 条冲突记录（显示最近 ${conflicts.length} 条）` : '没有冲突记录',
        total: list.length,
        conflicts,
        conflictsDir: join(dshHome(), 'sync-fish', 'conflicts'),
      }
    },
  })

  const syncSetupTool = defineTool({
    name: 'sync_setup',
    description:
      '配置跨设备同步：选通道（folder = 一个同步文件夹；webdav = 网盘地址 + 邮箱 + 应用密码）、设设备名、' +
      '分别开关记忆/习惯/插件设置/任务/工作区、定时间隔、加密口令、手机名。' +
      '第一次使用必须先调它；改完会顺手探测通道能不能读写。参数不传的字段保持原样。',
    parameters: {
      channel: { type: 'string', enum: ['folder', 'webdav'], description: '通道类型。' },
      root: { type: 'string', description: 'folder 通道：本机看到的同步文件夹路径。' },
      url: { type: 'string', description: 'webdav 通道：http(s) 地址，坚果云是 https://dav.jianguoyun.com/dav/。' },
      username: { type: 'string', description: 'webdav 用户名/邮箱（坚果云填登录邮箱）。' },
      password: { type: 'string', description: 'webdav 应用密码（不是登录密码；只写进本机配置文件）。' },
      prefix: { type: 'string', description: 'webdav 子目录（可选，默认在根上）。' },
      passphrase: { type: 'string', description: '端到端口令（可选）：设了之后写到通道上的快照会用 AES-256-GCM 加密，各设备必须填同一个口令。' },
      deviceName: { type: 'string', description: '这台机在别的设备上显示的名字（默认取主机名）。' },
      intervalMinutes: { type: 'number', description: '自动同步间隔（分钟），0 = 不自动同步，默认 30。' },
      syncOnStart: { type: 'boolean', description: '启动后自动跑一轮（默认开）。' },
      enabled: { type: 'boolean', description: '总开关：自动同步是否启用。' },
      debounceSeconds: { type: 'number', description: '新会话/新动作之后，隔多少秒再把它推出去（默认 120）。' },
      scopes: {
        type: 'object',
        additionalProperties: true,
        description: '同步分类开关：{ memory, skills, plugins, pluginConfigs, tasks, workspaces }，只改传进来的键。',
      },
      targets: {
        type: 'array',
        items: { type: 'string' },
        description: '额外要同步的文件/目录（~ 表示 home），例如 ["~/.dsh/AGENTS.md"]。',
      },
      phoneName: { type: 'string', description: '手机在同步里显示的名字（默认「手机」）。' },
      adbPath: { type: 'string', description: 'adb 可执行文件路径（手机一键安装用，找不到时手动填）。' },
      remotePrefix: { type: 'string', description: '通道里放快照的子目录名，默认 dsh-sync-fish。' },
      test: { type: 'boolean', description: '保存后探测通道（默认 true）。' },
    },
    output: textOutput('配置已保存'),
    async execute(args) {
      const patch = {
        channel: {},
        scopes: args?.scopes && typeof args.scopes === 'object' ? args.scopes : undefined,
      }
      if (args?.channel) patch.channel.type = args.channel
      for (const key of ['root', 'url', 'username', 'password', 'prefix']) {
        if (args?.[key] !== undefined) patch.channel[key] = String(args[key])
      }
      for (const key of ['passphrase', 'deviceName', 'remotePrefix']) {
        if (args?.[key] !== undefined) patch[key] = String(args[key])
      }
      for (const key of ['intervalMinutes', 'debounceSeconds']) {
        if (args?.[key] !== undefined) patch[key] = Number(args[key])
      }
      for (const key of ['syncOnStart', 'enabled']) {
        if (args?.[key] !== undefined) patch[key] = Boolean(args[key])
      }
      if (args?.targets !== undefined) patch.extraTargets = args.targets
      if (args?.phoneName !== undefined || args?.adbPath !== undefined) {
        patch.phone = {}
        if (args.phoneName !== undefined) patch.phone.deviceName = String(args.phoneName)
        if (args.adbPath !== undefined) patch.phone.adbPath = String(args.adbPath)
      }

      const applied = applyConfigPatch(patch)
      if (!applied.ok) return applied

      const next = currentConfig()
      const probe = args?.test === false ? null : await probeChannel(next)
      const described = describeConfig(next)
      const lines = [
        applied.message,
        `通道：${described.channel.type}${described.channel.root ? ` · ${described.channel.root}` : ''}${
          described.channel.url ? ` · ${described.channel.url}` : ''
        }`,
        `设备名：${described.deviceName}，加密：${described.encrypted ? '开' : '关'}，间隔：${described.intervalMinutes || 0} 分钟`,
        `分类：${Object.entries(described.scopes)
          .map(([key, value]) => `${key}${value ? '✓' : '✗'}`)
          .join(' ')}`,
        probe ? `通道探测：${probe.ok ? '✓ 读写正常' : `✗ ${probe.error}`}` : '通道探测：跳过',
      ]
      return {
        ok: probe ? probe.ok : true,
        message: lines.join('\n'),
        config: described,
        configPath: applied.savedTo,
        validation: applied.validation,
        probe,
      }
    },
  })

  const syncPhoneTool = defineTool({
    name: 'sync_phone',
    description:
      '把本插件一键装到连着 USB 的安卓手机（DSH Go）：打 tar.gz、adb 推到 /sdcard/Download、启动 App、' +
      '把安装指令交给手机上的 agent，最后用同步通道里的 manifest 确认它跑完一轮同步。' +
      '手机要在「开发者选项」里开着 USB 调试并允许这台电脑；通道必须是 webdav。整个过程 1～4 分钟。',
    parameters: {},
    timeoutMs: 300_000,
    output: textOutput('手机安装完成'),
    async execute() {
      const result = await installToPhone({ config: currentConfig(), log: (message) => log(`  ${message}`) })
      return result
    },
  })

  const tools = [syncNowTool, syncStatusTool, syncConflictsTool, syncSetupTool, syncPhoneTool]
  for (const tool of tools) {
    try {
      ctx.tools.register(tool)
    } catch (error) {
      log(`注册工具 ${tool.name} 失败：${error?.message || error}`)
    }
  }

  // ── 设置页 API ──────────────────────────────────────────────
  try {
    const api = createApi({
      log,
      getStatus: () => ({ status: buildStatusSafe() }),
      saveConfig: (patch) => {
        const applied = applyConfigPatch(patch)
        if (applied.ok) {
          runtime.lastError = ''
          scheduleSync(500, 'config')
        }
        return { ...applied, status: buildStatusSafe() }
      },
      probe: async () => probeChannel(currentConfig()),
      sync: (options) => syncOnce({ dryRun: Boolean(options?.dryRun), reason: 'manual' }),
      conflicts: () => {
        const state = loadState()
        const list = Array.isArray(state.conflicts) ? state.conflicts : []
        return {
          total: list.length,
          conflicts: list.slice(0, 50),
          conflictsDir: join(dshHome(), 'sync-fish', 'conflicts'),
        }
      },
      clearConflicts: () => {
        const state = loadState()
        const count = Array.isArray(state.conflicts) ? state.conflicts.length : 0
        state.conflicts = []
        saveState(state)
        return { cleared: count }
      },
      phoneInfo,
      version: VERSION,
      checkUpdate: () => checkUpdate({ current: VERSION }),
      phoneInstall: () => {
        const lines = []
        const promise = installToPhone({
          config: currentConfig(),
          log: (message) => {
            lines.push(message)
            log(`  ${message}`)
          },
        })
        return { promise, lines }
      },
    })
    ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/api/sync-fish', handler: api }), 'sync-fish api')
    log('设置页 API 已挂到 /api/sync-fish')
  } catch (error) {
    log(`设置页 API 挂不上（不影响工具）：${error?.message || error}`)
  }

  // 同步版的 status：API 里不想 await 网络探测
  function buildStatusSafe() {
    const config = currentConfig()
    const state = loadState()
    const described = describeConfig(config)
    const global = readGlobalLib()
    const conflicts = Array.isArray(state.conflicts) ? state.conflicts.length : 0
    return {
      version: VERSION,
      enabled: described.enabled,
      deviceId: state.deviceId,
      deviceName: described.deviceName,
      channel: described.channel,
      config: described,
      encrypted: described.encrypted,
      lastSyncAt: state.lastSyncAt,
      lastError: runtime.lastError || '',
      running: Boolean(runtime.running),
      conflicts,
      scopes: described.scopes,
      memory: { globalRecords: global ? global.memories.length : 0, stores: listStoreFiles().length, mode: fishMode() },
      files: { targets: buildTargets(config).map((item) => item.key) },
      devices: state.lastResult?.remoteDevices || [],
      intervalMinutes: described.intervalMinutes,
      syncOnStart: described.syncOnStart,
      debounceSeconds: described.debounceSeconds,
      validation: validateConfig(config),
      // 设置页的「手机」卡片要看这里：adb 是否找到、当前连了哪台机。
      // 以前这里只放了 adbPath/deviceName，客户端读 phone.adb 永远是 undefined，于是一直显示「没看到手机」。
      phone: { ...phoneInfo(), adbPath: described.phone.adbPath, deviceName: described.phone.deviceName },
      paths: { config: configPath(), state: statePath(), log: logPath(), data: join(dshHome(), 'sync-fish') },
    }
  }

  // ── 启动 / 定时 ─────────────────────────────────────────────
  let lastAttempt = Date.now()

  const tick = () => {
    try {
      if (runtime.running) return
      const config = currentConfig()
      if (!config.enabled) return
      const minutes = Number(config.intervalMinutes) || 0
      if (minutes <= 0) return
      if (Date.now() - lastAttempt < minutes * 60_000) return
      lastAttempt = Date.now()
      void syncOnce({ reason: 'timer' })
    } catch (error) {
      log(`定时同步出错：${error?.message || error}`)
    }
  }

  try {
    ctx.effect(() => {
      const timer = nodeSetInterval(tick, 60_000)
      timer.unref?.()
      return () => {
        try {
          nodeClearInterval(timer)
        } catch {
          /* 已经停了 */
        }
        clearScheduled()
      }
    })
  } catch (error) {
    log(`定时器不可用（不影响手动同步）：${error?.message || error}`)
  }

  try {
    const startup = currentConfig()
    if (startup.enabled && startup.syncOnStart) {
      scheduleSync(8000, 'start')
    }
  } catch (error) {
    log(`启动同步排不上：${error?.message || error}`)
  }

  log(`插件已加载（工具 ${tools.length} 个）`)
}

/**
 * 用宿主 configEditor 读写「其他插件的设置」（cordis 配置）。
 * 拿不到服务时返回 null，engine 会跳过这一块，不影响记忆/文件同步。
 */
function createPluginConfigHost(ctx) {
  let editor = null
  try {
    editor = ctx.get('configEditor')
  } catch {
    editor = null
  }
  if (!editor || typeof editor.configuration !== 'function' || typeof editor.edit !== 'function') {
    return null
  }

  const entries = new Map()
  const rawOverrides = new Map()
  const isOurs = (entry) => {
    const id = String(entry?.id || '')
    const name = String(entry?.name || '')
    return id === 'sync-fish' || /cyberrelic|dsh-sync-fish/i.test(name) || /sync-fish/i.test(id)
  }

  return {
    readPluginConfigs() {
      entries.clear()
      rawOverrides.clear()
      const out = []
      let rows = []
      try {
        rows = editor.configuration() || []
      } catch {
        return out
      }
      for (const row of rows) {
        const entry = row?.entry
        if (!entry || isOurs(entry)) continue
        const id = String(entry.id || '')
        if (!id || entries.has(id)) continue
        entries.set(id, entry)
        rawOverrides.set(id, row.override || {})
        out.push({
          id,
          name: String(entry.name || id),
          config: sanitizeConfig(row.override || {}),
        })
      }
      return out
    },

    async applyPluginConfigs(changes) {
      for (const change of Array.isArray(changes) ? changes : []) {
        const entry = entries.get(change.id)
        if (!entry) continue
        // 合并出来的是脱敏后的 config；写回前把本机的路径/密码等键补回去，
        // 否则「同步一条别的设置」会把 pythonPath 之类一起抹掉。
        const next = restoreDenied(change.config, rawOverrides.get(change.id) || {})
        await editor.edit(entry, () => next)
      }
    },
  }
}
