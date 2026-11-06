// lib/config.js —— 配置：默认值 ⊕ $DSH_HOME/sync-fish/config.json ⊕ 插件行 config
import { hostname } from 'node:os'
import { join } from 'node:path'
import { dshHome, isObject, readJson, writeJsonAtomicSync } from './util.js'
import { DEFAULT_SCOPES, normalizeTargets } from './files.js'

export const CONFIG_VERSION = 2

export function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    enabled: true,
    deviceName: hostname(),
    channel: { type: 'folder', root: '', url: '', username: '', password: '', prefix: '' },
    passphrase: '',
    intervalMinutes: 30,
    syncOnStart: true,
    debounceSeconds: 120,
    remotePrefix: 'dsh-sync-fish',
    scopes: { ...DEFAULT_SCOPES },
    extraTargets: [],
    memory: { injectExisting: true, maxRecords: 5000 },
    limits: { maxFileBytes: 2 * 1024 * 1024, maxTotalBytes: 20 * 1024 * 1024 },
    phone: { adbPath: '', deviceName: '手机' },
  }
}

export function configPath() {
  return join(dshHome(), 'sync-fish', 'config.json')
}

/** 通道字段两头的空白一律去掉：多一个空格会让 Basic 认证失败（坚果云回 401） */
export function trimChannel(channel) {
  const out = { ...(isObject(channel) ? channel : {}) }
  for (const key of ['type', 'root', 'url', 'username', 'password', 'prefix']) {
    if (typeof out[key] === 'string') out[key] = out[key].trim()
  }
  return out
}

function mergeDeep(base, patch) {
  if (!isObject(patch)) return base
  const out = Array.isArray(base) ? base.slice() : { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    if (isObject(value) && isObject(out[key])) out[key] = mergeDeep(out[key], value)
    else out[key] = value
  }
  return out
}

/** v1 → v2：老的 files 里非默认项搬去 extraTargets；记忆开关搬去 scopes */
function migrate(fileConfig) {
  if (!isObject(fileConfig)) return {}
  const patch = {}
  if (fileConfig.version !== CONFIG_VERSION) {
    const defaults = new Set(['~/.dsh/skills', '~/.dsh/settings.yaml'])
    const extras = normalizeTargets(fileConfig.files).filter((item) => !defaults.has(item.key))
    if (extras.length) patch.extraTargets = extras
    if (fileConfig.memory && fileConfig.memory.enabled === false) {
      patch.scopes = { ...DEFAULT_SCOPES, memory: false }
    }
  }
  return patch
}

export function loadConfig(overrides) {
  const fileConfig = readJson(configPath(), null)
  let config = mergeDeep(defaultConfig(), migrate(fileConfig))
  if (isObject(fileConfig)) config = mergeDeep(config, fileConfig)
  if (isObject(overrides)) config = mergeDeep(config, overrides)
  config.scopes = { ...DEFAULT_SCOPES, ...(isObject(config.scopes) ? config.scopes : {}) }
  config.extraTargets = normalizeTargets(config.extraTargets)
  config.phone = { ...defaultConfig().phone, ...(isObject(config.phone) ? config.phone : {}) }
  config.channel = trimChannel(config.channel)
  config.version = CONFIG_VERSION
  return config
}

export function saveConfig(config) {
  const { files, ...rest } = config || {}
  if (rest.channel) rest.channel = trimChannel(rest.channel)
  writeJsonAtomicSync(configPath(), { ...rest, version: CONFIG_VERSION })
  return configPath()
}

export function isScopeEnabled(config, scope) {
  const scopes = { ...DEFAULT_SCOPES, ...(config?.scopes || {}) }
  return scopes[scope] !== false
}

export function validateConfig(config) {
  const errors = []
  const warnings = []
  if (!config.channel || typeof config.channel !== 'object') {
    errors.push('缺少 channel 配置')
  } else if (config.channel.type === 'folder') {
    if (!String(config.channel.root || '').trim()) {
      errors.push('folder 通道缺少 root：请指定一个本地同步文件夹')
    }
  } else if (config.channel.type === 'webdav') {
    if (!/^https?:\/\//i.test(String(config.channel.url || ''))) {
      errors.push('webdav 通道缺少有效的 http(s) url')
    }
    if (!String(config.channel.username || '').trim()) {
      warnings.push('webdav 还没填邮箱/用户名（坚果云要填登录邮箱）')
    }
    if (!String(config.channel.password || '').trim()) {
      warnings.push('webdav 还没填应用密码（不是登录密码）')
    }
  } else {
    errors.push(`不支持的通道类型：${config.channel?.type}`)
  }

  if (!Number.isFinite(Number(config.intervalMinutes)) || Number(config.intervalMinutes) < 0) {
    warnings.push('intervalMinutes 不是有效数字，按 30 处理')
    config.intervalMinutes = 30
  }
  const scopes = config.scopes || {}
  const enabledScopes = ['memory', 'skills', 'plugins', 'tasks', 'workspaces'].filter((key) => scopes[key] === true)
  if (enabledScopes.length === 0) warnings.push('所有同步分类都关着，同步不会带任何内容')
  return { errors, warnings }
}

/** 给状态 / 设置页用：不把口令、密码原样吐出来 */
export function describeConfig(config) {
  const channel = config.channel || {}
  return {
    enabled: config.enabled !== false,
    deviceName: config.deviceName,
    channel:
      channel.type === 'folder'
        ? { type: 'folder', root: channel.root || '' }
        : {
            type: channel.type,
            url: channel.url || '',
            prefix: channel.prefix || '',
            username: channel.username || '',
            hasPassword: Boolean(channel.password),
          },
    encrypted: Boolean(config.passphrase),
    intervalMinutes: config.intervalMinutes,
    syncOnStart: config.syncOnStart,
    debounceSeconds: config.debounceSeconds,
    remotePrefix: config.remotePrefix,
    scopes: { ...DEFAULT_SCOPES, ...(config.scopes || {}) },
    extraTargets: config.extraTargets || [],
    memory: config.memory,
    limits: config.limits,
    phone: { adbPath: config.phone?.adbPath || '', deviceName: config.phone?.deviceName || '手机' },
  }
}
