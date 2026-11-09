// Viewer: pan/zoom over the elevation squares, from 100,000 miles across down to the point
// where 0.1-mile squares show. Hover shows elevation; clicking a square shows its details.

import { createElevation, GRID, LEVELS, TILE, squareAt, squareCentre, parentOf, biasSize, biasLevelsAt } from './elevation.js';
import { PLATE_CELL, boundaryKind } from './plates.js';
import { HOTSPOT_CELL, CHAIN_REACH } from './hotspots.js';
import { POLE_DISTANCE, CELL_SIZE, MAX_CELL_RADIUS } from './climate.js';

const MAX_VIEW = 100000; // miles across the screen, fully zoomed out

const canvas = document.getElementById('map');
const ctx = canvas.getContext('2d');
const readout = document.getElementById('readout');
const hover = document.getElementById('hover'); // elevation label that follows the cursor
const popup = document.getElementById('popup'); // details of the clicked square
const SEED = 'dnd';
let field = createElevation(SEED);

// ---------- Settings menu ----------
const wideRadios = [...document.querySelectorAll('input[name="wide"]')];
const renderRadios = [...document.querySelectorAll('input[name="render"]')];
const labelRadios = [...document.querySelectorAll('input[name="labels"]')];
const plateRadios = [...document.querySelectorAll('input[name="plates"]')];
const viewRadios = [...document.querySelectorAll('input[name="view"]')];
const windRadios = [...document.querySelectorAll('input[name="wind"]')];
const settings = { wideFraction: field.wideFraction, smooth: true, labels: false, plates: true, view: 'elevation', wind: false };

/** Apply changed settings; keep the view and any popup. */
function applySettings(changes) {
  const rebuild = 'wideFraction' in changes && changes.wideFraction !== field.wideFraction;
  Object.assign(settings, changes);
  if (rebuild) {
    // Only the model's own settings need a new field (and new colours for every square).
    field = createElevation(SEED, { wideFraction: settings.wideFraction });
    tileCache = new Map();
    workTiles = []; // old tiles; the next draw lists the new ones
    configureWorkers();
  }
  for (const r of renderRadios) r.checked = (r.value === 'smooth') === settings.smooth;
  for (const r of labelRadios) r.checked = (r.value === 'on') === settings.labels;
  for (const r of plateRadios) r.checked = (r.value === 'on') === settings.plates;
  for (const r of viewRadios) r.checked = r.value === settings.view;
  for (const r of windRadios) r.checked = (r.value === 'on') === settings.wind;
  for (const r of wideRadios) r.checked = Math.abs(Number(r.value) - settings.wideFraction) < 1e-6;
  if (selected) popup.innerHTML = popupHtml(selected.L, selected.a, selected.b), bindPopupClose();
  dirty = true;
}
for (const r of wideRadios) r.addEventListener('change', () => applySettings({ wideFraction: Number(r.value) }));
for (const r of renderRadios) r.addEventListener('change', () => applySettings({ smooth: r.value === 'smooth' }));
for (const r of labelRadios) r.addEventListener('change', () => applySettings({ labels: r.value === 'on' }));
for (const r of plateRadios) r.addEventListener('change', () => applySettings({ plates: r.value === 'on' }));
for (const r of viewRadios) r.addEventListener('change', () => applySettings({ view: r.value }));
for (const r of windRadios) r.addEventListener('change', () => applySettings({ wind: r.value === 'on' }));

/** Move to the next option in a radio group (wrapping). */
const nextValue = (radios) => radios[(radios.findIndex((r) => r.checked) + 1) % radios.length].value;
const toggleWide = () => applySettings({ wideFraction: Number(nextValue(wideRadios)) });
const toggleSmooth = () => applySettings({ smooth: !settings.smooth });
const toggleLabels = () => applySettings({ labels: !settings.labels });
const togglePlates = () => applySettings({ plates: !settings.plates });
const toggleView = () => applySettings({ view: settings.view === 'plates' ? 'elevation' : 'plates' });
const toggleWind = () => applySettings({ wind: !settings.wind });

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

