// lib/files.js —— 「习惯」类文件的扫描 / 三方合并 / 落盘
//
// 目标由 config.scopes + config.extraTargets 决定，每项 { key, kind }：
//   kind = 'file'     单个文件
//        | 'tree'     目录树
//        | 'glob'     固定目录里的通配（只支持 basename 里的 *）
//        | 'workspace' 工作区注册表（特殊的合并规则）
// key 用 ~ 形式（如 ~/.dsh/skills/foo.md），两台机各自展开自己的 home。
import { readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join, posix } from 'node:path'
import {
  dshHome,
  fileStat,
  formatBytes,
  isDir,
  listTreeFiles,
  looksLikeText,
  mkdirp,
  resolveKey,
  sha256,
  stableStringify,
  writeFileAtomicSync,
} from './util.js'

/** 同步分类的默认开关。memory 由记忆模块单独处理，其余对应文件目标 */
export const DEFAULT_SCOPES = {
  memory: true,
  skills: true,
  plugins: true,
  tasks: true,
  workspaces: false,
}

/** v1 的默认目标，只用于迁移老配置 */
export const DEFAULT_FILE_TARGETS = [
  { path: '~/.dsh/skills', kind: 'tree' },
  { path: '~/.dsh/settings.yaml', kind: 'file' },
]

const KINDS = new Set(['file', 'tree', 'glob', 'workspace'])

export function normalizeTargets(targets) {
  const list = Array.isArray(targets) ? targets : []
  const out = []
  for (const item of list) {
    const raw = typeof item === 'string' ? { path: item } : item
    // 兼容两种写法：{ path: '~/.dsh/skills' } 和已经归一化过的 { key: '~/.dsh/skills' }
    const rawPath = raw && (raw.path != null ? raw.path : raw.key)
    if (typeof rawPath !== 'string') continue
    const key = rawPath.trim().replace(/\\/g, '/').replace(/\/+$/, '')
    if (!key) continue
    const kind = KINDS.has(raw.kind) ? raw.kind : 'tree'
    out.push({ key, kind })
  }
  return out
}

/** 按开关生成这一轮要同步的文件目标（去重） */
export function buildTargets(config = {}) {
  const scopes = { ...DEFAULT_SCOPES, ...(config.scopes || {}) }
  const targets = []
  const push = (target) => {
    if (!targets.some((item) => item.key === target.key)) targets.push(target)
  }
  if (scopes.skills !== false) push({ key: '~/.dsh/skills', kind: 'tree' })
  if (scopes.plugins !== false) {
    push({ key: '~/.dsh/*-config.json', kind: 'glob' })
    push({ key: '~/.dsh/tts-bridge.json', kind: 'file' })
  }
  if (scopes.tasks !== false) push({ key: '~/.dsh/storages/schedule.json', kind: 'file' })
  if (scopes.workspaces === true) push({ key: '~/.dsh/storages/workspace.json', kind: 'workspace' })
  for (const extra of normalizeTargets(config.extraTargets)) push(extra)
  return targets
}

