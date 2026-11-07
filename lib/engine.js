// lib/engine.js —— 一轮同步
//
//  1. 列出远端 devices/<deviceId>.json 快照并解密
//  2. 记忆：本地各会话库 + 全局库 + 远端快照 → 按 id 合并 → 写全局库 → 注回本地库
//  3. 文件（习惯）：本地扫描 ↔ 远端快照 ↔ 上次基线，三方合并
//  4. 把自己的快照写成 devices/<自己>.json，更新 manifest.json
//  5. 更新 state（基线、冲突、历史）
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { mkdirp, nowIso, resolveKey, writeFileAtomicSync } from './util.js'
import { makeChannel } from './channel.js'
import { describeConfig, isScopeEnabled, validateConfig } from './config.js'
import { isEnvelope, open as openEnvelope, seal } from './crypto.js'
import { ensureDeviceId } from './state.js'
import {
  fileMapToObject,
  fileObjectToMap,
  memoryHashes,
  mergeFileSets,
  mergeMemoryViews,
  recordHash,
  recordTime,
} from './merge.js'
import {
  collectLocalMemory,
  injectIntoAllStores,
  writeGlobalLib,
} from './memory.js'
import {
  applyFileWrites,
  buildTargets,
  keyAllowedByTargets,
  mergeWorkspaceRegistries,
  saveConflictCopy,
  snapshotFiles,
} from './files.js'
import { mergePluginConfigs, toConfigMap } from './plugin-configs.js'

export const SNAPSHOT_FORMAT = 'dsh-sync-fish/device/v1'
export const MANIFEST_FORMAT = 'dsh-sync-fish/manifest/v1'

export function remotePrefixOf(config) {
  return String(config.remotePrefix || 'dsh-sync-fish').replace(/^\/+|\/+$/g, '') || 'dsh-sync-fish'
}

export function snapshotPath(prefix, deviceId) {
  return `${prefix}/devices/${String(deviceId).replace(/[^a-zA-Z0-9_-]/g, '_')}.json`
}

export function manifestPath(prefix) {
  return `${prefix}/manifest.json`
}

function parseSnapshot(text, config) {
  let value = typeof text === 'string' ? JSON.parse(text) : text
  if (isEnvelope(value)) {
    if (!config.passphrase) {
      const error = new Error('远端数据是加密的，但没有配置口令（passphrase）')
      error.code = 'SYNC_ENCRYPTED'
      throw error
    }
    value = openEnvelope(value, config.passphrase)
    if (typeof value === 'string') value = JSON.parse(value)
  }
  const data = value
  if (!data || typeof data !== 'object' || data.format !== SNAPSHOT_FORMAT) return null
  return {
    deviceId: String(data.deviceId || ''),
    deviceName: String(data.deviceName || data.deviceId || ''),
    updatedAt: String(data.updatedAt || ''),
    memory: data.memory
      ? {
          memories: Array.isArray(data.memory.memories) ? data.memory.memories : [],
          deleted: Array.isArray(data.memory.deleted) ? data.memory.deleted : [],
          policy: data.memory.policy || null,
        }
      : null,
    files: fileObjectToMap(data.files),
    pluginConfigs:
      data.pluginConfigs && typeof data.pluginConfigs === 'object' ? data.pluginConfigs : null,
  }
}

/** 读所有其它设备的快照（用自己的 deviceId 排除自己） */
export async function readRemoteSnapshots(channel, config, { excludeDeviceId = '' } = {}) {
  const prefix = remotePrefixOf(config)
  const paths = await channel.list(`${prefix}/devices`)
  const snapshots = []
  const problems = []
  for (const path of paths) {
    if (!path.endsWith('.json')) continue
    const id = path.slice(path.lastIndexOf('/') + 1).replace(/\.json$/, '')
    if (id && id === String(excludeDeviceId).replace(/[^a-zA-Z0-9_-]/g, '_')) continue
    let text
    try {
      text = await channel.read(path)
    } catch (error) {
      problems.push(`读取 ${path} 失败：${error?.message || error}`)
      continue
    }
    if (text == null) continue
    try {
      const snapshot = parseSnapshot(text, config)
      if (snapshot && snapshot.deviceId) snapshots.push(snapshot)
      else problems.push(`跳过无法识别的快照 ${path}`)
    } catch (error) {
      if (error && (error.code === 'SYNC_ENCRYPTED' || error.code === 'SYNC_DECRYPT')) {
        error.message = `${path}：${error.message}`
        throw error
      }
      problems.push(`快照 ${path} 解不开：${error?.message || error}`)
    }
  }
  snapshots.sort((a, b) => String(a.deviceId).localeCompare(String(b.deviceId)))
  return { snapshots, problems }
}

