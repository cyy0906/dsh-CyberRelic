import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkUpdate, compareVersions, parseVersion } from '../lib/update.js'

test('parseVersion 认得 v 前缀和补丁号', () => {
  assert.deepEqual(parseVersion('v0.3.2'), [0, 3, 2])
  assert.deepEqual(parseVersion('1.10.0'), [1, 10, 0])
  assert.equal(parseVersion('dev'), null)
})

test('compareVersions 按数字比大小', () => {
  assert.equal(compareVersions('0.3.2', '0.3.1'), 1)
  assert.equal(compareVersions('v0.3.2', '0.3.2'), 0)
  assert.equal(compareVersions('0.9.9', '0.10.0'), -1)
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0)
})

test('checkUpdate 发现新版本', async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      tag_name: 'v9.9.9',
      name: 'v9.9.9',
      html_url: 'https://example.com/release',
      published_at: '2026-11-07T00:00:00Z',
      body: '  fix   things  ',
    }),
  })
  const result = await checkUpdate({ current: '0.3.2', fetchImpl: fakeFetch })
  assert.equal(result.ok, true)
  assert.equal(result.latest, '9.9.9')
  assert.equal(result.hasUpdate, true)
  assert.equal(result.url, 'https://example.com/release')
  assert.equal(result.notes, 'fix things')
})

test('checkUpdate 同版本不算更新', async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ tag_name: 'v0.3.2', html_url: 'https://example.com' }),
  })
  const result = await checkUpdate({ current: '0.3.2', fetchImpl: fakeFetch })
  assert.equal(result.ok, true)
  assert.equal(result.hasUpdate, false)
})

test('checkUpdate 把 404 和网络错误交回调用方', async () => {
  const notFound = await checkUpdate({
    current: '0.3.2',
    fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
  })
  assert.equal(notFound.ok, false)
  assert.match(notFound.error, /Release/)

  const boom = await checkUpdate({
    current: '0.3.2',
    fetchImpl: async () => {
      throw new Error('network down')
    },
  })
  assert.equal(boom.ok, false)
  assert.match(boom.error, /network down/)
})
