// lib/crypto.js —— 可选口令加密（AES-256-GCM + scrypt），纯 node:crypto
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

export const ENVELOPE_FORMAT = 'dsh-sync-fish/enc/v1'
const SCRYPT = { N: 16384, r: 8, p: 1, keyLen: 32 }

export function isEnvelope(value) {
  return Boolean(value && typeof value === 'object' && value.format === ENVELOPE_FORMAT)
}

export function seal(plain, passphrase) {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = scryptSync(String(passphrase), salt, SCRYPT.keyLen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 64 * 1024 * 1024,
  })
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(JSON.stringify(plain), 'utf8'), cipher.final()])
  return {
    format: ENVELOPE_FORMAT,
    alg: 'aes-256-gcm',
    kdf: { name: 'scrypt', ...SCRYPT, salt: salt.toString('base64') },
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  }
}

export function open(envelope, passphrase) {
  if (!isEnvelope(envelope)) return envelope
  if (!passphrase) {
    const error = new Error('远端数据是加密的，但没有配置口令（passphrase）')
    error.code = 'SYNC_ENCRYPTED'
    throw error
  }
  const kdf = envelope.kdf || {}
  const salt = Buffer.from(String(kdf.salt || ''), 'base64')
  const key = scryptSync(String(passphrase), salt, Number(kdf.keyLen) || SCRYPT.keyLen, {
    N: Number(kdf.N) || SCRYPT.N,
    r: Number(kdf.r) || SCRYPT.r,
    p: Number(kdf.p) || SCRYPT.p,
    maxmem: 64 * 1024 * 1024,
  })
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(String(envelope.iv), 'base64'))
    decipher.setAuthTag(Buffer.from(String(envelope.tag), 'base64'))
    const text = Buffer.concat([decipher.update(Buffer.from(String(envelope.data), 'base64')), decipher.final()]).toString('utf8')
    return JSON.parse(text)
  } catch {
    const error = new Error('口令不对，解不开远端快照（或快照损坏）')
    error.code = 'SYNC_DECRYPT'
    throw error
  }
}
