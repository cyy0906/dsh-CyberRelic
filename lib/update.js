// 检查 GitHub 上有没有新版本。
// 只读 Releases，不发任何用户数据；失败时把原因交回调用方显示。

const DEFAULT_OWNER = 'cyy0906'
const DEFAULT_REPO = 'dsh-CyberRelic'

export function parseVersion(text) {
  const raw = String(text || '').trim().replace(/^v/i, '')
  const match = raw.match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

export function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return 0
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1
  }
  return 0
}

/**
 * @param {object} options
 *   current: 本机版本（如 0.3.2）
 *   fetchImpl?: 便于测试
 *   timeoutMs?: 默认 12000
 *   owner/repo?: 默认 cyy0906/dsh-CyberRelic
 * @returns {Promise<{ok:boolean,current?:string,latest?:string,hasUpdate?:boolean,
 *   url?:string,publishedAt?:string,name?:string,notes?:string,error?:string}>}
 */
export async function checkUpdate(options = {}) {
  const current = String(options.current || '').trim()
  const owner = options.owner || DEFAULT_OWNER
  const repo = options.repo || DEFAULT_REPO
  const fetchImpl = options.fetchImpl || globalThis.fetch
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 12000
  if (typeof fetchImpl !== 'function') {
    return { ok: false, current, error: '当前运行环境没有 fetch，检查不了更新' }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'dsh-cyberrelic-update-check',
      },
      signal: controller.signal,
    })
    if (res.status === 404) {
      return { ok: false, current, error: '仓库还没有发布过 Release' }
    }
    if (!res.ok) {
      return { ok: false, current, error: `GitHub 返回 ${res.status}` }
    }
    const data = await res.json()
    const latest = String(data.tag_name || data.name || '').replace(/^v/i, '')
    if (!parseVersion(latest)) {
      return { ok: false, current, error: 'Release 里没有可识别的版本号' }
    }
    return {
      ok: true,
      current,
      latest,
      hasUpdate: compareVersions(latest, current) > 0,
      url: String(data.html_url || `https://github.com/${owner}/${repo}/releases`),
      publishedAt: String(data.published_at || ''),
      name: String(data.name || data.tag_name || ''),
      notes: String(data.body || '').replace(/\s+/g, ' ').trim().slice(0, 240),
    }
  } catch (error) {
    const message = error?.name === 'AbortError' ? '请求超时（GitHub 可能被墙，挂上代理再试）' : String(error?.message || error)
    return { ok: false, current, error: message }
  } finally {
    clearTimeout(timer)
  }
}
