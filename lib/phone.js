// lib/phone.js —— 手机（DSH Go / dsh-go）USB 一键安装
//
// 手机端没有对外开放的安装接口，所以这里做的是「把人手动做的事自动化」：
//   1. 把插件目录打成 tar.gz（纯 JS，不依赖系统 tar）
//   2. adb push 到 /sdcard/Download/
//   3. 启动 DSH Go，在聊天框里把安装指令交给手机上的 agent
//   4. 轮询同步通道里的 manifest，等手机设备快照更新，作为安装成功的判据
//
// 任何一步失败都返回 { ok:false, message, log }，让调用方（设置页/工具）原样展示。
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { describeConfig } from './config.js'
import { makeChannel } from './channel.js'
import { manifestPath, remotePrefixOf } from './engine.js'
import { readPngPixel } from './png.js'

export const PHONE_PACKAGE = 'io.github.ccch1mneyyy.dsh_app'
export const PHONE_HOME = '/root/.dsh'
export const PHONE_PLUGIN_DIR = `${PHONE_HOME}/plugins/dsh-CyberRelic`
export const REMOTE_TAR = '/sdcard/Download/dsh-CyberRelic.tar.gz'
export const REMOTE_CONFIG = '/sdcard/Download/cyberrelic-config.json'

const BUNDLE_ROOT = fileURLToPath(new URL('..', import.meta.url))

export function findAdb(config = {}) {
  const candidates = [
    config.phone?.adbPath,
    process.env.ADB,
    process.env.ANDROID_HOME ? join(process.env.ANDROID_HOME, 'platform-tools', 'adb.exe') : '',
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', 'adb.exe') : '',
    'C:\\Users\\Administrator\\dsh-tools\\platform-tools\\adb.exe',
    'adb',
  ].filter((item) => typeof item === 'string' && item.trim())
  for (const candidate of candidates) {
    if (candidate === 'adb') return { path: 'adb', ok: true }
    if (existsSync(candidate)) return { path: candidate, ok: true }
  }
  return { path: 'adb', ok: false }
}

function run(adb, args, { timeout = 60_000 } = {}) {
  const result = spawnSync(adb, args, { encoding: 'utf8', timeout, windowsHide: true })
  const stdout = String(result.stdout || '')
  const stderr = String(result.stderr || '')
  const code = result.status == null ? -1 : result.status
  return { ok: code === 0, code, stdout, stderr, error: result.error ? String(result.error.message) : '' }
}

export function listDevices(adbPath) {
  const result = run(adbPath, ['devices', '-l'], { timeout: 20_000 })
  const devices = []
  for (const line of result.stdout.split(/\r?\n/).slice(1)) {
    const text = line.trim()
    if (!text || text.startsWith('*')) continue
    const [serial, state] = text.split(/\s+/)
    if (!serial) continue
    const model = /model:(\S+)/.exec(text)?.[1] || ''
    devices.push({ serial, state, model })
  }
  return { ok: result.ok, devices, raw: result.stdout.trim(), error: result.stderr.trim() }
}

// ── 纯 JS tar.gz ────────────────────────────────────────────────

function octal(value, length) {
  return value.toString(8).padStart(length - 1, '0') + '\0'
}

function tarHeader(name, size, mtimeSeconds) {
  const header = Buffer.alloc(512, 0)
  header.write(name.slice(0, 100), 0, 'utf8')
  header.write(octal(0o644, 8), 100, 'ascii')
  header.write(octal(0, 8), 108, 'ascii')
  header.write(octal(0, 8), 116, 'ascii')
  header.write(octal(size, 12), 124, 'ascii')
  header.write(octal(mtimeSeconds, 12), 136, 'ascii')
  header.write('        ', 148, 'ascii')
  header.write('0', 156, 'ascii')
  header.write('ustar\0', 257, 'ascii')
  header.write('00', 263, 'ascii')
  header.write('dsh-CyberRelic', 265, 'ascii')
  header.write('dsh-CyberRelic', 297, 'ascii')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii')
  return header
}

export function makeTarGz(entries, { mtime = new Date() } = {}) {
  const chunks = []
  const seconds = Math.floor(mtime.getTime() / 1000)
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8')
    chunks.push(tarHeader(entry.name, data.length, seconds))
    chunks.push(data)
    const pad = (512 - (data.length % 512)) % 512
    if (pad) chunks.push(Buffer.alloc(pad, 0))
  }
  chunks.push(Buffer.alloc(1024, 0))
  return gzipSync(Buffer.concat(chunks), { level: 9 })
}