// Precomputed colours every LUT_STEP metres, so drawing a square is a table lookup.
const LUT_MIN = -8000, LUT_MAX = 8000, LUT_STEP = 5;
const LUT = new Uint8ClampedArray(((LUT_MAX - LUT_MIN) / LUT_STEP + 1) * 3);
for (let k = 0; k * LUT_STEP + LUT_MIN <= LUT_MAX; k++) LUT.set(colour(k * LUT_STEP + LUT_MIN), k * 3);
/** Index into LUT for elevation e. */
const lutIndex = (e) => 3 * Math.round((Math.min(LUT_MAX, Math.max(LUT_MIN, e)) - LUT_MIN) / LUT_STEP);

// ---------- Drawing ----------
// One level of squares (see LEVELS) is shown at a time: the finest that's big enough on
// screen. Level-0 square (i, j) is the 1,000-mile square centred on grid point (i, j).
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

// ---------- Rendering the shown level ----------
// Squares are coloured into an off-screen image with one pixel per square, which is then
// stretched over the screen: with smooth blending (colours fade between square centres) or
// without (flat blocks). Still one value per square, not per screen pixel.
//
// Squares are kept in tiles of TILE x TILE (the same tiles the model computes), each
// holding its squares' colours, so a frame only copies tile rows; drawing never computes
// squares. New tiles are computed in the background by Web Workers (see "Background
// computing" below), tiles nearest the centre of the screen first. Until a square is
// computed it shows its nearest computed coarser level (or grey), so zooming into a new
// level starts coarse and sharpens from the centre outward.
const WORK_SLICE_MS = 8;
const TILE_CACHE_MAX = 6000;
let tileCache = new Map(); // "D:ta,tb" -> tile
let pendingSquares = 0;    // squares still to compute for the current view
const progress = document.getElementById('progress');
const off = document.createElement('canvas');
const offCtx = off.getContext('2d');
let offImg = null;

/** Write the colour for elevation v (or grey if unknown) into rgba at pixel p. */
function putColour(rgba, p, v) {
  if (v === undefined) { rgba[p] = rgba[p + 1] = rgba[p + 2] = 128; }
  else { const k = lutIndex(v); rgba[p] = LUT[k]; rgba[p + 1] = LUT[k + 1]; rgba[p + 2] = LUT[k + 2]; }
  rgba[p + 3] = 255;
}

/** Nearest already-computed value for level-D square (a, b): itself, else its ancestors. */
function nearestKnown(D, a, b) {
  let v = field.peek(D, a, b);
  for (let L = D; v === undefined && L > 0; L--) {
    [a, b] = parentOf(L, a, b);
    v = field.peek(L - 1, a, b);
  }
  return v;
}

/** The tile of level D at tile index (ta, tb), created (with fallback colours) if needed. */
function getTile(D, ta, tb) {
  const key = D + ':' + ta + ',' + tb;
  let t = tileCache.get(key);
  if (t) return t;
  t = { D, ta, tb, key, rgba: new Uint8ClampedArray(TILE * TILE * 4), done: new Uint8Array(TILE * TILE), left: TILE * TILE, next: 0 };
  for (let j = 0; j < TILE; j++) {
    for (let i = 0; i < TILE; i++) {
      const a = ta * TILE + i, b = tb * TILE + j, q = j * TILE + i;
      const exact = field.peek(D, a, b);
      if (exact !== undefined) { t.done[q] = 1; t.left--; }
      putColour(t.rgba, q * 4, exact !== undefined ? exact : nearestKnown(D, a, b));
    }
  }
  tileCache.set(key, t);
  if (tileCache.size > TILE_CACHE_MAX) tileCache.delete(tileCache.keys().next().value);
  return t;
}

/** Compute the tile's remaining squares in order until the deadline. */
function advanceTile(t, deadline) {
  while (t.left > 0) {
    if (performance.now() > deadline) return;
    while (t.done[t.next]) t.next++;
    const q = t.next, a = t.ta * TILE + (q % TILE), b = t.tb * TILE + Math.floor(q / TILE);
    putColour(t.rgba, q * 4, field.value(t.D, a, b));
    t.done[q] = 1;
    t.left--;
  }
}

