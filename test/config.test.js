// test/config.test.js —— 分类开关、工作区合并、手机包
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gunzipSync } from 'node:zlib'

import { buildTargets, keyAllowedByTargets, mergeWorkspaceRegistries } from '../lib/files.js'
import { defaultConfig, validateConfig } from '../lib/config.js'
import { collectBundleFiles, makeTarGz, phoneConfig } from '../lib/phone.js'

test('默认分类：记忆/习惯/插件设置/任务开，工作区关', () => {
  const targets = buildTargets(defaultConfig())
  const keys = targets.map((item) => item.key)
  assert.ok(keys.includes('~/.dsh/skills'))
  assert.ok(keys.includes('~/.dsh/*-config.json'))
  assert.ok(keys.includes('~/.dsh/storages/schedule.json'))
  assert.ok(!keys.includes('~/.dsh/storages/workspace.json'))
})

test('关掉分类后目标里就没有它；额外目标两种写法都认', () => {
  const targets = buildTargets({
    scopes: { skills: false, plugins: false, tasks: false },
    extraTargets: [{ key: '~/.dsh/AGENTS.md', kind: 'file' }],
  })
  const keys = targets.map((item) => item.key)
  assert.deepEqual(keys, ['~/.dsh/AGENTS.md'])
  assert.ok(keyAllowedByTargets('~/.dsh/AGENTS.md', targets))
  assert.ok(!keyAllowedByTargets('~/.dsh/skills/foo.md', targets))
})

test('工作区注册表按 title 合并，远端会话 id 不带过来', () => {
  const local = JSON.stringify({
    global: { defaultWorkspaceId: 'w1', workspaceIds: ['w1'] },
    tables: {
      workspaces: {
        w1: { path: 'D:\\ws', title: 'default-workspace', sessionIds: ['s1'], updatedAt: '2026-01-01T00:00:00.000Z' },
      },
    },
  })
  const remote = JSON.stringify({
    global: { defaultWorkspaceId: 'r1', workspaceIds: ['r1', 'r2'] },
    tables: {
      workspaces: {
        r1: { path: 'D:\\ws', title: 'default-workspace', sessionIds: ['x'], updatedAt: '2026-01-02T00:00:00.000Z' },
        r2: { path: '/root/ws', title: 'phone-workspace', sessionIds: ['y'], updatedAt: '2026-01-02T00:00:00.000Z' },
      },
    },
  })
  const merged = mergeWorkspaceRegistries(local, [remote])
  assert.equal(merged.changed, true)
  assert.equal(merged.added, 1)
  const value = JSON.parse(merged.text)
  assert.deepEqual(Object.keys(value.tables.workspaces).sort(), ['r2', 'w1'])
  assert.deepEqual(value.tables.workspaces.r2.sessionIds, [])
  assert.ok(value.global.workspaceIds.includes('r2'))
  assert.equal(mergeWorkspaceRegistries(merged.text, [remote]).changed, false)
})

test('validateConfig：webdav 缺账号只提示，缺 url 才是错', () => {
  const base = {
    ...defaultConfig(),
    channel: { type: 'webdav', url: 'https://dav.jianguoyun.com/dav/', username: '', password: '' },
  }
  const result = validateConfig(base)
  assert.equal(result.errors.length, 0)
  assert.ok(result.warnings.some((item) => item.includes('邮箱')))
  assert.ok(validateConfig({ ...base, channel: { type: 'webdav', url: '' } }).errors.length >= 1)
})

test('手机配置：webdav 才能装，folder 直接拒绝', () => {
  const config = { ...defaultConfig(), channel: { type: 'folder', root: '/tmp/x' } }
  assert.throws(() => phoneConfig(config), /webdav/)

  const webdavConfig = {
    ...config,
    channel: { type: 'webdav', url: 'https://dav.jianguoyun.com/dav/', username: 'a@b.c', password: 'pw' },
    passphrase: 'p',
  }
  const phone = phoneConfig(webdavConfig)
  assert.equal(phone.deviceName, '手机')
  assert.equal(phone.channel.url, 'https://dav.jianguoyun.com/dav/')
  assert.equal(phone.passphrase, 'p')
  assert.equal(phone.syncOnStart, true)
})

test('手机安装包是 gzip，里面有 package.json', () => {
  const files = collectBundleFiles()
  assert.ok(files.some((file) => file.name === 'package.json'))
  assert.ok(files.some((file) => file.name === 'client.js'))
  assert.ok(files.every((file) => !file.name.startsWith('test/')))
  const archive = makeTarGz(files)
  assert.equal(archive[0], 0x1f)
  assert.equal(archive[1], 0x8b)
  const tar = gunzipSync(archive)
  assert.ok(tar.includes(Buffer.from('package.json')))
})