const INCLUDE = [/^package\.json$/, /^cordis\.patch\.yml$/, /^README\.md$/, /^client\.js$/, /^locale\//, /^lib\//]
const SKIP = [/(^|\/)test\//, /(^|\/)HANDOFF\.md$/, /(^|\/)node_modules\//, /(^|\/)\.git\//]

/** 收集要打进手机包的文件（相对包根目录） */
export function collectBundleFiles(root = BUNDLE_ROOT) {
  const files = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name)
      const rel = relative(root, abs).split(sep).join('/')
      if (SKIP.some((re) => re.test(rel))) continue
      const stat = statSync(abs)
      if (stat.isDirectory()) walk(abs)
      else if (stat.isFile() && INCLUDE.some((re) => re.test(rel))) {
        files.push({ name: rel, data: readFileSync(abs) })
      }
    }
  }
  walk(root)
  return files.sort((a, b) => a.name.localeCompare(b.name))
}

// ── 手机配置 ────────────────────────────────────────────────────

export function phoneConfig(config, { deviceName } = {}) {
  const described = describeConfig(config)
  const channel = config.channel || {}
  if (channel.type !== 'webdav') throw new Error('手机安装需要 webdav 通道（手机访问不到电脑上的本地文件夹）')
  return {
    version: 2,
    enabled: true,
    deviceName: deviceName || config.phone?.deviceName || '手机',
    channel: {
      type: 'webdav',
      url: channel.url,
      username: channel.username,
      password: channel.password,
      prefix: channel.prefix || '',
    },
    passphrase: config.passphrase || '',
    intervalMinutes: Math.max(10, Number(config.intervalMinutes) || 30),
    syncOnStart: true,
    debounceSeconds: Math.max(30, Number(config.debounceSeconds) || 120),
    remotePrefix: config.remotePrefix || 'dsh-sync-fish',
    scopes: described.scopes,
    memory: config.memory || { injectExisting: true, maxRecords: 5000 },
    limits: config.limits,
    phone: {},
  }
}

function buildMessage() {
  return [
    'Install the DSH plugin bundle from /sdcard/Download/dsh-CyberRelic.tar.gz.',
    `Extract it into ${PHONE_PLUGIN_DIR} then call plugin_manager install_bundle on that folder.`,
    'If an older bundle named dsh-sync-fish is still installed, remove it first with plugin_manager remove_bundle.',
    `Copy /sdcard/Download/cyberrelic-config.json to ${PHONE_HOME}/sync-fish/config.json.`,
    'Reload the sync-fish plugin and call sync_now. Reply done when the sync finishes.',
  ].join(' ')
}

function screenSize(adb, serial) {
  const result = run(adb, ['-s', serial, 'shell', 'wm', 'size'], { timeout: 15_000 })
  const match = /(\d+)\s*x\s*(\d+)/.exec(result.stdout)
  if (!match) return { width: 1080, height: 2400 }
  return { width: Number(match[1]), height: Number(match[2]) }
}

function shellTap(adb, serial, x, y) {
  return run(adb, ['-s', serial, 'shell', 'input', 'tap', String(Math.round(x)), String(Math.round(y))], { timeout: 15_000 })
}

/** 键盘有没有弹出来（WebView 的节点 dump 不出来，只能问输入法） */
function keyboardShown(adb, serial) {
  const result = run(adb, ['-s', serial, 'shell', 'dumpsys', 'input_method'], { timeout: 15_000 })
  return /mInputShown=true/.test(result.stdout || '')
}

/** 截一张图（PNG buffer），用来判断右下角到底是「发送箭头」还是「麦克风」 */
function captureScreen(adb, serial) {
  const result = spawnSync(adb, ['-s', serial, 'exec-out', 'screencap', '-p'], {
    maxBuffer: 32 * 1024 * 1024,
    timeout: 20_000,
  })
  if (result.status !== 0 || !result.stdout || result.stdout.length < 100) return null
  return result.stdout
}

/**
 * 发送箭头是浅蓝色（大约 #97b1f0），麦克风是灰色。
 * 只认蓝通道明显高于红通道的像素，避免把麦克风当成发送。
 */
