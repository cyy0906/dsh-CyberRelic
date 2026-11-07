import zlib from 'node:zlib'

// 只做一件事：从 Android screencap 出来的 PNG 里读一个像素。
// 为了不让插件多一个 npm 依赖，这里手写一个最小 PNG 解码（8 位、非隔行、RGB/RGBA）。
export function readPngPixel(buf, x, y) {
  const info = parsePng(buf)
  if (!info) return null
  return pixelAt(info, x, y)
}

/** 解一次、读很多次：先把 PNG 解成 rows，再自己按坐标取像素 */
export function decodePng(buf) {
  const info = parsePng(buf)
  if (!info) return null
  return {
    width: info.width,
    height: info.height,
    pixel: (x, y) => pixelAt(info, x, y),
  }
}

function pixelAt(info, x, y) {
  const { width, height, colorType, rows } = info
  if (x < 0 || y < 0 || x >= width || y >= height) return null
  const row = rows[y]
  const bpp = colorType === 6 ? 4 : 3
  const offset = x * bpp
  return { r: row[offset], g: row[offset + 1], b: row[offset + 2] }
}

function parsePng(buf) {
  if (!buf || buf.length < 24) return null
  const signature = [137, 80, 78, 71, 13, 10, 26, 10]
  for (let i = 0; i < 8; i += 1) if (buf[i] !== signature[i]) return null

  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  const idat = []

  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset)
    const type = buf.toString('ascii', offset + 4, offset + 8)
    const data = buf.subarray(offset + 8, offset + 8 + length)
    offset += 12 + length
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
  }

  if (!width || !height || bitDepth !== 8 || interlace !== 0) return null
  if (colorType !== 2 && colorType !== 6) return null

  const bpp = colorType === 6 ? 4 : 3
  const stride = width * bpp
  let raw
  try {
    raw = zlib.inflateSync(Buffer.concat(idat))
  } catch {
    return null
  }
  if (raw.length < height * (stride + 1)) return null

  const rows = []
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride))
    unfilter(filter, line, prev, bpp)
    rows.push(line)
    prev = line
  }
  return { width, height, colorType, rows }
}

function unfilter(filter, line, prev, bpp) {
  for (let i = 0; i < line.length; i += 1) {
    const left = i >= bpp ? line[i - bpp] : 0
    const up = prev[i] || 0
    const upLeft = i >= bpp ? prev[i - bpp] : 0
    switch (filter) {
      case 1:
        line[i] = (line[i] + left) & 255
        break
      case 2:
        line[i] = (line[i] + up) & 255
        break
      case 3:
        line[i] = (line[i] + ((left + up) >> 1)) & 255
        break
      case 4: {
        const p = left + up - upLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - upLeft)
        const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
        line[i] = (line[i] + predictor) & 255
        break
      }
      default:
        break
    }
  }
}
