// lib/plugin-configs.js —— 「其他插件的设置」（cordis 配置）同步
//
// 这些设置不在文件里，而是存在 profile 的 cordis.patch.yml 中，按 entry id 挂 config。
// 宿主的 configEditor 服务可以读（configuration）和写（edit），所以我们按 entry 做三方合并：
//   本地 = 这台机现在的 override，base = 上次同步后的样子，远端 = 其它设备的 override
// 逐 key 判断哪边改过；两边都改且不同就记冲突、保留本地。
//
// 机器相关 / 机密的 key 永远不同步（pythonPath、adbPath、password、token…），
// 否则从 A 机同步到 B 机只会把 B 机搞坏。
const DENY_KEY =
  /^(pythonpath|adbpath|dshbin|workspace|workspacepath|cwd|root|executable|binary|python|venv|password|passphrase|secret|appsecret|token|accesstoken|accesstoken|apikey|api_key|cookie|authorization|credential|credentials|auth|privatekey|private_key)$/i

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** 去掉机器相关和机密的键（递归），返回新对象 */
export function sanitizeConfig(value) {
  if (Array.isArray(value)) return value.map((item) => sanitizeConfig(item))
  if (!isPlainObject(value)) return value
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (DENY_KEY.test(key)) continue
    if (item === undefined || typeof item === 'function') continue
    out[key] = sanitizeConfig(item)
  }
  return out
}

function stable(value) {
  return JSON.stringify(value ?? null)
}

/** 三方合并一个值；返回 { value, conflicts: string[] } */
export function mergeValue(local, base, remote, path = '') {
  const l = local === undefined ? undefined : local
  const b = base === undefined ? undefined : base
  const r = remote === undefined ? undefined : remote

  if (isPlainObject(l) || isPlainObject(b) || isPlainObject(r)) {
    const lo = isPlainObject(l) ? l : {}
    const bo = isPlainObject(b) ? b : {}
    const ro = isPlainObject(r) ? r : {}
    const value = {}
    const conflicts = []
    const keys = new Set([...Object.keys(lo), ...Object.keys(bo), ...Object.keys(ro)])
    for (const key of keys) {
      const child = mergeValue(lo[key], bo[key], ro[key], path ? `${path}.${key}` : key)
      if (child.value !== undefined) value[key] = child.value
      conflicts.push(...child.conflicts)
    }
    return { value, conflicts }
  }

  if (stable(l) === stable(r)) return { value: l, conflicts: [] }
  if (stable(l) === stable(b)) return { value: r, conflicts: [] }
  if (stable(r) === stable(b)) return { value: l, conflicts: [] }
  return { value: l, conflicts: [path || '(root)'] }
}

/**
 * 合并各设备的插件配置。
 *
 * `base` 里每个 entry 记两份基线：`{ local, remote }`——
 * 上一次同步后本机的值、和当时看到的远端值。两份都记，才能判断
 * 「远端到底有没有改」：否则远端的旧值会一轮一轮地把本机的新值顶掉。
 * 兼容旧的 `{ config }` 写法（当作 local/remote 同值）。
 *
 * @param {object} input
 * @param {object} input.local   { entryId: { name, config } }
 * @param {object} input.base    { entryId: { local?, remote?, config? } }
 * @param {object} input.remotes { entryId: { name, config } }  已按快照时间取最新
 * @returns {{ merged: object, changes: Array, conflicts: Array, nextBase: object }}
 */
export function mergePluginConfigs({ local = {}, base = {}, remotes = {} } = {}) {
  const localMap = local || {}
  const baseMap = base || {}
  const remoteMap = remotes || {}
  const ids = new Set([...Object.keys(localMap), ...Object.keys(remoteMap)])
  const merged = {}
  const changes = []
  const conflicts = []
  const nextBase = {}

  for (const id of [...ids].sort()) {
    const localEntry = localMap[id] || { name: id, config: {} }
    const localConfig = localEntry.config || {}
    const rawBase = baseMap[id] || {}
    const baseLocal = rawBase.local || rawBase.config || {}
    const baseRemote = rawBase.remote || rawBase.config || {}
    const remoteEntry = remoteMap[id]
    const remoteConfig = remoteEntry?.config || baseRemote
    const remoteChanged = stable(remoteConfig) !== stable(baseRemote)
    const localChanged = stable(localConfig) !== stable(baseLocal)

    let nextConfig = localConfig
    let keys = []
    if (!remoteEntry) {
      // 远端这台没带这个 entry：保持本机，不猜
      nextConfig = localConfig
    } else if (!remoteChanged && !localChanged) {
      nextConfig = localConfig
    } else if (!remoteChanged) {
      // 只有本机改了：留着，等下次把本机值当远端基线
      nextConfig = localConfig
    } else if (!localChanged) {
      // 只有远端改了：收下
      nextConfig = remoteConfig
    } else {
      // 两边都改：逐 key 三方合并，冲突保留本机
      const result = mergeValue(localConfig, baseLocal, remoteConfig)
      nextConfig = result.value || {}
      keys = result.conflicts
    }

    merged[id] = { name: localEntry.name || remoteEntry?.name || id, config: nextConfig }
    nextBase[id] = { local: nextConfig, remote: remoteConfig }

    if (stable(nextConfig) !== stable(localConfig)) {
      changes.push({ id, name: merged[id].name, config: nextConfig, from: 'sync' })
    }
    if (keys.length > 0) {
      conflicts.push({ kind: 'pluginConfig', id, keys })
    }
  }

  return { merged, changes, conflicts, nextBase }
}

/** 把 entry 列表转成 merge 用的 map */
export function toConfigMap(list) {
  const map = {}
  for (const item of Array.isArray(list) ? list : []) {
    if (!item || typeof item.id !== 'string') continue
    map[item.id] = { name: item.name || item.id, config: sanitizeConfig(item.config || {}) }
  }
  return map
}

/**
 * 写回前把被 sanitize 掉的键（路径/密码…）从本机原配置里补回来。
 * 只覆盖 sanitized 里有的键；数组和标量直接替换，对象递归合并。
 */
export function restoreDenied(sanitized, raw) {
  if (!isPlainObject(sanitized)) return sanitized
  const base = isPlainObject(raw) ? { ...raw } : {}
  for (const [key, value] of Object.entries(sanitized)) {
    if (DENY_KEY.test(key)) continue
    if (isPlainObject(value) && isPlainObject(base[key])) {
      base[key] = restoreDenied(value, base[key])
    } else {
      base[key] = value
    }
  }
  return base
}
