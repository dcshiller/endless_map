// Viewer: an infinite, tiled, pannable/zoomable map. Tiles are rendered in a worker pool
// and cached; missing tiles are temporarily filled from cached lower/higher zoom levels.

import { createTerrain } from './terrain.js';
import { TILE, mppForZoom, METERS_PER_MILE } from './render.js';

const MIN_Z = -6; // 64 mi/px
const MAX_Z = 5;  // ~50 m/px
const CACHE_LIMIT = 400;
const PAN_SPEED = 700; // device px / s

const canvas = document.getElementById('map');
const ctx = canvas.getContext('2d');
const seedInput = document.getElementById('seed');
const readout = document.getElementById('readout');

const state = { seed: 'dnd', cx: 0, cy: 0, z: 0 };
let terrain;
let dpr = 1, W = 0, H = 0;
let dirty = true;

// ---------- URL hash (shareable positions) ----------
function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (!p.has('x')) return false;
  state.seed = p.get('seed') ?? state.seed;
  state.cx = Number(p.get('x')) || 0;
  state.cy = Number(p.get('y')) || 0;
  state.z = clampZ(Math.round(Number(p.get('z')) || 0));
  return true;
}
let hashTimer = 0;
function writeHash() {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => {
    const p = new URLSearchParams({
      seed: state.seed, x: state.cx.toFixed(2), y: state.cy.toFixed(2), z: String(state.z),
    });
    history.replaceState(null, '', '#' + p.toString());
  }, 250);
}
function clampZ(z) {
  return Math.max(MIN_Z, Math.min(MAX_Z, z));
}

// ---------- Worker pool + tile cache ----------
const cache = new Map(); // key -> ImageBitmap (Map order = LRU order)
const inflight = new Map(); // key -> true
const nWorkers = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
const idle = [];
const jobs = new Map(); // id -> key
let nextId = 1;

for (let i = 0; i < nWorkers; i++) {
  const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  w.onmessage = async (e) => {
    const { id, buf } = e.data;
    const key = jobs.get(id);
    jobs.delete(id);
    idle.push(w);
    inflight.delete(key);
    if (key.startsWith(state.seed + '|')) {
      const bmp = await createImageBitmap(new ImageData(new Uint8ClampedArray(buf), TILE, TILE));
      cache.set(key, bmp);
      evict();
      dirty = true;
    }
    pump();
  };
  idle.push(w);
}

const tileKey = (z, tx, ty) => `${state.seed}|${z}/${tx}/${ty}`;

function getTile(z, tx, ty) {
  const k = tileKey(z, tx, ty);
  const b = cache.get(k);
  if (b) { cache.delete(k); cache.set(k, b); } // touch for LRU
  return b;
}

function evict() {
  while (cache.size > CACHE_LIMIT) {
    const [k, b] = cache.entries().next().value;
    b.close?.();
    cache.delete(k);
  }
}

let wanted = []; // [{z, tx, ty, d}] sorted by priority
function pump() {
  while (idle.length && wanted.length) {
    const t = wanted.shift();
    const key = tileKey(t.z, t.tx, t.ty);
    if (cache.has(key) || inflight.has(key)) continue;
    const w = idle.pop();
    const id = nextId++;
    jobs.set(id, key);
    inflight.set(key, true);
    w.postMessage({ id, seed: state.seed, tx: t.tx, ty: t.ty, z: t.z });
  }
}

// ---------- Drawing ----------
function resize() {
  dpr = window.devicePixelRatio || 1;
  W = Math.round(window.innerWidth * dpr);
  H = Math.round(window.innerHeight * dpr);
  canvas.width = W;
  canvas.height = H;
  dirty = true;
}

