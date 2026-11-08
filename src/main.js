// Minimal viewer: pan/zoom over the elevation squares, from 10,000 miles across to 1 mile.

import { createElevation, GRID, LEVELS, squareAt, squareCentre, parentOf, biasSize, biasLevelsAt } from './elevation.js';

const MAX_VIEW = 100000; // miles across the screen, fully zoomed out

const canvas = document.getElementById('map');
const ctx = canvas.getContext('2d');
const readout = document.getElementById('readout');
const hover = document.getElementById('hover'); // elevation label that follows the cursor
const popup = document.getElementById('popup'); // details of the clicked square
let field = createElevation('dnd');

// ---------- Settings menu ----------
const wideRadios = [...document.querySelectorAll('input[name="wide"]')];
const edgeRadios = [...document.querySelectorAll('input[name="edge"]')];
const renderRadios = [...document.querySelectorAll('input[name="render"]')];
const labelRadios = [...document.querySelectorAll('input[name="labels"]')];
const settings = { wideFraction: field.wideFraction, edgeBlend: field.edgeBlend, smooth: true, labels: false };

/** Rebuild the elevation field with changed settings; keep the view and any popup. */
function applySettings(changes) {
  Object.assign(settings, changes);
  field = createElevation('dnd', { wideFraction: settings.wideFraction, edgeBlend: settings.edgeBlend });
  for (const r of renderRadios) r.checked = (r.value === 'smooth') === settings.smooth;
  for (const r of labelRadios) r.checked = (r.value === 'on') === settings.labels;
  for (const r of wideRadios) r.checked = Math.abs(Number(r.value) - settings.wideFraction) < 1e-6;
  for (const r of edgeRadios) r.checked = (r.value === 'on') === settings.edgeBlend;
  if (selected) popup.innerHTML = popupHtml(selected.L, selected.a, selected.b), bindPopupClose();
  dirty = true;
}
for (const r of wideRadios) r.addEventListener('change', () => applySettings({ wideFraction: Number(r.value) }));
for (const r of edgeRadios) r.addEventListener('change', () => applySettings({ edgeBlend: r.value === 'on' }));
for (const r of renderRadios) r.addEventListener('change', () => applySettings({ smooth: r.value === 'smooth' }));
for (const r of labelRadios) r.addEventListener('change', () => applySettings({ labels: r.value === 'on' }));

/** Move to the next option in a radio group (wrapping). */
const nextValue = (radios) => radios[(radios.findIndex((r) => r.checked) + 1) % radios.length].value;
const toggleWide = () => applySettings({ wideFraction: Number(nextValue(wideRadios)) });
const toggleEdge = () => applySettings({ edgeBlend: !settings.edgeBlend });
const toggleSmooth = () => applySettings({ smooth: !settings.smooth });
const toggleLabels = () => applySettings({ labels: !settings.labels });

const view = { cx: 0, cy: 0, width: 6000 }; // centre (miles) and miles across the screen
let cssW = 0, cssH = 0, dpr = 1;
let dirty = true;

function resize() {
  dpr = window.devicePixelRatio || 1;
  cssW = window.innerWidth;
  cssH = window.innerHeight;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  view.width = Math.min(MAX_VIEW, Math.max(minView(), view.width)); // keep within zoom limits
  dirty = true;
}

const milesPerPx = () => view.width / cssW;
const toWorld = (sx, sy) => [view.cx + (sx - cssW / 2) * milesPerPx(), view.cy + (sy - cssH / 2) * milesPerPx()];
const toScreen = (x, y) => [(x - view.cx) / milesPerPx() + cssW / 2, (y - view.cy) / milesPerPx() + cssH / 2];