function looksLikeSendButton(adb, serial, x, y) {
  const png = captureScreen(adb, serial)
  if (!png) return false
  const points = [
    [x, y],
    [x - 10, y],
    [x + 10, y],
    [x, y - 10],
    [x, y + 10],
  ]
  let hits = 0
  for (const [px, py] of points) {
    const color = readPngPixel(png, Math.round(px), Math.round(py))
    if (color && color.b - color.r > 40 && color.b > 190) hits += 1
  }
  return hits >= 2
}

async function waitForPhoneSync(channel, config, { deviceName, since, timeoutMs = 240_000, log = () => {} }) {
  const prefix = remotePrefixOf(config)
  const deadline = Date.now() + timeoutMs
  const start = Date.now()
  let tick = 0
  while (Date.now() < deadline) {
    try {
      const text = await channel.read(manifestPath(prefix))
      if (text) {
        const manifest = JSON.parse(text)
        const devices = Object.values(manifest?.devices || {})
        const hit = devices.find((item) => item?.name === deviceName && Date.parse(item.updatedAt) >= since - 5000)
        if (hit) return { ok: true, device: hit }
      }
    } catch (error) {
      log(`等手机同步：${error?.message || error}`)
    }
    tick += 1
    if (tick % 3 === 0) {
      log(`还在等手机跑完首轮同步…已等 ${Math.round((Date.now() - start) / 1000)} 秒`)
    }
    await new Promise((resolve) => setTimeout(resolve, 10_000))
  }
  return { ok: false }
}

/**
 * 一键装手机。返回 { ok, message, log, device, verified }
 * 这是长操作（1～4 分钟）：调用方自己决定放后台还是同步等。
 */