// ---------- Background computing ----------
// A pool of Web Workers (src/worker.js), each running its own copy of the model with the
// same seed and settings, computes tiles off the main thread. The main thread hands out the
// current view's missing tiles, nearest the centre first, keeping each worker up to
// IN_FLIGHT_PER_WORKER tiles ahead. Results, and the coarser ancestor tiles a worker
// computed on the way, are imported into the main thread's model (so hover, popups and
// fallback colours use them) and coloured.
//
// If workers aren't available, a setTimeout loop computes on the main thread instead,
// WORK_SLICE_MS at a time, yielding to the browser between slices.
const WORKER_COUNT = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
const IN_FLIGHT_PER_WORKER = 2;
let workers = [];
let gen = 0;                 // model generation: bumped when settings rebuild the model
const inFlight = new Set();  // keys of tiles handed to a worker and not yet back
let fallbackStale = false;   // coarser tiles arrived: pending squares can show better colours
let workTiles = [];          // tiles of the current view, nearest the centre first
let workTimer = null;        // pending setTimeout of the main-thread fallback, if any

function startWorkers() {
  try {
    for (let k = 0; k < WORKER_COUNT; k++) {
      const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      w.busy = 0;
      w.onmessage = (e) => onTiles(w, e.data);
      w.onerror = (err) => {
        console.error('Worker failed; computing on the main thread instead.', err.message || err);
        for (const x of workers) x.terminate();
        workers = [];
        inFlight.clear();
        pump();
      };
      workers.push(w);
    }
  } catch (err) {
    workers = [];
  }
  configureWorkers();
}

/** Give every worker a fresh model with the current settings. */
function configureWorkers() {
  gen++;
  inFlight.clear();
  for (const w of workers) {
    w.busy = 0;
    w.postMessage({ type: 'config', seed: SEED, wideFraction: settings.wideFraction, gen });
  }
}

/** Tiles back from a worker: import them, colour any matching tiles, hand out more. */
function onTiles(w, msg) {
  if (msg.gen !== gen) return; // from before a settings change
  w.busy--;
  for (const t of msg.tiles) {
    field.importTile(t.L, t.ta, t.tb, { core: t.core, value: t.value });
    const key = t.L + ':' + t.ta + ',' + t.tb;
    inFlight.delete(key);
    const ct = tileCache.get(key);
    if (ct && ct.left) {
      for (let q = 0; q < TILE * TILE; q++) if (!ct.done[q]) putColour(ct.rgba, q * 4, t.value[q]), ct.done[q] = 1;
      ct.left = 0;
    }
  }
  if (msg.tiles.length > 1) fallbackStale = true;
  dirty = true;
  pump();
}

/** Hand the view's missing tiles to idle workers, nearest the centre first. */
function pump() {
  if (!workers.length) { scheduleWork(); return; }
  for (const t of workTiles) {
    if (!t.left || inFlight.has(t.key)) continue;
    let w = workers[0];
    for (const x of workers) if (x.busy < w.busy) w = x;
    if (w.busy >= IN_FLIGHT_PER_WORKER) return;
    w.busy++;
    inFlight.add(t.key);
    w.postMessage({ type: 'tile', L: t.D, ta: t.ta, tb: t.tb, gen });
  }
}

/** Show the nearest computed coarser colour for squares still pending. */
function refreshFallbacks(tiles) {
  for (const t of tiles) {
    if (!t.left) continue;
    for (let q = 0; q < TILE * TILE; q++) {
      if (!t.done[q]) putColour(t.rgba, q * 4, nearestKnown(t.D, t.ta * TILE + (q % TILE), t.tb * TILE + Math.floor(q / TILE)));
    }
  }
}

// Main-thread fallback.
function scheduleWork() {
  if (workTimer === null) workTimer = setTimeout(doWork, 0);
}

function doWork() {
  workTimer = null;
  const deadline = performance.now() + WORK_SLICE_MS;
  let progressed = false, left = 0;
  for (const t of workTiles) {
    if (t.left && performance.now() < deadline) {
      const before = t.left;
      advanceTile(t, deadline);
      progressed ||= t.left < before;
    }
    left += t.left;
  }
  if (progressed) dirty = true; // show the new squares on the next frame
  if (left) scheduleWork();
}

