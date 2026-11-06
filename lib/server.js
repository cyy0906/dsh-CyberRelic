// lib/server.js —— 设置页用的 HTTP API（挂在 DSH 自己的 webServer 上）
//
// 页面和 API 在同一个 origin，所以只做同源校验；所有响应都是 JSON。
// 这些接口只在设置了 enabled 的本机生效，不对外网开放（webServer 只监听本机端口）。
import { randomUUID } from 'node:crypto'

const MAX_BODY = 1024 * 1024

function json(res, status, data) {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function sameOrigin(req) {
  const origin = String(req.headers.origin || '')
  const host = String(req.headers.host || '')
  // 桌面端窗口有时从 file:// / 自定义协议加载，浏览器会发 Origin: null；
  // 读接口和本地写接口都只监听 127.0.0.1，null 放行，别的来源仍然要同 host。
  if (!origin || origin === 'null') return true
  try {
    const url = new URL(origin)
    return url.host === host
  } catch {
    return false
  }
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new Error('请求体太大')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * @param {object} host
 *   getStatus(): object
 *   saveConfig(patch): { ok, message?, errors? }
 *   probe(): Promise<{ok,type,error}>
 *   sync({dryRun}): Promise<object>
 *   conflicts(): object
 *   clearConflicts(): object
 *   phoneInfo(): object
 *   phoneInstall(): { id, promise }   // 后台任务
 */
export function createApi(host) {
  const jobs = new Map()

  async function handle(req, res, url) {
    if (!sameOrigin(req)) {
      json(res, 403, { ok: false, message: '只接受本机同源请求' })
      return
    }
    const path = url.pathname.replace(/^\/api\/sync-fish\/?/, '')
    const method = String(req.method || 'GET').toUpperCase()

    if (method === 'GET' && (path === '' || path === 'status')) {
      json(res, 200, { ok: true, ...host.getStatus() })
      return
    }
    if (method === 'GET' && path === 'self-test') {
      const page = `<!doctype html><meta charset="utf-8"><title>pending</title>
<script>
const t0 = Date.now();
setTimeout(() => { if (document.title === 'pending') document.title = 'TIMEOUT ' + (Date.now() - t0) }, 8000);
fetch('/api/sync-fish/status', { cache: 'no-store' })
  .then((r) => r.text().then((t) => { document.title = 'OK ' + r.status + ' ' + t.slice(0, 80) }))
  .catch((e) => { document.title = 'ERR ' + e.message });
</script>`
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(page)
      return
    }
    if (method === 'POST' && path === 'diag') {
      const body = await readBody(req).catch(() => ({}))
      host.log?.(`CLIENT 自检：${JSON.stringify(body).slice(0, 400)}`)
      json(res, 200, { ok: true })
      return
    }
    if (method === 'GET' && path === 'phone') {
      json(res, 200, { ok: true, ...host.phoneInfo() })
      return
    }
    if (method === 'GET' && path === 'conflicts') {
      json(res, 200, { ok: true, ...host.conflicts() })
      return
    }
    if (method === 'POST' && path === 'config') {
      const body = await readBody(req)
      const result = host.saveConfig(body && typeof body === 'object' ? body : {})
      json(res, result.ok === false ? 400 : 200, result)
      return
    }
    if (method === 'POST' && path === 'test') {
      json(res, 200, { ok: true, probe: await host.probe() })
      return
    }
    if (method === 'POST' && path === 'sync') {
      const body = await readBody(req)
      const result = await host.sync({ dryRun: Boolean(body?.dryRun) })
      json(res, 200, { ok: result.ok !== false, result })
      return
    }
    if (method === 'POST' && path === 'conflicts/clear') {
      json(res, 200, { ok: true, ...host.clearConflicts() })
      return
    }
    if (method === 'POST' && path === 'phone/install') {
      const started = host.phoneInstall()
      const id = randomUUID()
      const live = Array.isArray(started.lines) ? started.lines : []
      jobs.set(id, { id, status: 'running', log: live, startedAt: new Date().toISOString(), result: null })
      const job = jobs.get(id)
      started.promise
        .then((result) => {
          job.status = 'done'
          job.result = result
          job.log = Array.isArray(result?.log) ? result.log : []
        })
        .catch((error) => {
          job.status = 'error'
          job.error = String(error?.message || error)
        })
      json(res, 200, { ok: true, jobId: id })
      return
    }
    if (method === 'GET' && path === 'phone/install') {
      const id = url.searchParams.get('id') || ''
      const job = jobs.get(id)
      if (!job) {
        json(res, 404, { ok: false, message: '没有这个安装任务（可能重启过了）' })
        return
      }
      json(res, 200, { ok: true, job })
      return
    }
    json(res, 404, { ok: false, message: `未知接口：${method} ${url.pathname}` })
  }

  return async function handler(req, res) {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`)
      host.log?.(`API ${req.method} ${url.pathname} origin=${req.headers.origin || '-'}`)
      res.on('finish', () => host.log?.(`API 响应 ${req.method} ${url.pathname} → ${res.statusCode}`))
      await handle(req, res, url)
    } catch (error) {
      host.log?.(`API 出错 ${req.method} ${req.url}：${error?.message || error}`)
      try {
        json(res, 500, { ok: false, message: String(error?.message || error) })
      } catch {
        /* 头已经发出去了 */
      }
    }
  }
}
