// lib/state.js —— 设备 id / 上次同步基线 / 冲突队列 / 信箱幂等记录
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { dshHome, isObject, readJson, writeJsonAtomicSync } from './util.js'

export function statePath() {
  return join(dshHome(), 'sync-fish', 'state.json')
}

export function loadState() {
  const raw = readJson(statePath(), null)
  const state = isObject(raw) ? raw : {}
  // 信箱状态（v0.3.5）：executedIds 是幂等记录，results 是最近几次执行的本地缓存
  // （通道上还有一份 outbox.json，这里留一份是为了离线也能 mailbox_result）。
  const mailboxRaw = isObject(state.mailbox) ? state.mailbox : {}
  return {
    version: 1,
    deviceId: typeof state.deviceId === 'string' ? state.deviceId : '',
    deviceName: typeof state.deviceName === 'string' ? state.deviceName : '',
    createdAt: typeof state.createdAt === 'string' ? state.createdAt : '',
    lastSyncAt: typeof state.lastSyncAt === 'string' ? state.lastSyncAt : '',
    lastResult: isObject(state.lastResult) ? state.lastResult : null,
    base: {
      memory: isObject(state.base?.memory) ? state.base.memory : {},
      files: isObject(state.base?.files) ? state.base.files : {},
      // 以前这里漏了 pluginConfigs：engine 每轮都写基线，loadState 一读又丢，
      // 结果插件设置永远没有基线、两边各改一次就当冲突。
      pluginConfigs: isObject(state.base?.pluginConfigs) ? state.base.pluginConfigs : {},
    },
    mailbox: {
      executedIds: Array.isArray(mailboxRaw.executedIds) ? mailboxRaw.executedIds.map(String) : [],
      results: Array.isArray(mailboxRaw.results) ? mailboxRaw.results.filter(isObject) : [],
      lastPollAt: typeof mailboxRaw.lastPollAt === 'string' ? mailboxRaw.lastPollAt : '',
      lastError: typeof mailboxRaw.lastError === 'string' ? mailboxRaw.lastError : '',
      lastPushAt: typeof mailboxRaw.lastPushAt === 'string' ? mailboxRaw.lastPushAt : '',
    },
    conflicts: Array.isArray(state.conflicts) ? state.conflicts : [],
    history: Array.isArray(state.history) ? state.history : [],
  }
}

export function ensureDeviceId(state) {
  if (!state.deviceId) {
    state.deviceId = randomUUID()
    state.createdAt = new Date().toISOString()
  }
  return state.deviceId
}

export function saveState(state) {
  writeJsonAtomicSync(statePath(), state)
  return statePath()
}