export async function installToPhone({ config, log = () => {} } = {}) {
  const lines = []
  const say = (message) => {
    lines.push(message)
    log(message)
  }
  const adbInfo = findAdb(config)
  say(`adb：${adbInfo.path}${adbInfo.ok ? '' : '（没找到，可以在设置里填路径）'}`)

  const pickDevice = (listed) =>
    listed.devices.find((item) => item.state === 'device') || listed.devices[0] || null
  let listed = listDevices(adbInfo.path)
  let device = pickDevice(listed)
  // adb 偶尔在手机刚亮屏 / 刚插上线时看不到设备，等几秒再试几次；用户点一次按钮不该就这么失败。
  for (let attempt = 0; !device && attempt < 5; attempt += 1) {
    say(`还没看到手机，等 2 秒再试（${attempt + 1}/5）…`)
    await new Promise((resolve) => setTimeout(resolve, 2000))
    listed = listDevices(adbInfo.path)
    device = pickDevice(listed)
  }
  if (!device) {
    return { ok: false, message: '没看到手机：插好 USB、打开「USB 调试」，手机上点「允许」再试', log: lines }
  }
  if (device.state !== 'device') {
    return {
      ok: false,
      message: `手机上还没允许 USB 调试（状态：${device.state}），解锁手机点「允许」再来一次`,
      log: lines,
    }
  }
  const serial = device.serial
  say(`手机：${serial}${device.model ? `（${device.model}）` : ''}`)

  // 锁屏时输入框点不动，先把屏幕点亮、试着收起锁屏（有密码的话还是得主人自己解）。
  run(adbInfo.path, ['-s', serial, 'shell', 'input', 'keyevent', '224'], { timeout: 15_000 }) // KEYCODE_WAKEUP
  const keyguard = run(adbInfo.path, ['-s', serial, 'shell', 'wm', 'dismiss-keyguard'], { timeout: 15_000 })
  if (!keyguard.ok) say('屏幕好像还锁着，处理输入时可能要多试几次')

  let phoneConfigJson
  try {
    phoneConfigJson = phoneConfig(config)
  } catch (error) {
    return { ok: false, message: String(error?.message || error), log: lines }
  }

  const startedAt = Date.now()
  const bundle = makeTarGz(collectBundleFiles(), { mtime: new Date() })
  const tempTar = join(tmpdir(), `dsh-sync-fish-phone-${process.pid}.tar.gz`)
  const tempConfig = join(tmpdir(), `dsh-sync-fish-phone-${process.pid}.json`)
  try {
    writeFileSync(tempTar, bundle)
    const pushedTar = run(adbInfo.path, ['-s', serial, 'push', tempTar, REMOTE_TAR], { timeout: 120_000 })
    if (!pushedTar.ok) {
      return { ok: false, message: `推安装包失败：${pushedTar.stderr || pushedTar.stdout}`, log: lines }
    }
    say(`安装包已推送（${(bundle.length / 1024).toFixed(1)} KB）`)

    writeFileSync(tempConfig, JSON.stringify(phoneConfigJson, null, 2))
    const pushedConfig = run(adbInfo.path, ['-s', serial, 'push', tempConfig, REMOTE_CONFIG], { timeout: 60_000 })
    if (!pushedConfig.ok) {
      return { ok: false, message: `推配置失败：${pushedConfig.stderr || pushedConfig.stdout}`, log: lines }
    }
    say('手机配置已推送（包含通道账号和口令）')
  } finally {
    for (const file of [tempTar, tempConfig]) {
      try {
        if (existsSync(file)) unlinkSync(file)
      } catch {
        /* 临时文件清不掉不影响结果 */
      }
    }
  }

  // 用系统「分享到 DSH Go」把指令送进去：ShareActivity 会新开一个对话并把文字预填在输入框里，
  // 不依赖 App 当前停在哪一页（设置页、插件页、旧对话都能进），比点输入框 + input text 稳。
  //
  // ⚠️ 必须把整条 am 命令当成**一个** shell 字符串传：adb shell 会把多个参数用空格拼起来，
  // 指令里本来就有空格，拆开传会让 `--es ... TEXT` 只拿到第一个词，`-n` 的包名还会被顶掉。
  const message = buildMessage()
  const quoted = `'${message.replace(/'/g, `'\\''`)}'`
  const shareCmd = `am start -a android.intent.action.SEND -t text/plain --es android.intent.extra.TEXT ${quoted} -n ${PHONE_PACKAGE}/.share.ShareActivity`
  const share = run(adbInfo.path, ['-s', serial, 'shell', shareCmd], { timeout: 30_000 })
  if (!share.ok) {
    return { ok: false, message: `启动 DSH Go 失败：${share.stderr || share.stdout}`, log: lines }
  }
  say('已把安装指令送进 DSH Go（会新开一个对话）')
  await new Promise((resolve) => setTimeout(resolve, 2500))

  const { width, height } = screenSize(adbInfo.path, serial)
  // 键盘弹出来时输入框在中间，没弹出来时贴底；两个位置都试，但**只认蓝的发送箭头**。
  // 输入框为空时右下角会变成麦克风，点它就开始录音（onDevice 的语音对话）——绝不能盲点。
  const keyboard = keyboardShown(adbInfo.path, serial)
  const spots = keyboard
    ? [[0.905, 0.59], [0.905, 0.938]]
    : [[0.905, 0.938], [0.905, 0.59]]
  let target = null
  for (const [fx, fy] of spots) {
    const x = width * fx
    const y = height * fy
    if (looksLikeSendButton(adbInfo.path, serial, x, y)) {
      target = { x, y }
      break
    }
  }
  if (!target) {
    return {
      ok: false,
      message:
        '安装指令没能送进 DSH Go 的输入框（没找到蓝色的发送按钮）。请先在手机上点开 DSH Go 的聊天页，再点一键装。',
      log: lines,
    }
  }
  // 只点这一次。发出后输入框会清空，右下角那个位置就从「发送箭头」变成「麦克风」；
  // 再补点一次会直接开始录音，所以绝不能重试这一下。
  shellTap(adbInfo.path, serial, target.x, target.y)
  await new Promise((resolve) => setTimeout(resolve, 1500))
  say('安装指令已发给手机上的 agent（可能需要它自己点几下屏幕）')

  let channel
  try {
    channel = makeChannel(config.channel)
  } catch (error) {
    return { ok: false, message: `通道配置用不了：${error?.message || error}`, log: lines }
  }
  const verified = await waitForPhoneSync(channel, config, {
    deviceName: phoneConfigJson.deviceName,
    since: startedAt,
    timeoutMs: 240_000,
    log: say,
  })
  if (verified.ok) {
    say(`手机已同步：${verified.device.name} · ${verified.device.updatedAt}`)
    return {
      ok: true,
      message: '装好了：手机上的 DSH Go 已经跑完一轮同步（以后它会自己定时同步）',
      log: lines,
      device: verified.device,
      verified: true,
    }
  }
  return {
    ok: true,
    message:
      '指令已经发给手机了，但还没等到它同步完成。看一眼手机屏幕：如果 DSH Go 的会话在跑就等它跑完；' +
      '卡住了就手动把 /sdcard/Download/dsh-CyberRelic.tar.gz 交给它安装。',
    log: lines,
    verified: false,
  }
}
