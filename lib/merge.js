// lib/merge.js —— 纯合并逻辑（不碰磁盘，便于单测）
//
// 记忆：按 id 的 last-writer-wins，带墓碑（deleted 永远赢，跟 dsh-fish-memory 一致）；
//       同一段正文（归一化后相等）只留最新一条，防止两台机各记一遍变成两条。
// 文件：三方合并（base / local / remote），冲突时保留本地并把远端另存一份。
import { sha256, stableStringify } from './util.js'

const TIME_FIELDS = ['editedAt', 'relatedAt', 'reinforcedAt', 'deletedAt', 'createdAt', 'at']

export function recordTime(m) {
  let max = 0
  for (const field of TIME_FIELDS) {
    const t = m && m[field] ? Date.parse(m[field]) : 0
    if (Number.isFinite(t) && t > max) max = t
  }
  return max
}

export function normText(text) {
  return String(text == null ? '' : text)
    .replace(/[\s，。、！？,.!?；;：:"'“”‘’]/g, '')
    .toLowerCase()
}

/** 只拿「内容」算哈希：时间戳变了不算内容变化 */
export function canonicalRecord(m) {
  const pick = {}
  for (const key of ['text', 'tags', 'importance', 'category', 'source', 'at', '事实键', 'emotion']) {
    if (m && m[key] !== undefined) pick[key] = m[key]
  }
  return stableStringify(pick)
}

export function recordHash(m) {
  return sha256(canonicalRecord(m))
}

export function tombstoneTime(m) {
  const t = m && m.deletedAt ? Date.parse(m.deletedAt) : 0
  return Number.isFinite(t) ? t : 0
}

/**
 * 合并若干记忆视图：{ memories: [...], deleted: [...], policy?: {} }
 * 返回 { memories, deleted, policy }
 */
export function mergeMemoryViews(views) {
  const memories = new Map()
  const deleted = new Map()
  let policy = null

  for (const view of views) {
    if (!view) continue
    if (!policy && view.policy && Object.keys(view.policy).length > 0) policy = view.policy
    for (const m of view.memories || []) {
      if (!m || m.id == null) continue
      const id = String(m.id)
      const old = memories.get(id)
      if (!old) {
        memories.set(id, m)
        continue
      }
      const newer = recordTime(m) - recordTime(old)
      // 时间完全相同但内容不同：用内容哈希做确定性仲裁，保证两台机收敛到同一条
      if (newer > 0 || (newer === 0 && recordHash(m) > recordHash(old))) memories.set(id, m)
    }
    for (const m of view.deleted || []) {
      if (!m || m.id == null) continue
      const id = String(m.id)
      const old = deleted.get(id)
      if (!old || tombstoneTime(m) >= tombstoneTime(old)) deleted.set(id, m)
    }
  }

  for (const id of deleted.keys()) memories.delete(id)

  // 正文去重：同一句话只留最新一条
  const byText = new Map()
  const empty = []
  for (const m of memories.values()) {
    const key = normText(m.text)
    if (!key) {
      empty.push(m)
      continue
    }
    const old = byText.get(key)
    if (!old) {
      byText.set(key, m)
      continue
    }
    const newer = recordTime(m) - recordTime(old)
    if (newer > 0 || (newer === 0 && String(m.id) > String(old.id))) byText.set(key, m)
  }

  const list = [...empty, ...byText.values()]
  list.sort((a, b) => recordTime(a) - recordTime(b) || String(a.id).localeCompare(String(b.id)))
  return { memories: list, deleted: [...deleted.values()], policy }
}

export function memoryHashes(memories) {
  const out = {}
  for (const m of memories || []) out[String(m.id)] = recordHash(m)
  return out
}

/** 文件集合：Map key → { hash, text, mtime } → 普通对象 */
export function fileMapToObject(map) {
  const out = {}
  for (const [key, value] of map) out[key] = value
  return out
}

export function fileObjectToMap(obj) {
  const map = new Map()
  for (const [key, value] of Object.entries(obj || {})) {
    if (value && typeof value.hash === 'string') map.set(key, value)
  }
  return map
}

/**
 * 三方文件合并。
 * @param {Map<string,{hash,text,mtime}>} local
 * @param {Array<{deviceId,deviceName,updatedAt,files:Map}>} remotes
 * @param {Map<string,string>} base  key → hash（上次同步后的内容）
 * @returns {{writes:Array, nextBase:Map, conflicts:Array, fromRemote:Array, restored:Array}}
 */
export function mergeFileSets({ local, remotes, base }) {
  const writes = []
  const conflicts = []
  const nextBase = new Map(base || [])
  const fromRemote = []
  const restored = []

  // 多台远端：同一个 key 取 mtime 最大的那份；mtime 相同取哈希字典序大的（确定性）
  const best = new Map()
  for (const device of remotes || []) {
    for (const [key, entry] of device.files || []) {
      if (!entry || typeof entry.hash !== 'string') continue
      const old = best.get(key)
      if (!old) {
        best.set(key, { ...entry, deviceId: device.deviceId, deviceName: device.deviceName })
        continue
      }
      const newer = (entry.mtime || 0) - (old.mtime || 0)
      if (newer > 0 || (newer === 0 && entry.hash > old.hash)) {
        best.set(key, { ...entry, deviceId: device.deviceId, deviceName: device.deviceName })
      }
    }
  }

  const keys = new Set([...local.keys(), ...best.keys(), ...nextBase.keys()])
  for (const key of keys) {
    const l = local.get(key)
    const r = best.get(key)
    const b = nextBase.get(key)

    if (l && r) {
      if (l.hash === r.hash) {
        nextBase.set(key, l.hash)
      } else if (b && l.hash === b) {
        // 本地没动，远端改了 → 取远端
        writes.push({ key, entry: r })
        nextBase.set(key, r.hash)
        fromRemote.push(key)
      } else if (b && r.hash === b) {
        // 远端没动，本地改了 → 留着，等会儿推上去
        nextBase.set(key, l.hash)
      } else {
        // 两边都改了（或者没有共同基线）→ 冲突：保留本地，远端另存
        conflicts.push({
          kind: 'file',
          key,
          localHash: l.hash,
          remoteHash: r.hash,
          remoteDevice: r.deviceName || r.deviceId || '',
          remoteText: typeof r.text === 'string' ? r.text : null,
        })
        nextBase.set(key, l.hash)
      }
    } else if (!l && r) {
      // 本地没有（新文件，或本地删掉了）。MVP 不做删除传播，直接恢复/新建。
      writes.push({ key, entry: r })
      nextBase.set(key, r.hash)
      restored.push(key)
    } else if (l && !r) {
      // 远端还没有 → 本地先留着，等会儿推上去
      nextBase.set(key, l.hash)
    }
  }

  return { writes, nextBase, conflicts, fromRemote, restored }
}