function draw() {
  const z = state.z;
  const mpp = mppForZoom(z);
  // Top-left of the screen in world pixels at this zoom (integer-aligned to avoid seams).
  const left = Math.round(state.cx / mpp - W / 2);
  const top = Math.round(state.cy / mpp - H / 2);
  const tx0 = Math.floor(left / TILE), tx1 = Math.floor((left + W - 1) / TILE);
  const ty0 = Math.floor(top / TILE), ty1 = Math.floor((top + H - 1) / TILE);

  ctx.imageSmoothingEnabled = true;
  ctx.fillStyle = '#26405c';
  ctx.fillRect(0, 0, W, H);

  const need = [];
  const ccx = (tx0 + tx1) / 2, ccy = (ty0 + ty1) / 2;
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const sx = tx * TILE - left, sy = ty * TILE - top;
      const bmp = getTile(z, tx, ty);
      if (bmp) {
        ctx.drawImage(bmp, sx, sy);
        continue;
      }
      need.push({ z, tx, ty, d: (tx - ccx) ** 2 + (ty - ccy) ** 2 });
      drawFallback(z, tx, ty, sx, sy);
    }
  }
  // One ring of prefetch around the viewport, at lower priority.
  for (let ty = ty0 - 1; ty <= ty1 + 1; ty++) {
    for (let tx = tx0 - 1; tx <= tx1 + 1; tx++) {
      if (ty >= ty0 && ty <= ty1 && tx >= tx0 && tx <= tx1) continue;
      if (!cache.has(tileKey(z, tx, ty))) need.push({ z, tx, ty, d: 1e6 + (tx - ccx) ** 2 + (ty - ccy) ** 2 });
    }
  }
  need.sort((a, b) => a.d - b.d);
  wanted = need;
  pump();

  if (showLines) drawRangeLines(mpp, left, top);
  drawScaleBar(mpp);
}

/** Overlay: the mountain spine polylines that define the terrain. */
let showLines = false;
function drawRangeLines(mpp, left, top) {
  const x0 = left * mpp, y0 = top * mpp;
  const lines = terrain.rangeLines(x0, y0, x0 + W * mpp, y0 + H * mpp);
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const L of lines) {
    // Colour by belt height: low = orange, high = deep red.
    const t = Math.min(1, L.maxH / 5000);
    ctx.strokeStyle = `rgba(${200 - 60 * t}, ${110 - 100 * t}, 20, ${L.rank === 0 ? 0.95 : 0.7})`;
    ctx.lineWidth = (L.rank === 0 ? 2.5 : 1.5) * dpr;
    ctx.beginPath();
    for (let k = 0; k < L.n; k++) {
      const sx = L.xs[k] / mpp - left, sy = L.ys[k] / mpp - top;
      if (k === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
    }
    ctx.stroke();
  }
  ctx.restore();
}

/** Fill a missing tile from a cached ancestor (upscaled) or descendants (downscaled). */
function drawFallback(z, tx, ty, sx, sy) {
  for (let k = 1; k <= 4 && z - k >= MIN_Z; k++) {
    const f = 1 << k;
    const ptx = Math.floor(tx / f), pty = Math.floor(ty / f);
    const bmp = cache.get(tileKey(z - k, ptx, pty));
    if (bmp) {
      const sub = TILE / f;
      ctx.drawImage(bmp, (tx - ptx * f) * sub, (ty - pty * f) * sub, sub, sub, sx, sy, TILE, TILE);
      return;
    }
  }
  if (z + 1 <= MAX_Z) {
    const half = TILE / 2;
    for (let j = 0; j < 2; j++) {
      for (let i = 0; i < 2; i++) {
        const bmp = cache.get(tileKey(z + 1, tx * 2 + i, ty * 2 + j));
        if (bmp) ctx.drawImage(bmp, sx + i * half, sy + j * half, half, half);
      }
    }
  }
}

function drawScaleBar(mpp) {
  const target = 140 * dpr * mpp; // miles spanned by ~140 css px
  const steps = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000];
  let miles = steps[0];
  for (const s of steps) if (s <= target) miles = s;
  const len = miles / mpp;
  const x = W - len - 24 * dpr, y = H - 24 * dpr;
  ctx.save();
  ctx.fillStyle = 'rgba(244,236,214,0.9)';
  ctx.fillRect(x - 8 * dpr, y - 22 * dpr, len + 16 * dpr, 32 * dpr);
  ctx.strokeStyle = '#2d241a';
  ctx.lineWidth = 2 * dpr;
  ctx.beginPath();
  ctx.moveTo(x, y - 5 * dpr); ctx.lineTo(x, y); ctx.lineTo(x + len, y); ctx.lineTo(x + len, y - 5 * dpr);
  ctx.stroke();
  ctx.fillStyle = '#2d241a';
  ctx.font = `${12 * dpr}px Georgia, serif`;
  ctx.textAlign = 'center';
  ctx.fillText(miles < 1 ? `${miles} mi` : `${miles} miles`, x + len / 2, y - 8 * dpr);
  ctx.restore();
}

function frame(t) {
  updateKeys(t);
  if (dirty) {
    dirty = false;
    draw();
  }
  requestAnimationFrame(frame);
}

