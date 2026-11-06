// lib/channel.js —— 同步通道：本地文件夹 / WebDAV
//
// 只依赖 node:fs + 全局 fetch，没有任何原生依赖（手机 PRoot 也能跑）。
import { join } from 'node:path'
import { mkdirp, readText, writeFileAtomicSync } from './util.js'

const FETCH_TIMEOUT_MS = 20000

export class FolderChannel {
  constructor(root) {
    this.type = 'folder'
    this.root = root
    this.label = root
  }

  describe() {
    return { type: this.type, root: this.root }
  }

  fileFor(rel) {
    return join(this.root, ...String(rel).split('/').filter(Boolean))
  }

  async read(rel) {
    return readText(this.fileFor(rel))
  }

  async write(rel, text) {
    const file = this.fileFor(rel)
    mkdirp(join(file, '..'))
    writeFileAtomicSync(file, text)
  }

  async list(prefix) {
    const { readdirSync } = await import('node:fs')
    const base = this.fileFor(prefix)
    const out = []
    const walk = (dir, rel) => {
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const childRel = rel ? `${rel}/${entry.name}` : entry.name
        if (entry.isDirectory()) walk(join(dir, entry.name), childRel)
        else if (entry.isFile()) out.push(childRel)
      }
    }
    walk(base, prefix ? String(prefix).replace(/\/+$/, '') : '')
    return out
  }

  async ping() {
    await this.write('.dsh-sync-fish-probe', new Date().toISOString())
    const text = await this.read('.dsh-sync-fish-probe')
    if (!text) throw new Error('写入成功但读不回探针文件')
    return true
  }
}

export class WebdavChannel {
  constructor({ url, username, password, prefix = '' }) {
    this.type = 'webdav'
    // 两头的空白会让 Basic 认证失败（坚果云直接回 401），这里再兜一层
    this.base = String(url || '').trim().replace(/\/+$/, '')
    this.username = String(username || '').trim()
    this.password = String(password || '').trim()
    this.prefix = String(prefix || '').trim().replace(/^\/+|\/+$/g, '')
    this.label = this.base
  }

  describe() {
    return { type: this.type, url: this.base, username: this.username, prefix: this.prefix }
  }

  relToFull(rel) {
    const clean = String(rel || '').replace(/^\/+/, '')
    return [this.prefix, clean].filter(Boolean).join('/')
  }

  urlFor(rel, isCollection = false) {
    const full = this.relToFull(rel)
    const path = full.split('/').filter(Boolean).map(encodeURIComponent).join('/')
    const url = `${this.base}/${path}`
    return isCollection && !url.endsWith('/') ? `${url}/` : url
  }

  headers(extra = {}) {
    const headers = { ...extra }
    if (this.username || this.password) {
      headers.authorization = `Basic ${Buffer.from(`${this.username}:${this.password}`, 'utf8').toString('base64')}`
    }
    return headers
  }

  async request(url, options = {}) {
    return fetch(url, {
      ...options,
      headers: this.headers(options.headers || {}),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  }

  async read(rel) {
    const res = await this.request(this.urlFor(rel), { method: 'GET' })
    if (res.status === 404 || res.status === 410) return null
    if (!res.ok) throw new Error(`WebDAV GET ${rel} → HTTP ${res.status}`)
    return res.text()
  }

  async write(rel, text) {
    const doPut = () => this.request(this.urlFor(rel), { method: 'PUT', body: text })
    let res = await doPut()
    if (res.status === 409 || res.status === 404) {
      await this.ensureParents(rel)
      res = await doPut()
    }
    if (!res.ok) throw new Error(`WebDAV PUT ${rel} → HTTP ${res.status} ${await safeText(res)}`)
  }

  async ensureParents(rel) {
    const parts = this.relToFull(rel).split('/').filter(Boolean)
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/')
      const url = this.urlFor(dir, true)
      try {
        await this.request(url, { method: 'MKCOL' })
      } catch {
        /* 已存在或服务器不支持，忽略 */
      }
    }
  }

  async list(prefix) {
    const rel = String(prefix || '').replace(/^\/+/, '')
    const url = this.urlFor(rel, true)
    const res = await this.request(url, {
      method: 'PROPFIND',
      headers: { depth: '1', 'content-type': 'application/xml' },
      body: '<?xml version="1.0"?><propfind xmlns="DAV:"><prop><resourcetype/></prop></propfind>',
    })
    if (res.status === 404) return []
    if (res.status === 405) return [] // 有些服务只读
    if (!res.ok) throw new Error(`WebDAV PROPFIND ${prefix} → HTTP ${res.status}`)
    const xml = await res.text()
    const basePath = new URL(url).pathname.replace(/\/?$/, '/')
    const out = []
    for (const href of hrefsOf(xml)) {
      let path
      try {
        path = decodeURIComponent(new URL(href, url).pathname)
      } catch {
        continue
      }
      if (!path.startsWith(basePath)) continue
      const tail = path.slice(basePath.length).replace(/\/$/, '')
      if (!tail) continue
      out.push(prefix ? `${String(prefix).replace(/\/+$/, '')}/${tail}` : tail)
    }
    return out
  }

  async remove(rel) {
    const res = await this.request(this.urlFor(rel), { method: 'DELETE' })
    if (res.status === 404 || res.status === 410) return false
    if (!res.ok) throw new Error(`WebDAV DELETE ${rel} → HTTP ${res.status}`)
    return true
  }

  // 把探针写进一个「目录」里，而不是 WebDAV 根上。
  // 坚果云不允许在根目录新建文件（PUT 根路径 → 404 ObjectNotFound），
  // 但允许在已存在的目录里写；write() 遇到 404/409 会自动 MKCOL 父目录。
  async ping() {
    const dir = this.prefix || 'dsh-sync-fish'
    const probe = `${dir}/.dsh-sync-fish-probe`
    await this.write(probe, new Date().toISOString())
    const text = await this.read(probe)
    try {
      await this.remove(probe)
    } catch {
      /* 删不掉也没关系，只是个探针 */
    }
    if (!text) throw new Error('写入成功但读不回探针文件（检查 WebDAV 账号权限）')
    return true
  }
}

function hrefsOf(xml) {
  const out = []
  const re = /<(?:[\w.-]+:)?href[^>]*>([^<]+)<\/(?:[\w.-]+:)?href>/gi
  let match
  while ((match = re.exec(xml))) out.push(match[1].trim())
  return out
}

async function safeText(res) {
  try {
    return (await res.text()).slice(0, 200)
  } catch {
    return ''
  }
}

export function makeChannel(channelConfig) {
  if (!channelConfig || typeof channelConfig !== 'object') {
    throw new Error('没有配置同步通道（channel）')
  }
  if (channelConfig.type === 'folder') {
    const root = String(channelConfig.root || '').trim()
    if (!root) throw new Error('folder 通道缺少 root（同步文件夹路径）')
    return new FolderChannel(root)
  }
  if (channelConfig.type === 'webdav') {
    const url = String(channelConfig.url || '').trim()
    if (!/^https?:\/\//i.test(url)) throw new Error('webdav 通道需要 http(s) 地址')
    return new WebdavChannel({
      url,
      username: channelConfig.username || '',
      password: channelConfig.password || '',
      prefix: channelConfig.prefix || '',
    })
  }
  throw new Error(`不支持的通道类型：${channelConfig.type}`)
}