startWorkers();

/** Draw level D over the screen (smooth or blocky) from what's computed so far. */
function drawLevel(D, smooth) {
  const S = LEVELS[D].size;
  const [wx0, wy0] = toWorld(0, 0);
  const [wx1, wy1] = toWorld(cssW, cssH);
  // One extra square on each side, so blending at the screen edges has neighbours.
  const [a0, b0] = squareAt(D, wx0, wy0).map((v) => v - 1);
  const [a1, b1] = squareAt(D, wx1, wy1).map((v) => v + 1);
  const w = a1 - a0 + 1, h = b1 - b0 + 1;

  // Tiles covering the view, nearest the centre first.
  const ca = (a0 + a1) / 2 / TILE, cb = (b0 + b1) / 2 / TILE;
  const tiles = [];
  for (let tb = Math.floor(b0 / TILE); tb <= Math.floor(b1 / TILE); tb++) {
    for (let ta = Math.floor(a0 / TILE); ta <= Math.floor(a1 / TILE); ta++) {
      const t = getTile(D, ta, tb);
      t.dist = (ta + 0.5 - ca) ** 2 + (tb + 0.5 - cb) ** 2;
      tiles.push(t);
    }
  }
  tiles.sort((p, q) => p.dist - q.dist);
  pendingSquares = 0;
  for (const t of tiles) pendingSquares += t.left;
  workTiles = tiles; // the workers work through these, nearest first
  if (fallbackStale) { fallbackStale = false; refreshFallbacks(tiles); }
  if (pendingSquares) pump();

  // Assemble the visible part of each tile into one image (one pixel per square).
  if (off.width !== w || off.height !== h || !offImg) {
    off.width = w; off.height = h;
    offImg = offCtx.createImageData(w, h);
  }
  const data = offImg.data;
  for (const t of tiles) {
    const ia = Math.max(a0, t.ta * TILE), ib = Math.min(a1, t.ta * TILE + TILE - 1);
    const ja = Math.max(b0, t.tb * TILE), jb = Math.min(b1, t.tb * TILE + TILE - 1);
    const len = (ib - ia + 1) * 4;
    for (let b = ja; b <= jb; b++) {
      const src = ((b - t.tb * TILE) * TILE + (ia - t.ta * TILE)) * 4;
      data.set(t.rgba.subarray(src, src + len), ((b - b0) * w + (ia - a0)) * 4);
    }
  }
  offCtx.putImageData(offImg, 0, 0);

  // Pixel k covers square a0 + k exactly, so pixel centres land on square centres.
  const [x0, y0] = toScreen(a0 * S - GRID / 2, b0 * S - GRID / 2);
  ctx.imageSmoothingEnabled = smooth;
  ctx.imageSmoothingQuality = 'low'; // plain bilinear: same look when enlarging, much cheaper
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

  if (settings.view === 'plates') {
    // Plates view: continents and hotspots only, no elevation.
    pendingSquares = 0;
    drawPlatesView(wx0, wy0, wx1, wy1);
  } else {
    // 1. Squares of the level being shown, one colour per square.
    const D = visibleLevel();
    drawLevel(D, settings.smooth);

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

    // 5. Plates overlay, with hotspots and their chains.
    if (settings.plates) {
      drawPlates(wx0, wy0, wx1, wy1);
      drawHotspots(wx0, wy0, wx1, wy1, false);
    }
  }

  // Wind overlay (either view).
  if (settings.wind) drawWind(wx0, wy0, wx1, wy1);

  // 6. Outline of the selected square.
  if (selected) {
    const { L, a, b } = selected;
    ctx.strokeStyle = '#ffd400';
    ctx.lineWidth = 3;
    ctx.strokeRect(edgeX(L, a), edgeY(L, b), edgeX(L, a + 1) - edgeX(L, a), edgeY(L, b + 1) - edgeY(L, b));
  }

  drawScaleBar();
  placePopup();

  // Unfinished squares: the background loop redraws as it finishes them.
  progress.style.display = pendingSquares > 0 ? 'block' : 'none';
  progress.textContent = `Rendering… ${pendingSquares.toLocaleString()} squares left`;
}

