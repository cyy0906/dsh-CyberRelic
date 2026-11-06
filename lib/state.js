// lib/state.js —— 设备 id / 上次同步基线 / 冲突队列
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { dshHome, isObject, readJson, writeJsonAtomicSync } from './util.js'

export function statePath() {
  return join(dshHome(), 'sync-fish', 'state.json')
}

export function loadState() {
  const raw = readJson(statePath(), null)
  const state = isObject(raw) ? raw : {}
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
