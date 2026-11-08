// Render a region of the map to a PNG from the command line (no browser needed).
//   node tools/preview.mjs --seed dnd --x 0 --y 0 --z 0 --w 1024 --h 768 --out preview.png
//   node tools/preview.mjs --stats      # print land/ocean/elevation statistics

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { createTerrain } from '../src/terrain.js';
import { renderTile, TILE, mppForZoom } from '../src/render.js';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]);
    return acc;
  }, [])
);
const seed = args.seed ?? 'dnd';
const terrain = createTerrain(seed);

if (args.stats) {
  const N = 200000, span = 40000;
  let land = 0, mtn = 0, hi = -Infinity, lo = Infinity;
  const hist = new Map();
  for (let i = 0; i < N; i++) {
    const e = terrain.elevation((Math.random() - 0.5) * span, (Math.random() - 0.5) * span, 2);
    if (e >= 0) land++;
    if (e >= 1500) mtn++;
    hi = Math.max(hi, e); lo = Math.min(lo, e);
    const b = Math.floor(e / 500) * 500;
    hist.set(b, (hist.get(b) || 0) + 1);
  }
  console.log(`land ${(100 * land / N).toFixed(1)}%  >1500m ${(100 * mtn / N).toFixed(2)}%  range ${lo.toFixed(0)}..${hi.toFixed(0)} m`);
  for (const [b, c] of [...hist].sort((a, b) => a[0] - b[0])) {
    console.log(String(b).padStart(6), '#'.repeat(Math.round((300 * c) / N)));
  }
  process.exit(0);
}

const z = Number(args.z ?? 0);
const W = Number(args.w ?? 1024), H = Number(args.h ?? 768);
const mpp = mppForZoom(z);
const cx = Number(args.x ?? 0), cy = Number(args.y ?? 0);
const left = Math.round(cx / mpp - W / 2), top = Math.round(cy / mpp - H / 2);
const img = new Uint8Array(W * H * 4);

const t0 = Date.now();
for (let ty = Math.floor(top / TILE); ty * TILE < top + H; ty++) {
  for (let tx = Math.floor(left / TILE); tx * TILE < left + W; tx++) {
    const px = renderTile(terrain, tx, ty, z);
    for (let j = 0; j < TILE; j++) {
      const y = ty * TILE + j - top;
      if (y < 0 || y >= H) continue;
      for (let i = 0; i < TILE; i++) {
        const x = tx * TILE + i - left;
        if (x < 0 || x >= W) continue;
        const s = (j * TILE + i) * 4, d = (y * W + x) * 4;
        img[d] = px[s]; img[d + 1] = px[s + 1]; img[d + 2] = px[s + 2]; img[d + 3] = 255;
      }
    }
  }
}
if (args.lines) {
  // Overlay mountain spines: main = red, subsidiary = orange.
  const x0 = left * mpp, y0 = top * mpp;
  for (const L of terrain.rangeLines(x0, y0, x0 + W * mpp, y0 + H * mpp)) {
    const col = L.rank === 0 ? [200, 30, 30] : [235, 140, 20];
    for (let k = 0; k < L.n - 1; k++) {
      const ax = L.xs[k] / mpp - left, ay = L.ys[k] / mpp - top;
      const bx = L.xs[k + 1] / mpp - left, by = L.ys[k + 1] / mpp - top;
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay)));
      for (let s = 0; s <= steps; s++) {
        const px = Math.round(ax + ((bx - ax) * s) / steps), py = Math.round(ay + ((by - ay) * s) / steps);
        if (px < 0 || py < 0 || px >= W || py >= H) continue;
        const d = (py * W + px) * 4;
        img[d] = col[0]; img[d + 1] = col[1]; img[d + 2] = col[2];
      }
    }
  }
}
console.log(`rendered ${W}x${H} at z=${z} (${mpp} mi/px) in ${Date.now() - t0} ms`);
writeFileSync(args.out ?? 'preview.png', encodePNG(img, W, H));

function encodePNG(rgba, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