// ---------- Interaction ----------
function setView(cx, cy, z) {
  state.cx = cx; state.cy = cy; state.z = z;
  dirty = true;
  writeHash();
}

function zoomAt(newZ, sx, sy) {
  newZ = clampZ(newZ);
  if (newZ === state.z) return;
  const m0 = mppForZoom(state.z), m1 = mppForZoom(newZ);
  const wx = state.cx + (sx - W / 2) * m0, wy = state.cy + (sy - H / 2) * m0;
  setView(wx - (sx - W / 2) * m1, wy - (sy - H / 2) * m1, newZ);
}

let drag = null;
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  drag = { x: e.clientX, y: e.clientY };
  canvas.classList.add('dragging');
});
canvas.addEventListener('pointermove', (e) => {
  if (drag) {
    const mpp = mppForZoom(state.z);
    setView(state.cx - (e.clientX - drag.x) * dpr * mpp, state.cy - (e.clientY - drag.y) * dpr * mpp, state.z);
    drag.x = e.clientX; drag.y = e.clientY;
  }
  updateReadout(e.clientX * dpr, e.clientY * dpr);
});
const endDrag = () => { drag = null; canvas.classList.remove('dragging'); };
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

let wheelAcc = 0;
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  wheelAcc += e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
  if (Math.abs(wheelAcc) >= 100) {
    zoomAt(state.z + (wheelAcc < 0 ? 1 : -1), e.clientX * dpr, e.clientY * dpr);
    wheelAcc = 0;
  }
}, { passive: false });

const keys = new Set();
window.addEventListener('keydown', (e) => {
  if (e.target === seedInput) return;
  if (e.key === '+' || e.key === '=') zoomAt(state.z + 1, W / 2, H / 2);
  else if (e.key === '-' || e.key === '_') zoomAt(state.z - 1, W / 2, H / 2);
  else if (e.key === 'l' || e.key === 'L') { showLines = !showLines; dirty = true; }
  else keys.add(e.key.toLowerCase());
  if (e.key.startsWith('Arrow')) e.preventDefault();
});
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
window.addEventListener('blur', () => keys.clear());

let lastT = 0;
function updateKeys(t) {
  const dt = Math.min(0.05, (t - lastT) / 1000 || 0);
  lastT = t;
  let vx = 0, vy = 0;
  if (keys.has('arrowleft') || keys.has('a')) vx -= 1;
  if (keys.has('arrowright') || keys.has('d')) vx += 1;
  if (keys.has('arrowup') || keys.has('w')) vy -= 1;
  if (keys.has('arrowdown') || keys.has('s')) vy += 1;
  if (!vx && !vy) return;
  const speed = PAN_SPEED * dpr * mppForZoom(state.z) * (keys.has('shift') ? 3 : 1) * dt;
  setView(state.cx + vx * speed, state.cy + vy * speed, state.z);
}

function updateReadout(sx, sy) {
  const mpp = mppForZoom(state.z);
  const wx = state.cx + (sx - W / 2) * mpp, wy = state.cy + (sy - H / 2) * mpp;
  const e = terrain.elevation(wx, wy);
  const ft = e * 3.28084;
  const kind = e < 0 ? 'depth' : 'elev.';
  readout.textContent =
    `${wx.toFixed(1)}, ${wy.toFixed(1)} mi · ${kind} ${Math.abs(e).toFixed(0)} m (${Math.abs(ft).toFixed(0)} ft)`;
}

seedInput.addEventListener('change', () => {
  const s = seedInput.value.trim() || 'dnd';
  if (s === state.seed) return;
  state.seed = s;
  terrain = createTerrain(s);
  for (const b of cache.values()) b.close?.();
  cache.clear();
  const [x, y] = findLand();
  setView(x, y, state.z);
});

/** Spiral outward from the origin to find somewhere on land to start. */
function findLand() {
  for (let r = 0; r < 4000; r += 40) {
    const n = Math.max(1, Math.round((2 * Math.PI * r) / 40));
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n;
      const x = r * Math.cos(a), y = r * Math.sin(a);
      if (terrain.elevation(x, y, 4) > 200) return [x, y];
    }
  }
  return [0, 0];
}

// ---------- Boot ----------
const fromHash = readHash();
terrain = createTerrain(state.seed);
if (!fromHash) {
  const [x, y] = findLand();
  state.cx = x; state.cy = y; state.z = -1;
}
seedInput.value = state.seed;
window.addEventListener('resize', resize);
resize();
writeHash();
requestAnimationFrame(frame);