function capView(view, maxRecords) {
  const limit = Math.max(100, Number(maxRecords) || 5000)
  const memories = (view.memories || []).slice()
  let deleted = (view.deleted || []).slice()
  if (memories.length > limit) {
    memories.sort((a, b) => recordTime(b) - recordTime(a))
    memories.length = limit
    memories.sort((a, b) => recordTime(a) - recordTime(b))
  }
  if (deleted.length > limit) {
    deleted.sort((a, b) => String(b?.deletedAt || '').localeCompare(String(a?.deletedAt || '')))
    deleted.length = limit
  }
  return { memories, deleted, policy: view.policy || null }
}

/** 记忆冲突：base 里同一个 id，两边各自改成不同内容 */
function memoryConflicts(localView, remoteView, baseHashes) {
  const local = memoryHashes(localView.memories)
  const remote = memoryHashes(remoteView.memories)
  const conflicts = []
  for (const id of Object.keys(baseHashes)) {
    const b = baseHashes[id]
    const l = local[id]
    const r = remote[id]
    if (!b || !l || !r) continue
    if (l !== b && r !== b && l !== r) {
      conflicts.push({ kind: 'memory', id, localHash: l, remoteHash: r })
    }
  }
  return conflicts
}

/**
 * 跑一轮同步。
 * @param {object} options { config, state, dryRun?, log? }
 * @returns {Promise<object>} 结果摘要（同时已写进 state.lastResult）
 */