// ---------- Colour ----------
// Elevation only, no vegetation: blues for water (darker = deeper), browns for land
// (darker = higher).
const STOPS = [
  [-4000, [29, 59, 92]],
  [-1000, [52, 98, 140]],
  [-1, [111, 163, 192]],
  [0, [226, 205, 165]],
  [500, [201, 168, 120]],
  [1500, [166, 122, 78]],
  [3000, [118, 82, 50]],
  [4500, [78, 52, 30]],
];
function colour(e) {
  if (e <= STOPS[0][0]) return STOPS[0][1];
  for (let k = 0; k < STOPS.length - 1; k++) {
    const [e0, c0] = STOPS[k], [e1, c1] = STOPS[k + 1];
    if (e <= e1) {
      const t = (e - e0) / (e1 - e0);
      return [c0[0] + (c1[0] - c0[0]) * t, c0[1] + (c1[1] - c0[1]) * t, c0[2] + (c1[2] - c0[2]) * t];
    }
  }
  return STOPS[STOPS.length - 1][1];
}

// ---------- Drawing ----------
// Squares at every level (see LEVELS) are drawn flat; the finest level is what's coloured.
// Level-0 square (i, j) is the 1,000-mile square centred on grid point (i, j).
const FINEST = LEVELS.length - 1;
const MIN_SQUARE_PX = 8; // smallest on-screen size at which a level is drawn

/** On-screen size (css px) of a level-L square. */
const squarePx = (L) => LEVELS[L].size / milesPerPx();

/** The level being shown: the finest whose squares are at least MIN_SQUARE_PX on screen. */
function visibleLevel() {
  for (let L = FINEST; L >= 0; L--) if (squarePx(L) >= MIN_SQUARE_PX) return L;
  return 0;
}
const squareOf = (x, y) => squareAt(0, x, y);

/** Fully zoomed in: the point where the finest (0.1-mile) squares become the level shown. */
const minView = () => (LEVELS[FINEST].size / MIN_SQUARE_PX) * cssW;

// Smooth rendering: one pixel per square in a small off-screen image, which the browser
// stretches over the screen with smooth (bilinear) blending — colours fade from each
// square's centre to its neighbours'. Still one value per square, not per screen pixel.
const off = document.createElement('canvas');
const offCtx = off.getContext('2d');

// ---------- Staggered rendering ----------
// Computing a square the first time can be slow (it pulls in its parents and neighbours),
// so each frame only spends FRAME_BUDGET_MS computing new squares, centre of the screen
// first. Squares not computed yet are drawn with their nearest computed coarser level (or
// a neutral placeholder), and the frame after continues where this one stopped.
const FRAME_BUDGET_MS = 10;
const PLACEHOLDER = [128, 128, 128];
let pendingSquares = 0; // squares still to compute for the current view
const progress = document.getElementById('progress');

/** Compute missing level-D squares in [a0..a1] x [b0..b1], centre-out, within the budget. */
function computeWithinBudget(D, a0, b0, a1, b1) {
  const missing = [];
  for (let b = b0; b <= b1; b++) {
    for (let a = a0; a <= a1; a++) if (field.peek(D, a, b) === undefined) missing.push([a, b]);
  }
  if (!missing.length) { pendingSquares = 0; return; }
  const ca = (a0 + a1) / 2, cb = (b0 + b1) / 2;
  missing.sort((p, q) => ((p[0] - ca) ** 2 + (p[1] - cb) ** 2) - ((q[0] - ca) ** 2 + (q[1] - cb) ** 2));
  const deadline = performance.now() + FRAME_BUDGET_MS;
  let k = 0;
  for (; k < missing.length; k++) {
    if ((k & 15) === 0 && performance.now() > deadline) break; // check the clock every 16
    field.value(D, missing[k][0], missing[k][1]);
  }
  pendingSquares = missing.length - k;
}

/** Colour for a square: its value if computed, else the nearest computed coarser level. */
function squareColour(D, a, b) {
  let v = field.peek(D, a, b);
  for (let L = D; v === undefined && L > 0; L--) {
    [a, b] = parentOf(L, a, b);
    v = field.peek(L - 1, a, b);
  }
  return v === undefined ? PLACEHOLDER : colour(v);
}