// ---------- Plates overlay ----------
// Plate boundaries run along 1,000-mile square edges between squares of different plates,
// coloured by what the two plates do there. Each plate's seed gets an arrow showing its
// motion, labelled C (continental) or O (oceanic).
const BOUNDARY_COLOURS = {
  collision: '#d7191c', subduction: '#e66101', 'island arc': '#f4a3a8',
  'mid-ocean ridge': '#2c7bb6', rift: '#5ab4ac', transform: '#777',
};

function drawPlates(wx0, wy0, wx1, wy1) {
  const P = field.plates;
  const [i0, j0] = squareAt(0, wx0, wy0), [i1, j1] = squareAt(0, wx1, wy1);
  const edge = (i) => toScreen((i - 0.5) * GRID, (i - 0.5) * GRID); // corner of square i
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  // Boundaries: compare each square with its right and lower neighbour.
  for (let j = j0 - 1; j <= j1; j++) {
    for (let i = i0 - 1; i <= i1; i++) {
      const A = P.at(i, j).plate;
      for (const [di, dj] of [[1, 0], [0, 1]]) {
        const B = P.at(i + di, j + dj).plate;
        if (A === B) continue;
        const c = P.convergence(A, B);
        const kind = boundaryKind(A, B, c);
        ctx.strokeStyle = BOUNDARY_COLOURS[kind];
        const [x, y] = [edge(i + 1)[0], edge(j + 1)[1]]; // lower-right corner of (i, j)
        const [xl, yt] = [edge(i)[0], edge(j)[1]];      // upper-left corner
        ctx.beginPath();
        if (di) { ctx.moveTo(x, yt); ctx.lineTo(x, y); } else { ctx.moveTo(xl, y); ctx.lineTo(x, y); }
        ctx.stroke();
      }
    }
  }
  // Plate motion arrows at each seed.
  const p0 = Math.floor((wx0 + GRID / 2) / PLATE_CELL) - 1, p1 = Math.floor((wx1 + GRID / 2) / PLATE_CELL) + 1;
  const q0 = Math.floor((wy0 + GRID / 2) / PLATE_CELL) - 1, q1 = Math.floor((wy1 + GRID / 2) / PLATE_CELL) + 1;
  ctx.font = 'bold 12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let q = q0; q <= q1; q++) {
    for (let p = p0; p <= p1; p++) {
      const pl = P.plateIn(p, q);
      if (!pl) continue;
      const [sx, sy] = toScreen(pl.sx, pl.sy);
      if (sx < -60 || sy < -60 || sx > cssW + 60 || sy > cssH + 60) continue;
      const len = 18 + 40 * pl.speed;
      const ex = sx + Math.cos(pl.angle) * len, ey = sy + Math.sin(pl.angle) * len;
      ctx.strokeStyle = '#111';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(sx, sy); ctx.lineTo(ex, ey);
      for (const s of [-1, 1]) { // arrowhead
        const a = pl.angle + Math.PI + s * 0.45;
        ctx.moveTo(ex, ey); ctx.lineTo(ex + Math.cos(a) * 9, ey + Math.sin(a) * 9);
      }
      ctx.stroke();
      ctx.fillStyle = pl.continental ? '#7a4f22' : '#1d4f7a';
      ctx.beginPath(); ctx.arc(sx, sy, 9, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillText(pl.continental ? 'C' : 'O', sx, sy + 0.5);
    }
  }
}

// ---------- Wind overlay ----------
// Latitude lines (equators, poles, dashed 30° and 60°), H/L at pressure centres, and an
// arrow grid showing wind direction; arrow length and darkness show speed.
const compassName = (u, v) => ['E', 'NE', 'N', 'NW', 'W', 'SW', 'S', 'SE'][((Math.round(Math.atan2(-v, u) / (Math.PI / 4)) % 8) + 8) % 8];
/** Where wind (u east, v south) blows FROM, as a compass point. */
const windFrom = (u, v) => compassName(-u, -v);