export async function runSync({ config, state, dryRun = false, log = () => {}, host = null }) {
  const startedAt = Date.now()
  const validation = validateConfig(config)
  if (validation.errors.length) throw new Error(validation.errors.join('；'))
  const warnings = [...validation.warnings]

  const channel = makeChannel(config.channel)
  const prefix = remotePrefixOf(config)
  const deviceId = ensureDeviceId(state)
  const deviceName = config.deviceName || 'device'
  state.deviceName = deviceName
  log(`同步开始：${deviceName}（${channel.type}）`)

  // ── 1) 远端快照 ───────────────────────────────────────────────
  const { snapshots, problems } = await readRemoteSnapshots(channel, config, { excludeDeviceId: deviceId })
  warnings.push(...problems)
  log(`读到 ${snapshots.length} 台其它设备的快照`)

  // ── 2) 记忆 ─────────────────────────────────────────────────
  const memoryOn = isScopeEnabled(config, 'memory') && config.memory?.enabled !== false
  let mergedView = { memories: [], deleted: [], policy: null }
  let conflicts = []
  const memoryResult = { enabled: memoryOn, records: 0, added: 0 }
  if (memoryOn) {
    const local = collectLocalMemory()
    const remoteMemoryView = mergeMemoryViews(snapshots.map((s) => s.memory).filter(Boolean))
    mergedView = capView(mergeMemoryViews([local.view, remoteMemoryView]), config.memory?.maxRecords)
    conflicts = memoryConflicts(local.view, remoteMemoryView, state.base?.memory || {})
    memoryResult.records = mergedView.memories.length
    if (!dryRun) {
      writeGlobalLib(mergedView)
      const injections = injectIntoAllStores(mergedView)
      memoryResult.added = injections.reduce((sum, item) => sum + (item.added || 0), 0)
      memoryResult.stores = injections.length
      memoryResult.changedStores = injections.filter((item) => item.changed).length
    }
    log(`记忆：全局 ${mergedView.memories.length} 条，注入 +${memoryResult.added}`)
  } else {
    log('记忆同步：已关闭（scopes.memory=false）')
  }

  // ── 3) 文件 ─────────────────────────────────────────────────
  const targets = buildTargets(config)
  const allowed = (key) => keyAllowedByTargets(key, targets)
  // 只接受本地开了的分类里的远端文件：别的设备开着任务同步，不会把任务塞给关了它的本机
  for (const snapshot of snapshots) {
    snapshot.files = new Map([...snapshot.files].filter(([key]) => allowed(key)))
  }

  // 工作区注册表先按 title/path 合并一次，再进通用的三方合并
  if (!dryRun) {
    for (const target of targets.filter((item) => item.kind === 'workspace')) {
      try {
        const abs = resolveKey(target.key)
        let text = null
        try {
          text = readFileSync(abs, 'utf8')
        } catch {
          text = null
        }
        const remoteTexts = snapshots
          .map((snapshot) => snapshot.files.get(target.key)?.text)
          .filter((item) => typeof item === 'string')
        const merged = mergeWorkspaceRegistries(text, remoteTexts)
        if (merged.changed && merged.added + merged.updated > 0) {
          mkdirp(dirname(abs))
          writeFileAtomicSync(abs, merged.text)
          log(`工作区注册表：新增 ${merged.added} 个，更新 ${merged.updated} 个`)
        }
      } catch (error) {
        warnings.push(`合并工作区注册表失败：${error?.message || error}`)
      }
    }
  }

  const limits = config.limits || {}
  const localFiles = snapshotFiles(targets, limits)
  warnings.push(...localFiles.warnings)

  const baseFiles = new Map(Object.entries(state.base?.files || {}).filter(([key]) => allowed(key)))

  const fileMerge = mergeFileSets({
    local: localFiles.map,
    remotes: snapshots.map((s) => ({
      deviceId: s.deviceId,
      deviceName: s.deviceName,
      updatedAt: s.updatedAt,
      files: s.files,
    })),
    base: baseFiles,
  })

  let fileResult = { written: [], failed: [], conflicts: fileMerge.conflicts.length, restored: fileMerge.restored }
  if (!dryRun) {
    const applied = applyFileWrites(fileMerge.writes)
    fileResult.written = applied.written
    fileResult.failed = applied.failed
    fileResult.conflictCopies = fileMerge.conflicts
      .map((conflict) => {
        try {
          return saveConflictCopy(conflict, { deviceName })
        } catch {
          return null
        }
      })
      .filter(Boolean)
    // 写回本地的远端文件：同步更新内存里的本地视图，推给别的设备时才是最新内容
    for (const { key, entry } of fileMerge.writes) {
      if (entry && typeof entry.text === 'string') localFiles.map.set(key, entry)
    }
  }

  const fileConflicts = []
  for (const conflict of fileMerge.conflicts) {
    const localEntry = localFiles.map.get(conflict.key)
    const remoteEntry = snapshots
      .flatMap((s) => [...s.files.entries()])
      .find(([key]) => key === conflict.key)
    fileConflicts.push({
      kind: 'file',
      key: conflict.key,
      localHash: conflict.localHash,
      remoteHash: conflict.remoteHash,
      remoteDevice: conflict.remoteDevice || '',
      localText: typeof localEntry?.text === 'string' ? localEntry.text : null,
      remoteText: typeof remoteEntry?.[1]?.text === 'string' ? remoteEntry[1].text : null,
    })
  }
  log(`文件：${localFiles.map.size} 个，写入 ${fileResult.written.length} 个，冲突 ${fileConflicts.length}`)

  // ── 3.5) 其他插件设置（cordis 配置）────────────────────────────
  // 这些设置由宿主的 configEditor 管，不在文件里；按 entry id 做三方合并。
  const pluginOn = isScopeEnabled(config, 'pluginConfigs')
  const pluginResult = { enabled: pluginOn, entries: 0, applied: 0, conflicts: 0 }
  let snapshotPluginConfigs = {}
  if (pluginOn && host && typeof host.readPluginConfigs === 'function') {
    try {
      const localMap = toConfigMap(host.readPluginConfigs())
      const remoteMap = {}
      for (const snapshot of snapshots) {
        for (const [id, item] of Object.entries(snapshot.pluginConfigs || {})) {
          const prev = remoteMap[id]
          if (!prev || String(snapshot.updatedAt) > String(prev.updatedAt)) {
            remoteMap[id] = {
              name: item?.name || id,
              config: item?.config || {},
              updatedAt: snapshot.updatedAt,
            }
          }
        }
      }
      const merged = mergePluginConfigs({
        local: localMap,
        base: state.base?.pluginConfigs || {},
        remotes: remoteMap,
      })
      pluginResult.entries = Object.keys(merged.merged).length
      pluginResult.conflicts = merged.conflicts.length
      conflicts.push(...merged.conflicts)
      if (!dryRun && merged.changes.length > 0) {
        await host.applyPluginConfigs(merged.changes)
        pluginResult.applied = merged.changes.length
      }
      if (!dryRun) {
        // 记两份基线：本机这次落地的值 + 看到的远端值。
        // 只记本机值的话，远端的旧值下一轮会被当成「远端改了」再顶回来。
        state.base.pluginConfigs = merged.nextBase || {}
      }
      snapshotPluginConfigs = Object.fromEntries(
        Object.entries(merged.merged).map(([id, item]) => [id, { name: item.name, config: item.config }]),
      )
      log(`插件配置：${pluginResult.entries} 项，写入 ${pluginResult.applied}`)
    } catch (error) {
      warnings.push(`同步插件配置失败：${error?.message || error}`)
    }
  } else if (pluginOn) {
    log('插件配置同步：宿主没有 configEditor 服务，跳过')
  }

  // ── 4) 写自己的快照 + manifest ───────────────────────────────
  const filesObject = fileMapToObject(localFiles.map)
  const snapshot = {
    format: SNAPSHOT_FORMAT,
    version: 2,
    deviceId,
    deviceName,
    updatedAt: nowIso(),
    host: config.deviceName || '',
    scopes: describeConfig(config).scopes,
    files: filesObject,
  }
  // 关掉记忆同步时干脆不写 memory 字段：别的设备读到的是「没带记忆」，不会当成清空
  if (memoryOn) snapshot.memory = mergedView
  if (pluginOn) snapshot.pluginConfigs = snapshotPluginConfigs
  let snapshotText = JSON.stringify(snapshot)
  if (config.passphrase) snapshotText = JSON.stringify(seal(snapshotText, config.passphrase))

  if (!dryRun) {
    await channel.write(snapshotPath(prefix, deviceId), snapshotText)
    await updateManifest(channel, config, deviceId, deviceName, mergedView, filesObject)
  }

  // ── 5) 收尾 ─────────────────────────────────────────────────
  const finishedAt = Date.now()
  const result = {
    ok: true,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    durationMs: finishedAt - startedAt,
    dryRun: Boolean(dryRun),
    deviceId,
    deviceName,
    channel: describeConfig(config).channel,
    remoteDevices: snapshots.map((s) => s.deviceName || s.deviceId),
    memory: memoryResult,
    pluginConfigs: pluginResult,
    files: {
      total: localFiles.map.size,
      written: fileResult.written,
      failed: fileResult.failed,
      restored: fileResult.restored,
      targets: targets.map((item) => item.key),
    },
    scopes: describeConfig(config).scopes,
    conflicts: [...conflicts.map((c) => ({ ...c, at: nowIso() })), ...fileConflicts.map((c) => ({ ...c, at: nowIso() }))],
    warnings: warnings.slice(0, 50),
  }

  if (!dryRun) {
    state.base = {
      memory: memoryHashes(mergedView.memories),
      files: fileMapToObject(fileMerge.nextBase),
      pluginConfigs: state.base?.pluginConfigs || {},
    }
    state.lastSyncAt = result.finishedAt
    state.lastResult = result
    state.conflicts = [...result.conflicts, ...(state.conflicts || [])].slice(0, 50)
    state.history = [result, ...(state.history || [])].slice(0, 20)
  }

  log(`同步完成：${result.durationMs}ms`)
  return result
}

async function updateManifest(channel, config, deviceId, deviceName, memoryView, filesObject) {
  const prefix = remotePrefixOf(config)
  let manifest = null
  try {
    const text = await channel.read(manifestPath(prefix))
    if (text) {
      const parsed = JSON.parse(text)
      if (parsed && parsed.format === MANIFEST_FORMAT) manifest = parsed
    }
  } catch {
    /* 坏了就重建 */
  }
  const devices = { ...(manifest?.devices || {}) }
  const fileList = Object.values(filesObject)
  devices[deviceId] = {
    name: deviceName,
    updatedAt: nowIso(),
    memoryCount: memoryView.memories.length,
    fileCount: fileList.length,
    fileKeys: fileList.map((entry) => entry && entry.hash).filter(Boolean).length,
  }
  const next = { format: MANIFEST_FORMAT, version: 1, updatedAt: nowIso(), devices }
  await channel.write(manifestPath(prefix), JSON.stringify(next))
}
