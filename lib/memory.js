// lib/memory.js —— 鱼记忆（dsh-fish-memory 的 JSON 库）读写与注入
//
// 设计：每台机把「所有本地会话库」合并成一份全局库（$DSH_HOME/sync-fish/memory/global.json），
// 再和其它设备的快照合并；合并结果按 id 注回每个本地库。
//
// ⚠ 必须遵守 dsh-fish-memory 的 purgeEpoch 守卫：
//   它保存前会拿内存里的 purgeEpoch 跟盘上比，不一致就拒绝写（MEMORY_PURGED）。
//   所以我们改写库文件时**原样保留** purgeEpoch；新建库一律用空串（跟它的 blank() 一致）。
import { readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { dshHome, fileStat, isObject, readJson, readText, stableStringify, writeJsonAtomicSync } from './util.js'
import { mergeMemoryViews, recordTime, recordHash } from './merge.js'

export const STORE_VERSION = 2

export function storeDir() {
  return join(dshHome(), 'fish-memory')
}

export function fishConfigPath() {
  return join(dshHome(), 'fish-memory-config.json')
}

export function fishConfig() {
  const value = readJson(fishConfigPath(), {})
  return isObject(value) ? value : {}
}

export function fishMode() {
  return String(fishConfig().模式 || 'session') === 'workspace' ? 'workspace' : 'session'
}

/** ~/.dsh/sessions/<工作区目录名>/<会话 id> —— 工作区模式下用它当库名 */
export function workspaceDirForSession(sid) {
  try {
    const root = join(dshHome(), 'sessions')
    for (const workspace of readdirSync(root, { withFileTypes: true })) {
      if (!workspace.isDirectory()) continue
      if (fileStat(join(root, workspace.name, String(sid)))) return workspace.name
    }
  } catch {
    /* 没有就当算不出来 */
  }
  return ''
}

export function fishStoreName(sid) {
  const s = String(sid || '')
  if (!s) return ''
  if (fishMode() === 'workspace') {
    const ws = workspaceDirForSession(s)
    if (ws) return `ws_${ws}`
  }
  return s
}

export function fishStorePath(sid) {
  const name = fishStoreName(sid)
  if (!name) return ''
  return join(storeDir(), `${name.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`)
}

export function fishMemoryEnabled(sid) {
  const config = fishConfig()
  if (config.全局开关 === false) return false
  const key = String(sid)
  const sessions = config.sessions
  if (isObject(sessions) && Object.prototype.hasOwnProperty.call(sessions, key)) return Boolean(sessions[key])
  if (Array.isArray(config.enabled) && config.enabled.indexOf(key) >= 0) return true
  return true
}

/** 读一个库文件；坏 JSON 不碰（交给 fish-memory 自己恢复） */
export function readStoreFile(file) {
  const text = readText(file)
  if (text == null || text === '') return null
  let raw
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isObject(raw)) return null
  return {
    raw,
    purgeEpoch: typeof raw.purgeEpoch === 'string' ? raw.purgeEpoch : '',
    policy: isObject(raw.policy) ? raw.policy : null,
    traces: Array.isArray(raw.traces) ? raw.traces : [],
    memories: Array.isArray(raw.memories) ? raw.memories : [],
    deleted: Array.isArray(raw.deleted) ? raw.deleted : [],
  }
}

export function listStoreFiles() {
  try {
    return readdirSync(storeDir(), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => join(storeDir(), entry.name))
      .sort()
  } catch {
    return []
  }
}

export function storeView(store) {
  return store ? { memories: store.memories, deleted: store.deleted, policy: store.policy } : null
}

export function globalLibPath() {
  return join(dshHome(), 'sync-fish', 'memory', 'global.json')
}

export function readGlobalLib() {
  const raw = readJson(globalLibPath(), null)
  if (!isObject(raw)) return null
  return {
    version: 1,
    updatedAt: raw.updatedAt || '',
    memories: Array.isArray(raw.memories) ? raw.memories : [],
    deleted: Array.isArray(raw.deleted) ? raw.deleted : [],
    policy: isObject(raw.policy) ? raw.policy : null,
  }
}

export function writeGlobalLib(view) {
  const target = globalLibPath()
  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    memories: (view.memories || []).slice(),
    deleted: (view.deleted || []).slice(),
    policy: view.policy || null,
  }
  writeJsonAtomicSync(target, payload)
  return target
}

/** 汇总本地所有会话库 + 已有全局库 → 一个本地视图 */
export function collectLocalMemory() {
  const stores = []
  for (const file of listStoreFiles()) {
    const store = readStoreFile(file)
    if (!store) continue
    stores.push({ file, name: basename(file, '.json'), store })
  }
  const global = readGlobalLib()
  const view = mergeMemoryViews([global, ...stores.map((s) => storeView(s.store))])
  return { stores, global, view }
}

function contentStamp(store) {
  const list = (store.memories || [])
    .map((m) => [String(m.id), recordTime(m), recordHash(m)])
    .sort((a, b) => a[0].localeCompare(b[0]))
  const tombstones = (store.deleted || [])
    .map((m) => [String(m.id), m && m.deletedAt ? String(m.deletedAt) : ''])
    .sort((a, b) => a[0].localeCompare(b[0]))
  return stableStringify({ list, tombstones })
}

/**
 * 把全局记忆注进一个库文件。
 * 已有文件：保留 purgeEpoch / traces，只补新记录、应用墓碑。
 * 文件不存在且 allowCreate：按 blank() 的形状新建（purgeEpoch 空串）。
 */
export function injectIntoStore(file, globalView, { allowCreate = false } = {}) {
  const existing = readStoreFile(file)
  if (!existing) {
    if (!allowCreate) return { file, changed: false, skipped: 'missing' }
    if (!globalView || !globalView.memories || globalView.memories.length === 0) {
      return { file, changed: false, skipped: 'empty-global' }
    }
    const fresh = {
      version: STORE_VERSION,
      purgeEpoch: '',
      policy: globalView.policy || undefined,
      memories: globalView.memories.slice(),
      traces: [],
      deleted: globalView.deleted ? globalView.deleted.slice() : [],
    }
    const stamp = contentStamp(fresh)
    writeJsonAtomicSync(file, fresh)
    return { file, changed: true, created: true, added: fresh.memories.length, stamp }
  }

  const merged = mergeMemoryViews([existing, globalView])
  const next = {
    version: STORE_VERSION,
    purgeEpoch: existing.purgeEpoch,
    policy: existing.policy || globalView?.policy || undefined,
    memories: merged.memories,
    traces: existing.traces,
    deleted: merged.deleted,
  }
  const before = contentStamp(existing)
  const after = contentStamp(next)
  if (before === after) return { file, changed: false, stamp: after }
  const known = new Set(existing.memories.map((m) => String(m.id)))
  const added = next.memories.filter((m) => !known.has(String(m.id))).length
  writeJsonAtomicSync(file, next)
  return { file, changed: true, added, stamp: after }
}

export function ensureStoreForSession(sid, globalView) {
  if (!sid) return { file: '', changed: false, skipped: 'no-session' }
  if (!fishMemoryEnabled(sid)) return { file: '', changed: false, skipped: 'session-off' }
  const file = fishStorePath(sid)
  if (!file) return { file: '', changed: false, skipped: 'no-path' }
  return injectIntoStore(file, globalView, { allowCreate: true })
}

export function injectIntoAllStores(globalView) {
  const results = []
  for (const file of listStoreFiles()) results.push(injectIntoStore(file, globalView))
  return results
}