function drawWind(wx0, wy0, wx1, wy1) {
  const C = field.climate;
  // Latitude lines: equator at 0°, pole at 90°, every POLE_DISTANCE / 3 a 30° step.
  const step = POLE_DISTANCE / 3;
  ctx.font = '12px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  for (let k = Math.floor(wy0 / step); k <= Math.ceil(wy1 / step); k++) {
    const y = k * step;
    const lat = Math.round(field.climate.windAt(0, y).lat);
    const [, sy] = toScreen(0, y);
    const major = lat === 0 || lat === 90;
    ctx.strokeStyle = lat === 0 ? 'rgba(255,200,0,0.9)' : lat === 90 ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.5)';
    ctx.lineWidth = major ? 2 : 1;
    ctx.setLineDash(major ? [] : [8, 6]);
    ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(cssW, sy); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    const label = lat === 0 ? 'Equator' : lat === 90 ? 'Pole' : `${lat}°`;
    ctx.fillText(label, 8, sy - 3);
  }
  // Pressure centres.
  const reach = MAX_CELL_RADIUS;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let q = Math.floor((wy0 - reach) / CELL_SIZE); q <= Math.floor((wy1 + reach) / CELL_SIZE); q++) {
    for (let p = Math.floor((wx0 - reach) / CELL_SIZE); p <= Math.floor((wx1 + reach) / CELL_SIZE); p++) {
      const c = C.cellIn(p, q);
      if (!c || Math.abs(c.strength) < 0.3) continue;
      const [sx, sy] = toScreen(c.x, c.y);
      ctx.font = `bold ${Math.round(14 + 8 * Math.min(2, Math.abs(c.strength)))}px system-ui, sans-serif`;
      ctx.fillStyle = c.strength > 0 ? 'rgba(170,20,20,0.85)' : 'rgba(20,60,170,0.85)';
      ctx.fillText(c.strength > 0 ? 'H' : 'L', sx, sy);
    }
  }
  // Arrow grid.
  const gap = 56;
  ctx.lineWidth = 1.5;
  for (let sy = gap / 2; sy < cssH; sy += gap) {
    for (let sx = gap / 2; sx < cssW; sx += gap) {
      const w = C.weatherAt(...toWorld(sx, sy)); // steered wind of that weather square
      if (w.speed < 0.02) continue;
      const len = Math.min(26, 6 + 14 * w.speed);
      const ux = w.u / w.speed, uy = w.v / w.speed;
      const x0 = sx - ux * len / 2, y0 = sy - uy * len / 2, x1 = sx + ux * len / 2, y1 = sy + uy * len / 2;
      ctx.strokeStyle = `rgba(20,20,20,${Math.min(0.9, 0.35 + 0.4 * w.speed)})`;
      ctx.beginPath();
      ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
      const a = Math.atan2(uy, ux);
      for (const sgn of [-1, 1]) ctx.moveTo(x1, y1), ctx.lineTo(x1 - Math.cos(a + sgn * 0.5) * 6, y1 - Math.sin(a + sgn * 0.5) * 6);
      ctx.stroke();
    }
  }
}

// ---------- Plates view ----------
// Continents and hotspots only: each 1,000-mile square coloured by its plate (tan for
// continental, blue for oceanic, each plate a slightly different shade), plate boundaries
// and motion arrows, and hotspots with their volcano chains. Elevation is ignored.
function plateColour(pl) {
  const shade = (((pl.p * 73856093) ^ (pl.q * 19349663)) >>> 0) % 29 - 14; // per plate, -14..14
  const [r, g, b] = pl.continental ? [214, 190, 150] : [126, 166, 204];
  return `rgb(${r + shade},${g + shade},${b + shade})`;
}

function drawPlatesView(wx0, wy0, wx1, wy1) {
  const P = field.plates;
  const [i0, j0] = squareAt(0, wx0, wy0), [i1, j1] = squareAt(0, wx1, wy1);
  const ex = (i) => Math.round(toScreen((i - 0.5) * GRID, 0)[0]);
  const ey = (j) => Math.round(toScreen(0, (j - 0.5) * GRID)[1]);
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      ctx.fillStyle = plateColour(P.at(i, j).plate);
      ctx.fillRect(ex(i), ey(j), ex(i + 1) - ex(i), ey(j + 1) - ey(j));
    }
  }
  drawPlates(wx0, wy0, wx1, wy1);
  drawHotspots(wx0, wy0, wx1, wy1, true);
}