function drawSmooth(D) {
  const S = LEVELS[D].size;
  const [wx0, wy0] = toWorld(0, 0);
  const [wx1, wy1] = toWorld(cssW, cssH);
  // One extra square on each side, so blending at the screen edges has neighbours.
  const [a0, b0] = squareAt(D, wx0, wy0).map((v) => v - 1);
  const [a1, b1] = squareAt(D, wx1, wy1).map((v) => v + 1);
  const w = a1 - a0 + 1, h = b1 - b0 + 1;
  off.width = w;
  off.height = h;
  const img = offCtx.createImageData(w, h);
  computeWithinBudget(D, a0, b0, a1, b1);
  for (let b = b0; b <= b1; b++) {
    for (let a = a0; a <= a1; a++) {
      const c = squareColour(D, a, b);
      const o = ((b - b0) * w + (a - a0)) * 4;
      img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255;
    }
  }
  offCtx.putImageData(img, 0, 0);
  // Pixel k covers square a0 + k exactly, so pixel centres land on square centres.
  const [x0, y0] = toScreen(a0 * S - GRID / 2, b0 * S - GRID / 2);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(off, x0, y0, w * S / milesPerPx(), h * S / milesPerPx());
}

function draw() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const [wx0, wy0] = toWorld(0, 0);
  const [wx1, wy1] = toWorld(cssW, cssH);
  // Screen position of the left/top edge of square a (or b) at level L.
  const edgeX = (L, a) => Math.round(toScreen(a * LEVELS[L].size - GRID / 2, 0)[0]);
  const edgeY = (L, b) => Math.round(toScreen(0, b * LEVELS[L].size - GRID / 2)[1]);
  const pxOf = (L) => edgeX(L, 1) - edgeX(L, 0);
  const range = (L) => [...squareAt(L, wx0, wy0), ...squareAt(L, wx1, wy1)]; // a0, b0, a1, b1

  // 1. Squares of the level being shown, one colour per square.
  const D = visibleLevel();
  if (settings.smooth) drawSmooth(D);
  else {
    const [a0, b0, a1, b1] = range(D);
    computeWithinBudget(D, a0, b0, a1, b1);
    for (let b = b0; b <= b1; b++) {
      for (let a = a0; a <= a1; a++) {
        const c = squareColour(D, a, b);
        ctx.fillStyle = `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
        ctx.fillRect(edgeX(D, a), edgeY(D, b), edgeX(D, a + 1) - edgeX(D, a), edgeY(D, b + 1) - edgeY(D, b));
      }
    }
  }

  // 2. Square edges, finest first; coarser levels darker. Skipped when too small to see.
  //    In smooth mode the shown level's own edges are left out.
  for (let L = settings.smooth ? D - 1 : D; L >= 0; L--) {
    if (pxOf(L) < 6) continue;
    const [a0, b0, a1, b1] = range(L);
    ctx.strokeStyle = `rgba(0,0,0,${L === D ? 0.07 : 0.3})`; // shown level faint, coarser darker
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let a = a0; a <= a1 + 1; a++) { ctx.moveTo(edgeX(L, a) + 0.5, 0); ctx.lineTo(edgeX(L, a) + 0.5, cssH); }
    for (let b = b0; b <= b1 + 1; b++) { ctx.moveTo(0, edgeY(L, b) + 0.5); ctx.lineTo(cssW, edgeY(L, b) + 0.5); }
    ctx.stroke();
  }
  const [i0, j0, i1, j1] = range(0);

  // 3. Bias-square boundaries (10,000 mi and up), on the same half-way lines as square
  //    edges: bias square a holds grid points a*n ... a*n + n - 1 (n = size / GRID).
  const farthest = Math.max(...[[wx0, wy0], [wx1, wy0], [wx0, wy1], [wx1, wy1]].map(([x, y]) => Math.hypot(x, y)));
  for (let L = 0; L < biasLevelsAt(farthest); L++) {
    const size = biasSize(L);
    const a0 = Math.floor(wx0 / size), a1 = Math.ceil(wx1 / size);
    const b0 = Math.floor(wy0 / size), b1 = Math.ceil(wy1 / size);
    ctx.strokeStyle = 'rgba(120,0,0,0.6)';
    ctx.lineWidth = 2 + L;
    ctx.beginPath();
    for (let a = a0; a <= a1; a++) {
      const [sx] = toScreen(a * size - GRID / 2, 0);
      ctx.moveTo(sx, 0); ctx.lineTo(sx, cssH);
    }
    for (let b = b0; b <= b1; b++) {
      const [, sy] = toScreen(0, b * size - GRID / 2);
      ctx.moveTo(0, sy); ctx.lineTo(cssW, sy);
    }
    ctx.stroke();
  }

  // 4. Labels for the finest level whose squares are big enough to read.
  ctx.font = '12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let L = D; settings.labels && L >= 0; L--) { // hidden unless the Labels setting is on
    if (pxOf(L) < 95) continue; // room for a label like "500-mi: -1234 m"
    const [a0, b0, a1, b1] = range(L);
    for (let b = b0; b <= b1; b++) {
      for (let a = a0; a <= a1; a++) {
        const [sx, sy] = toScreen(...squareCentre(L, a, b));
        if (sx < -60 || sy < -20 || sx > cssW + 60 || sy > cssH + 20) continue;
        // Labels for a coarser level than the one shown say which level they are.
        const text = `${L < D ? `${LEVELS[L].size.toLocaleString()}-mi: ` : ''}${Math.round(field.value(L, a, b))} m`;
        const w = ctx.measureText(text).width + 8;
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.fillRect(sx - w / 2, sy - 9, w, 18);
        ctx.fillStyle = '#111';
        ctx.fillText(text, sx, sy);
      }
    }
    break;
  }

  // 5. Outline of the selected square.
  if (selected) {
    const { L, a, b } = selected;
    ctx.strokeStyle = '#ffd400';
    ctx.lineWidth = 3;
    ctx.strokeRect(edgeX(L, a), edgeY(L, b), edgeX(L, a + 1) - edgeX(L, a), edgeY(L, b + 1) - edgeY(L, b));
  }

  drawScaleBar();
  placePopup();

  // Unfinished squares: draw again next frame, and say so.
  if (pendingSquares > 0) dirty = true;
  progress.style.display = pendingSquares > 0 ? 'block' : 'none';
  progress.textContent = `Rendering… ${pendingSquares.toLocaleString()} squares left`;
}

function drawScaleBar() {
  const target = 150 * milesPerPx();
  const p = Math.pow(10, Math.floor(Math.log10(target)));
  const miles = [5, 2, 1].map((m) => m * p).find((m) => m <= target) ?? p;
  const len = miles / milesPerPx();
  const x = cssW - len - 20, y = cssH - 20;
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fillRect(x - 8, y - 22, len + 16, 30);
  ctx.strokeStyle = '#111';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, y - 5); ctx.lineTo(x, y); ctx.lineTo(x + len, y); ctx.lineTo(x + len, y - 5);
  ctx.stroke();
  ctx.fillStyle = '#111';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(`${miles.toLocaleString()} mi`, x + len / 2, y - 8);
}

// ---------- Interaction ----------
function zoomAt(factor, sx, sy) {
  const [wx, wy] = toWorld(sx, sy);
  view.width = Math.min(MAX_VIEW, Math.max(minView(), view.width * factor));
  view.cx = wx - (sx - cssW / 2) * milesPerPx();
  view.cy = wy - (sy - cssH / 2) * milesPerPx();
  dirty = true;
}

let drag = null;
let downAt = null; // where the pointer went down, to tell a click from a drag
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  drag = { x: e.clientX, y: e.clientY };
  downAt = { x: e.clientX, y: e.clientY };
});
let mouse = null; // last cursor position (css px), or null when off the map
canvas.addEventListener('pointermove', (e) => {
  if (drag) {
    view.cx -= (e.clientX - drag.x) * milesPerPx();
    view.cy -= (e.clientY - drag.y) * milesPerPx();
    drag = { x: e.clientX, y: e.clientY };
    dirty = true;
  }
  mouse = { x: e.clientX, y: e.clientY };
  updateHover();
});

/** Show the elevation of the pixel under the cursor (label + breakdown in the panel). */
function updateHover() {
  if (!mouse) return;
  const [wx, wy] = toWorld(mouse.x, mouse.y);
  const D = visibleLevel();
  const here = Math.round(field.value(D, ...squareAt(D, wx, wy)));
  hover.textContent = `${here} m`;
  hover.style.left = `${mouse.x + 14}px`;
  hover.style.top = `${mouse.y + 14}px`;
  hover.style.display = 'block';

  const fmt = (v) => (v >= 0 ? '+' : '−') + Math.abs(Math.round(v));
  const name = (sz) => (sz >= 1e9 ? sz / 1e9 + 'B' : sz >= 1e6 ? sz / 1e6 + 'M' : sz / 1e3 + 'K');
  const [si, sj] = squareOf(wx, wy);
  const bias = field.biases(si * GRID, sj * GRID).map((v, L) => `${name(biasSize(L))} ${fmt(v)}`).join(' · ');
  // Breakdown of the square under the cursor: inherited from the level above + own bias.
  const [fa, fb] = squareAt(D, wx, wy);
  readout.textContent = `${wx.toFixed(1)}, ${wy.toFixed(1)} mi · ${here} m = ` +
    (D === 0 ? '1,000-mi average' :
      `${Math.round(field.inherited(D, fa, fb))} inherited ${fmt(field.bias(D, fa, fb))} own bias (${LEVELS[D].size}-mi square)`) +
    `   (large-square biases: ${bias})`;
}
canvas.addEventListener('pointerup', (e) => {
  drag = null;
  if (downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) < 4) selectAt(e.clientX, e.clientY);
  downAt = null;
});
canvas.addEventListener('pointerleave', () => { mouse = null; hover.style.display = 'none'; });
canvas.addEventListener('pointercancel', () => (drag = null));
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  zoomAt(Math.exp(e.deltaY * 0.0015), e.clientX, e.clientY);
}, { passive: false });

const keys = new Set();
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closePopup(); return; }
  if (e.key === 't' || e.key === 'T') { toggleWide(); return; }
  if (e.key === 'e' || e.key === 'E') { toggleEdge(); return; }
  if (e.key === 'r' || e.key === 'R') { toggleSmooth(); return; }
  if (e.key === 'l' || e.key === 'L') { toggleLabels(); return; }
  if (e.key === '+' || e.key === '=') zoomAt(1 / 1.5, cssW / 2, cssH / 2);
  else if (e.key === '-' || e.key === '_') zoomAt(1.5, cssW / 2, cssH / 2);
  else keys.add(e.key.toLowerCase());
  if (e.key.startsWith('Arrow')) e.preventDefault();
});
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
window.addEventListener('blur', () => keys.clear());

// ---------- Square details popup ----------
let selected = null; // { L, a, b } of the clicked square


function selectAt(sx, sy) {
  const L = visibleLevel(); // click selects a square of the level being shown
  const [a, b] = squareAt(L, ...toWorld(sx, sy));
  selected = { L, a, b };
  popup.innerHTML = popupHtml(L, a, b);
  bindPopupClose();
  popup.style.display = 'block';
  dirty = true;
}

function bindPopupClose() {
  popup.querySelector('.close').addEventListener('click', closePopup);
}

function closePopup() {
  selected = null;
  popup.style.display = 'none';
  dirty = true;
}

const miles = (v) => `${Math.round(v).toLocaleString()} mi`;
const metres = (v) => `${Math.round(v).toLocaleString()} m`;
const signed = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(Math.round(v)).toLocaleString()} m`;
const sizeName = (sz) => `${sz.toLocaleString()}-mile`;

/** Popup contents. Everything inserted is a number or fixed text, so innerHTML is safe. */
function popupHtml(L, a, b) {
  const S = LEVELS[L].size;
  const [cx, cy] = squareCentre(L, a, b);
  const v = field.value(L, a, b);
  const rows = [];
  const row = (k, val, cls = '') => rows.push(`<tr class="${cls}"><td>${k}</td><td>${val}</td></tr>`);
  const blend = (l, x, y) => (field.isWide(l, x, y) ? 'wide (2 out)' : 'narrow (1 out)');

  row('Centre', `${miles(cx)}, ${miles(cy)}`);
  row('Spans', `${miles(cx - S / 2)} to ${miles(cx + S / 2)} E–W`);
  row('', `${miles(cy - S / 2)} to ${miles(cy + S / 2)} N–S`, 'muted');
  row('<b>Elevation</b>', `<b>${metres(v)}</b> ${v >= 0 ? '(land)' : '(sea)'}`);

  // The chain of levels from 1,000-mile down to this square.
  const chain = [];
  for (let l = L, x = a, y = b; l >= 0; l--) {
    chain.unshift([l, x, y]);
    if (l > 0) [x, y] = parentOf(l, x, y);
  }
  for (const [l, x, y] of chain) {
    const name = `${sizeName(LEVELS[l].size)} square (${x}, ${y})`;
    if (l === 0) {
      row(name, metres(field.average(x, y)), 'sep');
      row('raw value', metres(field.raw(x, y)), 'muted');
    } else {
      // Inherited: the parent's value, or with edge blending the average of nearby parents.
      const inh = field.inherited(l, x, y), parentV = field.value(l - 1, ...parentOf(l, x, y));
      const blended = Math.abs(inh - parentV) > 0.5;
      row(name, metres(field.value(l, x, y)), 'sep');
      row(blended ? 'inherited (edge-blended)' : 'inherited from parent', metres(inh), 'muted');
      row('own bias', signed(field.bias(l, x, y)), 'muted');
      row('raw value', metres(field.levelRaw(l, x, y)), 'muted');
    }
    row('smoothing', blend(l, x, y), 'muted');
  }

  // Large-square biases (already included in the 1,000-mile square's raw value).
  const [i, j] = chain[0].slice(1);
  field.biases(i * GRID, j * GRID).forEach((bv, k) => {
    row(`${sizeName(biasSize(k))} bias square`, signed(bv), k === 0 ? 'sep' : 'muted');
  });

  return `<button class="close" title="Close (Esc)">×</button>` +
    `<h3>${sizeName(S)} square (${a}, ${b})</h3><table>${rows.join('')}</table>`;
}

/** Keep the popup beside the selected square as the view moves; hide it if off-screen. */
function placePopup() {
  if (!selected) return;
  const { L, a, b } = selected;
  const S = LEVELS[L].size;
  const [cx, cy] = squareCentre(L, a, b);
  const [right, top] = toScreen(cx + S / 2, cy - S / 2);
  const [left] = toScreen(cx - S / 2, 0);
  if (right < 0 || left > cssW || top > cssH || toScreen(0, cy + S / 2)[1] < 0) {
    popup.style.visibility = 'hidden';
    return;
  }
  popup.style.visibility = 'visible';
  const w = popup.offsetWidth, h = popup.offsetHeight;
  let x = right + 10;
  if (x + w > cssW - 8) x = left - w - 10; // flip to the left side if no room on the right
  x = Math.max(8, Math.min(cssW - w - 8, x));
  const y = Math.max(8, Math.min(cssH - h - 8, top));
  popup.style.left = `${x}px`;
  popup.style.top = `${y}px`;
}

let lastT = 0;
function frame(t) {
  const dt = Math.min(0.05, (t - lastT) / 1000 || 0);
  lastT = t;
  const vx = (keys.has('arrowright') || keys.has('d')) - (keys.has('arrowleft') || keys.has('a'));
  const vy = (keys.has('arrowdown') || keys.has('s')) - (keys.has('arrowup') || keys.has('w'));
  if (vx || vy) {
    const speed = 600 * milesPerPx() * dt; // 600 css px per second
    view.cx += vx * speed;
    view.cy += vy * speed;
    dirty = true;
  }
  if (dirty) {
    dirty = false;
    draw();
    updateHover(); // the land under a still cursor changes when the view moves
  }
  requestAnimationFrame(frame);
}

window.addEventListener('resize', resize);
applySettings({});
resize();
requestAnimationFrame(frame);