export function targetAbs(target) {
  return resolveKey(target.key)
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function globRegExp(pattern) {
  return new RegExp('^' + String(pattern).split('*').map(escapeRegExp).join('[^/]*') + '$')
}

/** 一个 key 是否落在某个目标范围内（用来只接受自己开了的分类的远端文件） */
export function keyAllowedByTargets(key, targets) {
  for (const target of targets) {
    if (target.kind === 'tree') {
      if (key === target.key || key.startsWith(target.key + '/')) return true
    } else if (target.kind === 'glob') {
      if (globRegExp(target.key).test(key)) return true
    } else if (key === target.key) return true
  }
  return false
}

function expandGlob(key) {
  const abs = resolveKey(key)
  const dir = dirname(key)
  const pattern = basename(key)
  if (!pattern.includes('*')) return [{ key, abs }]
  let names = []
  try {
    names = readdirSync(resolveKey(dir))
  } catch {
    return []
  }
  const re = new RegExp('^' + pattern.split('*').map(escapeRegExp).join('.*') + '$')
  return names
    .filter((name) => re.test(name))
    .sort()
    .map((name) => ({ key: posix.join(dir, name), abs: join(resolveKey(dir), name) }))
}

/**
 * 扫本地目标 → Map key → { hash, text, mtime, size }
 * 返回 { map, warnings, totalBytes }
 */
export function snapshotFiles(targets, limits = {}) {
  const maxFileBytes = Number(limits.maxFileBytes) || 2 * 1024 * 1024
  const maxTotalBytes = Number(limits.maxTotalBytes) || 20 * 1024 * 1024
  const map = new Map()
  const warnings = []
  let total = 0

  const addFile = (key, abs) => {
    const stat = fileStat(abs)
    if (!stat || !stat.isFile()) return
    if (stat.size > maxFileBytes) {
      warnings.push(`跳过过大文件 ${key}（${formatBytes(stat.size)}）`)
      return
    }
    if (total + stat.size > maxTotalBytes) {
      warnings.push(`达到总量上限，跳过 ${key}`)
      return
    }
    let buf
    try {
      buf = readFileSync(abs)
    } catch (error) {
      warnings.push(`读不了 ${key}：${error?.message || error}`)
      return
    }
    if (!looksLikeText(buf)) {
      warnings.push(`跳过二进制文件 ${key}`)
      return
    }
    const text = buf.toString('utf8')
    map.set(key, { hash: sha256(text), text, mtime: Math.round(stat.mtimeMs), size: stat.size })
    total += stat.size
  }

  for (const target of targets) {
    if (target.kind === 'glob') {
      for (const match of expandGlob(target.key)) addFile(match.key, match.abs)
      continue
    }
    const abs = targetAbs(target)
    if (target.kind === 'file' || target.kind === 'workspace') {
      addFile(target.key, abs)
      continue
    }
    if (!isDir(abs)) continue
    for (const { abs: fileAbs, rel } of listTreeFiles(abs)) {
      addFile(posix.join(target.key, rel), fileAbs)
    }
  }
  return { map, warnings, totalBytes: total }
}

// ── 工作区注册表（~/.dsh/storages/workspace.json） ───────────────

export function parseWorkspaceRegistry(text) {
  if (!text || typeof text !== 'string') return null
  try {
    const value = JSON.parse(text)
    if (!value || typeof value !== 'object') return null
    value.global = value.global && typeof value.global === 'object' ? value.global : {}
    value.tables = value.tables && typeof value.tables === 'object' ? value.tables : {}
    value.tables.workspaces =
      value.tables.workspaces && typeof value.tables.workspaces === 'object' ? value.tables.workspaces : {}
    return value
  } catch {
    return null
  }
}

function workspaceTitleKey(workspace, id) {
  const title = String(workspace?.title || workspace?.path || id || '').trim().toLowerCase().replace(/\\/g, '/')
  return title || String(id)
}

function workspaceTime(workspace) {
  const time = Date.parse(String(workspace?.updatedAt || workspace?.createdAt || ''))
  return Number.isFinite(time) ? time : 0
}

/**
 * 合并多台机器的工作区注册表：
 *  · 按 id 合并，同 id 取 updatedAt 较新的（但 sessionIds 永远留本机的）
 *  · 远端新工作区按 title/path 去重后加入，并把 id 补进 global.workspaceIds
 *  · 远端工作区自带的会话 id 不跨机带过来（路径和会话都不通用）
 */
export function mergeWorkspaceRegistries(localText, remoteTexts = []) {
  const parsedLocal = parseWorkspaceRegistry(localText)
  const local = parsedLocal || { global: { workspaceIds: [] }, tables: { workspaces: {} } }
  const merged = JSON.parse(JSON.stringify(local))
  merged.global.workspaceIds = Array.isArray(merged.global.workspaceIds) ? merged.global.workspaceIds.slice() : []

  const byTitle = new Map()
  for (const [id, workspace] of Object.entries(merged.tables.workspaces)) {
    byTitle.set(workspaceTitleKey(workspace, id), id)
  }

  let added = 0
  let updated = 0
  for (const text of remoteTexts) {
    const remote = parseWorkspaceRegistry(text)
    if (!remote) continue
    for (const [id, workspace] of Object.entries(remote.tables.workspaces)) {
      const mine = merged.tables.workspaces[id]
      if (mine) {
        if (workspaceTime(workspace) > workspaceTime(mine)) {
          merged.tables.workspaces[id] = {
            ...workspace,
            sessionIds: Array.isArray(mine.sessionIds) ? mine.sessionIds : [],
          }
          updated++
        }
        continue
      }
      const titleKey = workspaceTitleKey(workspace, id)
      if (byTitle.has(titleKey)) continue
      merged.tables.workspaces[id] = {
        ...workspace,
        sessionIds: [],
      }
      if (!merged.global.workspaceIds.includes(id)) merged.global.workspaceIds.push(id)
      byTitle.set(titleKey, id)
      added++
    }
  }

  const text = JSON.stringify(merged, null, 2) + '\n'
  const changed = !parsedLocal || stableStringify(merged) !== stableStringify(local)
  return { text, changed, added, updated }
}

/** 把远端冲突副本写到 ~/.dsh/sync-fish/conflicts/<设备>/<时间>-<扁平化key> */
export function saveConflictCopy(conflict, { deviceName = 'remote', now = new Date() } = {}) {
  if (typeof conflict.remoteText !== 'string') return null
  const root = join(dshHome(), 'sync-fish', 'conflicts', sanitize(deviceName))
  const flat = conflict.key.replace(/^~[\\/]/, '').replace(/[\\/]/g, '__')
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  const file = join(root, `${stamp}-${flat}`)
  mkdirp(root)
  writeFileAtomicSync(file, conflict.remoteText)
  return file
}

function sanitize(name) {
  return String(name || 'remote').replace(/[^\w.-]+/g, '_').slice(0, 40) || 'remote'
}

export function applyFileWrites(writes) {
  const written = []
  const failed = []
  for (const { key, entry } of writes) {
    if (!entry || typeof entry.text !== 'string') continue
    const abs = resolveKey(key)
    try {
      mkdirp(join(dshHome(), 'sync-fish'))
      writeFileAtomicSync(abs, entry.text)
      written.push(key)
    } catch (error) {
      failed.push({ key, error: error?.message || String(error) })
    }
  }
  return { written, failed }
}
