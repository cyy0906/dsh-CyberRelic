import { test } from 'node:test'
import assert from 'node:assert/strict'
import { looksLikeText } from '../lib/util.js'

test('中文文件在第 8192 字节处被切开也不会被误判成二进制', () => {
  // 「不」是 \xe4\xb8\x8d：让它的第一个字节正好落在第 8191 位（0 基），
  // 截断后 tail 只剩 \xe4，旧的 isUtf8(head) 会判成非法 UTF-8。
  const prefix = 'a'.repeat(8191)
  const buf = Buffer.from(prefix + '不限' + 'b'.repeat(100), 'utf8')
  assert.equal(buf.length > 8192, true)
  assert.equal(buf[8191], 0xe4)
  assert.equal(looksLikeText(buf), true)
})

test('干净的 UTF-8 中文文本可识别', () => {
  assert.equal(looksLikeText(Buffer.from('记忆：今天也要吃米饭 🍚\n', 'utf8')), true)
})

test('含 NUL 的缓冲被当成二进制', () => {
  assert.equal(looksLikeText(Buffer.from([0x61, 0x62, 0x00, 0x63])), false)
})

test('非法 UTF-8 字节被当成二进制', () => {
  assert.equal(looksLikeText(Buffer.from([0xff, 0xfe, 0x61])), false)
})
