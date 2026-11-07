// 朗读插件：把回复或输入框里的文字用 Azure 语音合成，再交给 dsh-go 播放。
// 密钥存在同目录的 config.json（不进仓库、不上传），也支持环境变量覆盖。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

export const name = 'local-tts'

const DEFAULT_CONFIG = {
  azureKey: '',
  azureRegion: 'eastasia',
  voice: 'zh-CN-XiaoshuangMultilingualNeural',
  rate: '+0%',
  pitch: '+0Hz',
  maxChars: 400,
}

function loadConfig() {
  let fileConfig = {}
  try {
    const path = fileURLToPath(new URL('../config.json', import.meta.url))
    fileConfig = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    fileConfig = {}
  }
  return {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    azureKey: process.env.AZURE_SPEECH_KEY || fileConfig.azureKey || '',
    azureRegion: process.env.AZURE_SPEECH_REGION || fileConfig.azureRegion || DEFAULT_CONFIG.azureRegion,
  }
}

function xmlEscape(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// 把 Markdown 里不适合念的东西去掉：代码块、表格线、链接地址、强调符号。
function forSpeech(markdown) {
  let text = String(markdown || '')
  text = text.replace(/```[\s\S]*?```/g, ' ')
  text = text.replace(/`([^`]*)`/g, '$1')
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  text = text.replace(/https?:\/\/\S+/g, ' ')
  text = text.replace(/^\s{0,3}#{1,6}\s*/gm, '')
  text = text.replace(/^\s*[-*+]\s+/gm, '')
  text = text.replace(/^\s*\d+\.\s+/gm, '')
  text = text.replace(/[>*_~|]+/g, ' ')
  text = text.replace(/\s+/g, ' ').trim()
  return text
}

// Azure 免费层合成慢（约 400 字要 20 秒），媒体路由 30 秒就超时，
// 所以超长文本在句号处截断，别让整次朗读失败。
function cutText(text, limit) {
  if (text.length <= limit) return text
  const head = text.slice(0, limit)
  const stops = ['。', '！', '？', '. ', '\n']
  let best = -1
  for (const stop of stops) {
    const at = head.lastIndexOf(stop)
    if (at > best) best = at
  }
  if (best > limit * 0.5) return head.slice(0, best + 1)
  return head
}

async function synthesize(text, config, signal) {
  if (!config.azureKey) {
    throw new Error('还没配置 Azure key')
  }
  const ssml =
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-CN">` +
    `<voice name="${xmlEscape(config.voice)}">` +
    `<prosody rate="${xmlEscape(config.rate)}" pitch="${xmlEscape(config.pitch)}">${xmlEscape(text)}</prosody>` +
    `</voice></speak>`
  const response = await fetch(`https://${config.azureRegion}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': config.azureKey,
      'Content-Type': 'application/ssml+xml; charset=utf-8',
      'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
      'User-Agent': 'local-tts-dshgo',
    },
    body: ssml,
    signal,
  })
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 200)
    throw new Error(`Azure 合成失败（HTTP ${response.status}）${detail}`)
  }
  return Buffer.from(await response.arrayBuffer())
}

// ── 读取会话记录，拿「最新一条回复」──────────────────────────────
// dsh-go 插件拿不到消息正文（协议只给被点按的那条），但引擎和会话记录都在本机，
// 所以「读最新回复」自己去 DSH 的会话日志里找最后一条助手消息。

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

// 会话日志是「一串 zstd 帧」拼起来的，zstdDecompressSync 只解第一帧，
// 所以自己按魔数切开逐帧解，再拼回完整文本。
function decodeSessionFile(file) {
  const buf = readFileSync(file)
  if (!file.endsWith('.zstd')) return buf.toString('utf8')
  const offsets = []
  let at = 0
  while (at < buf.length) {
    const found = buf.indexOf(ZSTD_MAGIC, at)
    if (found < 0) break
    offsets.push(found)
    at = found + 4
  }
  if (offsets.length === 0) return zstdDecompressSync(buf).toString('utf8')
  let text = ''
  for (let i = 0; i < offsets.length; i += 1) {
    const start = offsets[i]
    const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length
    try {
      text += zstdDecompressSync(buf.subarray(start, end)).toString('utf8')
    } catch {
      // 某一帧坏了就跳过，不影响后面的
    }
  }
  return text
}

function findSessionFile(sessionId) {
  if (!sessionId) return null
  const root = join(dshHome(), 'sessions')
  if (!existsSync(root)) return null
  const names = [sessionId]
  // App 给的可能是裸 uuid，磁盘上是 session-<uuid>，两种都试
  if (!String(sessionId).startsWith('session-')) names.push(`session-${sessionId}`)
  for (const workspace of readdirSync(root)) {
    for (const name of names) {
      const dir = join(root, workspace, name)
      for (const file of ['session.v4.jsonl.zstd', 'session.v4.jsonl', 'session.jsonl']) {
        if (existsSync(join(dir, file))) return join(dir, file)
      }
    }
  }
  return null
}

// 所有会话文件按修改时间倒序（scope 里没给 sessionId 时兜底用）
function listSessionFiles() {
  const root = join(dshHome(), 'sessions')
  if (!existsSync(root)) return []
  const found = []
  for (const workspace of readdirSync(root)) {
    const wsDir = join(root, workspace)
    let sessions = []
    try {
      sessions = readdirSync(wsDir)
    } catch {
      continue
    }
    for (const session of sessions) {
      for (const file of ['session.v4.jsonl.zstd', 'session.v4.jsonl', 'session.jsonl']) {
        const full = join(wsDir, session, file)
        try {
          found.push({ file: full, mtime: statSync(full).mtimeMs })
        } catch {
          // 没有这个文件
        }
      }
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime).map((item) => item.file)
}

function replyFromFile(file) {
  let text = ''
  try {
    text = decodeSessionFile(file)
  } catch {
    return ''
  }
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]
    if (!line || !line.includes('"assistant/message"')) continue
    try {
      const event = JSON.parse(line)
      const blocks = event?.data?.message?.content
      if (!Array.isArray(blocks)) continue
      const said = blocks
        .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
        .trim()
      if (said) return said
    } catch {
      // 损坏的行跳过
    }
  }
  return ''
}

function latestReplyText(sessionId) {
  const direct = findSessionFile(sessionId)
  const candidates = []
  if (direct) candidates.push(direct)
  for (const file of listSessionFiles()) {
    if (!candidates.includes(file)) candidates.push(file)
  }
  // 先看指定会话，再按时间看最近几个；都读不到就返回空
  for (const file of candidates.slice(0, 6)) {
    const text = replyFromFile(file)
    if (text) return text
  }
  return ''
}

export function apply(ctx) {
  ctx.inject(['dshGo'], (ctx) => {
    /** key -> { text }，media 回调靠它取这次要念的文字 */
    const pending = new Map()
    let counter = 0

    const queue = (scope, text, locale, limit) => {
      const zh = !String(locale || '').startsWith('en')
      const clean = forSpeech(text)
      if (clean === '') return { toast: zh ? '这里没有可念的文字' : 'Nothing to read' }
      const config = loadConfig()
      if (!config.azureKey) return { toast: zh ? '还没配置 Azure key（config.json）' : 'Azure key is not configured' }
      const budget = Math.min(config.maxChars, limit || config.maxChars)
      const trimmed = cutText(clean, budget)
      counter += 1
      const key = `r${counter}-${Date.now()}`
      pending.set(key, { text: trimmed })
      // 只保留最近几条，避免长会话里越攒越多
      if (pending.size > 8) {
        const oldest = pending.keys().next().value
        pending.delete(oldest)
      }
      return [{ type: 'audio', op: 'play', instance: 'read', src: 'media:speech', key }]
    }

    ctx.dshGo.on('read-message', (scope, event) => queue(scope, scope.message, event && event.locale))
    ctx.dshGo.on('read-draft', (scope, event) => queue(scope, scope.draft, event && event.locale))
    ctx.dshGo.on('read-latest', (scope, event) => {
      const text = latestReplyText(scope && scope.sessionId)
      if (!text) return { toast: '还没找到能读的回复' }
      return queue(scope, text, event && event.locale)
    })

    ctx.dshGo.media('speech', async (scope, { key, signal }) => {
      const item = pending.get(key)
      if (!item) throw new Error('这段文字已经过期了，请再点一次朗读')
      const config = loadConfig()
      const body = await synthesize(item.text, config, signal)
      return { body, contentType: 'audio/mpeg' }
    })
  })
}