/**
 * Hotspots in view: a red dot at each plume and its chain of volcanoes trailing behind the
 * plate's motion. full = draw each volcano as a circle (size = radius, fading with age);
 * otherwise just a thin line along the chain.
 */
function drawHotspots(wx0, wy0, wx1, wy1, full) {
  const H = field.hotspots;
  const reach = CHAIN_REACH; // a chain can extend this far (miles) from its hotspot's region
  const p0 = Math.floor((wx0 - reach + GRID / 2) / HOTSPOT_CELL), p1 = Math.floor((wx1 + reach + GRID / 2) / HOTSPOT_CELL);
  const q0 = Math.floor((wy0 - reach + GRID / 2) / HOTSPOT_CELL), q1 = Math.floor((wy1 + reach + GRID / 2) / HOTSPOT_CELL);
  const mpp = milesPerPx();
  for (let q = q0; q <= q1; q++) {
    for (let p = p0; p <= p1; p++) {
      const h = H.hotspotIn(p, q);
      if (!h || h.maxX < wx0 || h.minX > wx1 || h.maxY < wy0 || h.minY > wy1) continue;
      if (full) {
        for (let k = h.volcanoes.length - 1; k >= 0; k--) {
          const v = h.volcanoes[k];
          const [sx, sy] = toScreen(v.x, v.y);
          ctx.fillStyle = `rgba(190,40,20,${0.15 + 0.7 * Math.min(1, v.h / h.height)})`;
          ctx.beginPath(); ctx.arc(sx, sy, Math.max(2, v.r / mpp), 0, Math.PI * 2); ctx.fill();
        }
      } else {
        ctx.strokeStyle = 'rgba(190,40,20,0.8)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        h.volcanoes.forEach((v, k) => { const [sx, sy] = toScreen(v.tx, v.ty); k ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); });
        ctx.stroke();
      }
      const [sx, sy] = toScreen(h.x, h.y);
      ctx.fillStyle = '#e8190c';
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(sx, sy, 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
  }
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
  ctx.font = '12px system-ui, sans-serif'; // set explicitly: overlays change the font
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
  hover.style.left = `${mouse.x + 14}px`;
  hover.style.top = `${mouse.y + 14}px`;
  hover.style.display = 'block';
  if (settings.view === 'plates') {
    const pl = field.plates.at(...squareOf(wx, wy)).plate;
    hover.textContent = `${pl.continental ? 'continental' : 'oceanic'} plate ${pl.id}`;
    readout.textContent = `${wx.toFixed(1)}, ${wy.toFixed(1)} mi · plate ${pl.id} (${pl.continental ? 'continental' : 'oceanic'})` + windText(wx, wy);
    return;
  }
  hover.textContent = `${here} m`;

  const fmt = (v) => (v >= 0 ? '+' : '−') + Math.abs(Math.round(v));
  const name = (sz) => (sz >= 1e9 ? sz / 1e9 + 'B' : sz >= 1e6 ? sz / 1e6 + 'M' : sz / 1e3 + 'K');
  const [si, sj] = squareOf(wx, wy);
  const bias = field.biases(si * GRID, sj * GRID).map((v, L) => `${name(biasSize(L))} ${fmt(v)}`).join(' · ');
  // Breakdown of the square under the cursor: inherited from the level above + own bias.
  const [fa, fb] = squareAt(D, wx, wy);
  readout.textContent = `${wx.toFixed(1)}, ${wy.toFixed(1)} mi · ${here} m = ` +
    (D === 0 ? '1,000-mi average' :
      `${Math.round(field.inherited(D, fa, fb))} inherited ${fmt(field.bias(D, fa, fb))} own bias` +
      (field.core(D, fa, fb) < 0 ? ` ${fmt(field.value(D, fa, fb) - field.hotspot(D, fa, fb) - field.core(D, fa, fb))} abyss` : '') +
      (field.hotspot(D, fa, fb) >= 0.5 ? ` ${fmt(field.hotspot(D, fa, fb))} hotspot volcano` : '') +
      ` (${LEVELS[D].size}-mi square)`) +
    `   (large-square biases: ${bias})` + windText(wx, wy);
}

/** " · lat 23° · wind from NE" for the readout. */
function windText(x, y) {
  const w = field.climate.weatherAt(x, y);
  return ` · lat ${Math.round(w.lat)}° · ${w.speed < 0.05 ? 'calm' : `wind from ${windFrom(w.u, w.v)}`}`;
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
  if (e.key === 'r' || e.key === 'R') { toggleSmooth(); return; }
  if (e.key === 'l' || e.key === 'L') { toggleLabels(); return; }
  if (e.key === 'p' || e.key === 'P') { togglePlates(); return; }
  if (e.key === 'v' || e.key === 'V') { toggleView(); return; }
  if (e.key === 'n' || e.key === 'N') { toggleWind(); return; }
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
      row(name, metres(field.value(0, x, y)), 'sep');
      const settle = field.value(0, x, y) - field.core(0, x, y);
      if (Math.abs(settle) >= 0.5) row('smoothed average', metres(field.core(0, x, y)), 'muted');
      if (Math.abs(settle) >= 0.5) row('abyss settling', signed(settle), 'muted');
      row('raw value', metres(field.raw(x, y)), 'muted');
    } else {
      // Inherited: the average of nearby parents' values (edge blending); for interior
      // squares that's just their own parent's value.
      const inh = field.inherited(l, x, y), parentV = field.core(l - 1, ...parentOf(l, x, y));
      const blended = Math.abs(inh - parentV) > 0.5;
      row(name, metres(field.value(l, x, y)), 'sep');
      row(blended ? 'inherited (edge-blended)' : 'inherited from parent', metres(inh), 'muted');
      row('own bias', signed(field.bias(l, x, y)), 'muted');
      const settle = field.value(l, x, y) - field.hotspot(l, x, y) - field.core(l, x, y);
      if (Math.abs(settle) >= 0.5) row('abyss settling', signed(settle), 'muted');
      const volcano = field.hotspot(l, x, y);
      if (volcano >= 0.5) row('hotspot volcano', signed(volcano), 'muted');
      row('raw value', metres(field.levelRaw(l, x, y)), 'muted');
    }
    row('smoothing', blend(l, x, y), 'muted');
  }

  // Tectonics of the 1,000-mile square: plate base is in its raw value; the boundary
  // effect is added to its average after smoothing.
  {
    const [ti, tj] = chain[0].slice(1);
    const t = field.plates.at(ti, tj);
    const compass = (ang) => ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'][Math.round(ang / (Math.PI / 4)) % 8];
    const kindOf = (pl) => (pl.continental ? 'continental' : 'oceanic');
    row(`Plate ${t.plate.id}`, `${kindOf(t.plate)}, moving ${compass(t.plate.angle)}`, 'sep');
    row('plate base', signed(t.base), 'muted');
    row(`nearest boundary (${t.kind})`, `${miles(Math.max(0, t.dist))} away`, 'muted');
    row(`with plate ${t.other.id}`, `${kindOf(t.other)}, moving ${compass(t.other.angle)}`, 'muted');
    row('boundary effect (after smoothing)', signed(t.boundary), 'muted');
  }

  // Climate at the square's centre (wind doesn't affect elevation yet).
  {
    const w = field.climate.weatherAt(cx, cy);
    const wind = (u, v, s) => (s < 0.05 ? 'calm' : `from the ${windFrom(u, v)}, strength ${s.toFixed(2)}`);
    row('Latitude', `${Math.round(w.lat)}° (pole to the ${w.poleUp ? 'north' : 'south'})`, 'sep');
    row('wind band', w.band, 'muted');
    row('wind (steered by terrain)', wind(w.u, w.v, w.speed), 'muted');
    row('large-scale wind', wind(w.base.u, w.base.v, w.base.speed), 'muted');
    row('uplift (air forced up slopes)', w.uplift.toFixed(2), 'muted');
    row('pressure', w.pressure > 0.3 ? 'high' : w.pressure < -0.3 ? 'low' : 'moderate', 'muted');
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
