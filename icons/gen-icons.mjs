/* 生成扩展图标（16/32/48/128 PNG）。
 *
 * 为什么不直接放 SVG：Chrome 的 manifest icons / action.default_icon 不认 SVG，只认 PNG。
 * 为什么不引依赖：为一个纯色圆角方块 + 一个白色箭头装 sharp/canvas 不值得 ——
 * 这里用 node 内置 zlib 手写最小 PNG 编码器（IHDR/IDAT/IEND），跑一次即可。
 *
 * 用法：node icons/gen-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const BG = [0x34, 0x82, 0xFF];      // Miuix primary #3482FF（浅色主题）
const FG = [0xFF, 0xFF, 0xFF];      // onPrimary
const SS = 3;                       // 每边 3x 超采样，缩小时当作抗锯齿

/* ---------------- 形状：圆角方块（超椭圆近似 squircle）+ 下载箭头 ---------------- */

function insideTile(x, y, size) {
  const r = size * 0.22;                 // 圆角半径
  const half = size / 2;
  const dx = Math.abs(x - half) - (half - r);
  const dy = Math.abs(y - half) - (half - r);
  if (dx <= 0 && dy <= 0) return true;
  const ax = Math.max(dx, 0);
  const ay = Math.max(dy, 0);
  const n = 4;                           // 4 次超椭圆 = 连续曲率圆角（squircle 观感）
  return Math.pow(ax, n) + Math.pow(ay, n) <= Math.pow(r, n);
}

function insideArrow(x, y, size) {
  const u = x / size;
  const v = y / size;
  const shaft = Math.abs(u - 0.5) <= 0.075 && v >= 0.22 && v <= 0.56;
  const head = v >= 0.50 && v <= 0.72 && Math.abs(u - 0.5) <= (0.72 - v);
  const tray = v >= 0.80 && v <= 0.865 && Math.abs(u - 0.5) <= 0.255;
  return shaft || head || tray;
}

/* ---------------- 光栅化 ---------------- */

function rasterize(size) {
  const w = size * SS;
  const acc = new Float32Array(size * size);
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      if (!insideTile(px, py, w)) continue;
      const alpha = insideArrow(px, py, w) ? 1 : 0;   // 箭头是白色，底色是蓝色
      const ty = Math.floor(y / SS);
      const tx = Math.floor(x / SS);
      acc[ty * size + tx] += alpha;
    }
  }
  const rgba = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const a = acc[i] / (SS * SS);                     // 覆盖率 0..1
    rgba[i * 4 + 0] = Math.round(BG[0] + (FG[0] - BG[0]) * a);
    rgba[i * 4 + 1] = Math.round(BG[1] + (FG[1] - BG[1]) * a);
    rgba[i * 4 + 2] = Math.round(BG[2] + (FG[2] - BG[2]) * a);
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

/* ---------------- 最小 PNG 编码器 ---------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;     // bit depth
  ihdr[9] = 6;     // color type: RGBA
  ihdr[10] = 0;    // deflate
  ihdr[11] = 0;    // filter
  ihdr[12] = 0;    // no interlace
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;                       // filter type 0 (None)
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

for (const size of [16, 32, 48, 128]) {
  const png = encodePng(size, rasterize(size));
  const file = join(HERE, 'icon' + size + '.png');
  writeFileSync(file, png);
  console.log('wrote', file, png.length + ' bytes');
}
