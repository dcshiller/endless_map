// Viewer: pan/zoom over the elevation squares, from 100,000 miles across down to the point
// where 0.1-mile squares show. Hover shows elevation; clicking a square shows its details.

import { createElevation, GRID, LEVELS, TILE, squareAt, squareCentre, parentOf, biasSize, biasLevelsAt } from './elevation.js';
import { PLATE_CELL, boundaryKind } from './plates.js';
import { HOTSPOT_CELL, CHAIN_REACH } from './hotspots.js';
import { POLE_DISTANCE, CELL_SIZE, MAX_CELL_RADIUS } from './climate.js';
import { reliefStampsByKind, reliefKindFor, reliefColours, RELIEF_STYLE } from './mountains.js';
import { colour } from './colour.js';
import { RAIN_LEVEL, RAIN_RANGE } from './rain.js';
import { createRivers, SOURCE_LEVEL, FLOW_LEVEL, RIVER_CLASSES } from './rivers.js';
import { hash } from './random.js';

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
const mountainRadios = [...document.querySelectorAll('input[name="mountains"]')];
const riverRadios = [...document.querySelectorAll('input[name="rivers"]')];
const settings = { wideFraction: field.wideFraction, smooth: true, labels: false, plates: false, view: 'elevation', wind: false, mountains: true, rivers: true };

/** Apply changed settings; keep the view and any popup. */
function applySettings(changes) {
  const rebuild = 'wideFraction' in changes && changes.wideFraction !== field.wideFraction;
  Object.assign(settings, changes);
  if (rebuild) {
    // Only the model's own settings need a new field (and new colours for every square).
    field = createElevation(SEED, { wideFraction: settings.wideFraction });
    tileCache = new Map();
    stampTiles.clear();
    rainTiles.clear();
    riverTiles.clear();
    lakeSquares = new Set();
    riverLocal = null;
    workTiles = []; // old tiles; the next draw lists the new ones
    configureWorkers();
  }
  for (const r of renderRadios) r.checked = (r.value === 'smooth') === settings.smooth;
  for (const r of labelRadios) r.checked = (r.value === 'on') === settings.labels;
  for (const r of plateRadios) r.checked = (r.value === 'on') === settings.plates;
  for (const r of viewRadios) r.checked = r.value === settings.view;
  for (const r of windRadios) r.checked = (r.value === 'on') === settings.wind;
  for (const r of mountainRadios) r.checked = (r.value === 'on') === settings.mountains;
  for (const r of riverRadios) r.checked = (r.value === 'on') === settings.rivers;
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
for (const r of mountainRadios) r.addEventListener('change', () => applySettings({ mountains: r.value === 'on' }));
for (const r of riverRadios) r.addEventListener('change', () => applySettings({ rivers: r.value === 'on' }));

/** Move to the next option in a radio group (wrapping). */
const nextValue = (radios) => radios[(radios.findIndex((r) => r.checked) + 1) % radios.length].value;
const toggleWide = () => applySettings({ wideFraction: Number(nextValue(wideRadios)) });
const toggleSmooth = () => applySettings({ smooth: !settings.smooth });
const toggleLabels = () => applySettings({ labels: !settings.labels });
const togglePlates = () => applySettings({ plates: !settings.plates });
const toggleView = () => applySettings({ view: nextValue(viewRadios) });
const toggleWind = () => applySettings({ wind: !settings.wind });
const toggleMountains = () => applySettings({ mountains: !settings.mountains });
const toggleRivers = () => applySettings({ rivers: !settings.rivers });

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
// Elevation colours: see colour.js.
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
// stretched over the screen: with smooth blending (colours fade near square edges, see
// BLEND_STEPS) or without (flat blocks). Still one value per square, not per screen pixel.
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
// Smooth rendering blends colours over about 1/BLEND_STEPS of a square's width at its
// edges (1 = blend all the way between square centres; higher = sharper).
const BLEND_STEPS = 3;
const sharp = document.createElement('canvas');
const sharpCtx = sharp.getContext('2d');

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
  if (msg.type === 'rivers') {
    inFlight.delete('R:' + msg.ta + ',' + msg.tb);
    riverTiles.set(msg.ta + ',' + msg.tb, msg.rivers);
    riverLayoutStale = true;
    if (riverTiles.size > 4000) riverTiles.delete(riverTiles.keys().next().value);
    dirty = true;
    pump();
    return;
  }
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

/** Hand the view's missing tiles (then those the stamps need) to idle workers, nearest the centre first. */
function pump() {
  if (!workers.length) { scheduleWork(); return; }
  for (const t of [...workTiles, ...stampNeeds, ...rainNeeds, ...riverNeeds]) {
    if (!t.left || inFlight.has(t.key)) continue;
    let w = workers[0];
    for (const x of workers) if (x.busy < w.busy) w = x;
    if (w.busy >= IN_FLIGHT_PER_WORKER) return;
    w.busy++;
    inFlight.add(t.key);
    w.postMessage(t.rivers ? { type: 'rivers', ta: t.ta, tb: t.tb, gen } : { type: 'tile', L: t.D, ta: t.ta, tb: t.tb, gen });
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

  // Land a little greener where it's wet (see tintTile), once a tile's colours are final.
  if (D >= RAIN_LEVEL && settings.view === 'elevation') {
    for (const t of tiles) if (!t.left && !t.tinted) tintTile(t);
    if (rainNeeds.length) pump();
  }

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
  const dw = w * S / milesPerPx(), dh = h * S / milesPerPx();
  // Smooth mode: first enlarge to BLEND_STEPS pixels per square with flat blocks, then
  // stretch that with bilinear blending, so colours only fade across the outer part of
  // each square (about 1/BLEND_STEPS of its width) instead of all the way between centres.
  const k = smooth ? Math.min(BLEND_STEPS, Math.floor(S / milesPerPx())) : 1;
  let src = off;
  if (k > 1) {
    if (sharp.width !== w * k || sharp.height !== h * k) { sharp.width = w * k; sharp.height = h * k; }
    sharpCtx.imageSmoothingEnabled = false;
    sharpCtx.drawImage(off, 0, 0, w * k, h * k);
    src = sharp;
  }
  ctx.imageSmoothingEnabled = smooth;
  ctx.imageSmoothingQuality = 'low'; // plain bilinear: same look when enlarging, much cheaper
  ctx.drawImage(src, x0, y0, dw, dh);
}

// ---------- Mountain stamps ----------
// Relief stamps on ground that stands out from its surroundings, of the kind its shape
// calls for (prominence, a cliff on one side, a flat top) (see RELIEF_TERRAIN in mountains.js), at any altitude on land. They're fixed in
// the world: each 4-mile square (level STAMP_LEVEL) gets at most one, decided once from that
// square's terrain, with its own position and width in miles. Zooming just scales them. They're hidden when too small to read (zoomed far out)
// and fade out when huge (zoomed far in). Drawn back to front, filled with a lightened land
// colour so they sit on the map.
const STAMP_LEVEL = 4;                                        // the 4-mile squares
const STAMP_RING = 5;                                         // prominence ring: 5 squares (20 miles) out
const STAMP_MILES = { spire: 5, peak: 6, hill: 3.5, rise: 3, knoll: 2.5, scarpE: 6, scarpW: 6, mesa: 5 }; // widths
const STAMP_CHANCE = { spire: 1, peak: 1, hill: 0.9, rise: 0.6, knoll: 0.45, scarpE: 0.9, scarpW: 0.9, mesa: 0.9 };
const STAMP_SHORE = 1;        // no stamps at all with sea within this many squares (~5 miles)
const STAMP_COAST = 5;        // no spires or peaks with sea within this many squares (20 miles)
const STAMP_PAIR_CHANCE = 0.5; // share of stamped squares with two overlapping stamps
const STAMP_MIN_PX = 10;          // hide all stamps when a 5-mile stamp would be narrower than this
const STAMP_FADE_PX = [350, 700]; // a stamp fades out between these widths
let stampSet = null, stampSeed = null;
let stampNeeds = []; // stamp-level tiles to fetch from the workers (see pump)

/** Path2D versions of a stamp's layers (cached on the stamp). */
function stampPaths(st) {
  return st.p2d ||= st.peaks.map((p) => ({ fill: new Path2D(p.fill), shade: new Path2D(p.shade), hatch: new Path2D(p.hatch), ink: new Path2D(p.ink) }));
}

function drawMountains() {
  stampNeeds = [];
  const pxPerMile = 1 / milesPerPx();
  if (5 * pxPerMile < STAMP_MIN_PX) return;
  if (stampSeed !== field.seed) { stampSet = reliefStampsByKind(field.seed); stampSeed = field.seed; stampTiles.clear(); }
  const L = STAMP_LEVEL;
  // Margin: stamps whose square is just off screen still overhang onto it.
  const m = 10; // miles
  const [wx0, wy0] = toWorld(0, 0), [wx1, wy1] = toWorld(cssW, cssH);
  const [a0, b0] = squareAt(L, wx0 - m, wy0 - m), [a1, b1] = squareAt(L, wx1 + m, wy1 + m);
  const list = [];
  for (let tb = Math.floor(b0 / TILE); tb <= Math.floor(b1 / TILE); tb++) {
    for (let ta = Math.floor(a0 / TILE); ta <= Math.floor(a1 / TILE); ta++) {
      for (const c of stampsInTile(ta, tb)) {
        if (settings.rivers && onLake(c)) continue; // no stamps on lakes
        const size = c.miles * pxPerMile;
        if (size > STAMP_FADE_PX[1]) continue;
        const [sx, sy] = toScreen(c.x, c.y);
        list.push({ c, sx, sy, size });
      }
    }
  }
  if (stampNeeds.length) pump();
  list.sort((p, q) => p.c.y - q.c.y); // back to front
  for (const { c, sx, sy, size } of list) {
    ctx.globalAlpha = Math.min(1, Math.max(0, (STAMP_FADE_PX[1] - size) / (STAMP_FADE_PX[1] - STAMP_FADE_PX[0])));
    if (size <= 200) {
      // Pre-rendered bitmap at the nearest of a series of sizes (8% apart), scaled to fit.
      const bucket = Math.round(Math.log(size) / Math.log(1.08));
      const sp = stampSprite(c.st, bucket, c.shade);
      const k = size / sp.size;
      ctx.drawImage(sp.canvas, sx - sp.ax * k, sy - sp.ay * k, sp.w * k, sp.h * k);
    } else {
      // Big (few on screen): rendered fresh each frame into one reusable canvas.
      const sp = renderStamp(c.st, size, c.shade, bigStampCanvas);
      ctx.drawImage(sp.canvas, 0, 0, sp.canvas.width, sp.canvas.height, sx - sp.ax, sy - sp.ay, sp.w, sp.h);
    }
  }
  ctx.globalAlpha = 1;
}

/** Is stamp c's square, or the square under its base, part of a lake? */
function onLake(c) {
  if (!lakeSquares.size) return false;
  if (lakeSquares.has(c.a + ',' + c.b)) return true;
  const [i, j] = squareAt(STAMP_LEVEL, c.x, c.y);
  return lakeSquares.has(i + ',' + j);
}

// Stamp candidates per tile of stamp-level squares, decided once (when the tile and its
// neighbours' values are known): { st, x, y (world miles, the stamp's base), miles (width),
// shade }. Missing tiles are fetched from the workers.
const stampTiles = new Map();

/** Is any stamp-level square within n squares of (a, b) below sea level? */
function seaWithin(a, b, n) {
  for (let db = -n; db <= n; db++) for (let da = -n; da <= n; da++) {
    if (field.value(STAMP_LEVEL, a + da, b + db) < 0) return true;
  }
  return false;
}

function stampsInTile(ta, tb) {
  const L = STAMP_LEVEL, key = ta + ',' + tb;
  let t = stampTiles.get(key);
  if (t && t.complete) return t.list;
  // The tile and its neighbours (for edge squares' neighbours) must be computed.
  let ready = true;
  for (let db = -1; db <= 1; db++) for (let da = -1; da <= 1; da++) {
    if (field.hasTile(L, ta + da, tb + db)) continue;
    ready = false;
    if (workers.length) stampNeeds.push({ D: L, ta: ta + da, tb: tb + db, key: L + ':' + (ta + da) + ',' + (tb + db), left: 1 });
    else field.tile(L, ta + da, tb + db); // no workers: compute here
  }
  if (!ready && workers.length) return [];
  const seed = field.seed, S = LEVELS[L].size, R = STAMP_RING;
  const list = [];
  for (let j = 0; j < TILE; j++) {
    for (let i = 0; i < TILE; i++) {
      const a = ta * TILE + i, b = tb * TILE + j;
      const e = field.value(L, a, b);
      if (e < 0 || seaWithin(a, b, STAMP_SHORE)) continue; // land only, nothing right by the coast
      // The ground's shape around the square (see RELIEF_TERRAIN): the ring of squares R
      // out (all of it, and its west and east sides) and the 8 squares around.
      let sum = 0, west = 0, east = 0, near = 0;
      for (let d = -R; d < R; d++) {
        sum += field.value(L, a + d, b - R) + field.value(L, a + R, b + d)
          + field.value(L, a - d, b + R) + field.value(L, a - R, b - d);
      }
      for (let d = -R; d <= R; d++) { west += field.value(L, a - R, b + d); east += field.value(L, a + R, b + d); }
      for (let db = -1; db <= 1; db++) for (let da = -1; da <= 1; da++) if (da || db) near += field.value(L, a + da, b + db);
      const kind = reliefKindFor({
        e, p: e - sum / (8 * R), dropW: e - west / (2 * R + 1), dropE: e - east / (2 * R + 1), inner: e - near / 8,
      });
      if (!kind || hash(seed, a, b, 961) >= STAMP_CHANCE[kind]) continue;
      if ((kind === 'spire' || kind === 'peak') && seaWithin(a, b, STAMP_COAST)) continue; // no mountains near coasts
      const pool = stampSet[kind];
      const [cx, cy] = squareCentre(L, a, b);
      const shade = Math.max(0, Math.min(STAMP_SHADES - 1, Math.round(e / STAMP_SHADE_M)));
      // STAMP_PAIR_CHANCE of stamped squares get a second stamp of the same kind (another
      // variant, its own position and width), overlapping the first.
      const n = hash(seed, a, b, 966) < STAMP_PAIR_CHANCE ? 2 : 1;
      const v0 = Math.floor(hash(seed, a, b, 962) * pool.length);
      for (let k = 0; k < n; k++) {
        const ch = 10 * k; // separate hash channels for the second stamp
        list.push({
          a, b,
          st: pool[(v0 + k * (1 + Math.floor(hash(seed, a, b, 967) * (pool.length - 1)))) % pool.length],
          x: cx + (hash(seed, a, b, 963 + ch) - 0.5) * 0.6 * S,
          y: cy + (hash(seed, a, b, 964 + ch) - 0.5) * 0.6 * S + 0.2 * S,
          miles: STAMP_MILES[kind] * (0.85 + 0.3 * hash(seed, a, b, 965 + ch)),
          shade,
        });
      }
    }
  }
  stampTiles.set(key, { list, complete: true });
  if (stampTiles.size > 4000) stampTiles.delete(stampTiles.keys().next().value);
  return list;
}

// Stamps blend into the terrain under them (see reliefColours and RELIEF_STYLE in
// mountains.js). Fill colours are matched to the nearest STAMP_SHADE_M of elevation.
const STAMP_SHADE_M = 100;
const STAMP_SHADES = 61; // 0 .. 6,000 m

/** Paint stamp st, width size px, anchored at its base centre = current origin. */
function paintStamp(c, st, size, shade) {
  const sc = size / 100;
  const col = reliefColours(shade * STAMP_SHADE_M);
  c.save();
  c.scale(sc, sc);
  c.translate(-50, -100);
  c.lineJoin = 'round';
  c.lineCap = 'round';
  const ink = Math.max(1, Math.min(4, size * 0.025)); // px: thicker for bigger stamps
  for (const p of stampPaths(st)) {
    // Each peak is painted opaque first (so nearer peaks hide farther ones), then its lines.
    c.fillStyle = col.fill; c.fill(p.fill);
    c.fillStyle = col.shade; c.fill(p.shade);
    c.strokeStyle = col.ink;
    c.lineWidth = (ink * 0.55) / sc; c.stroke(p.hatch);
    c.lineWidth = ink / sc; c.stroke(p.ink);
  }
  c.restore();
}

/**
 * Render stamp st at width size (css px) into a canvas (a new one, or reuse), with its
 * base faded out. Returns { canvas, size, w, h, ax, ay } (w, h, anchor ax, ay in css px).
 */
function renderStamp(st, size, shade, reuse) {
  const sc = size / 100;
  // Box: x -8..108, y from the stamp's top - 4 to 104 (stamp units).
  const top = Math.floor(st.top) - 4;
  const w = Math.ceil(116 * sc), h = Math.ceil((104 - top) * sc);
  const canvas = reuse || document.createElement('canvas');
  const cw = Math.ceil(w * dpr), ch = Math.ceil(h * dpr);
  if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
  const c = canvas.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.globalCompositeOperation = 'source-over';
  c.clearRect(0, 0, w, h);
  const ax = 58 * sc, ay = (100 - top) * sc;
  c.save();
  c.translate(ax, ay);
  paintStamp(c, st, size, shade);
  c.restore();
  // Fade the base: erase more and more toward the ground line (and the ticks just below).
  const fadeTop = ay - RELIEF_STYLE.baseFade * (100 - st.top) * sc;
  const g = c.createLinearGradient(0, fadeTop, 0, ay);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.9)');
  c.globalCompositeOperation = 'destination-out';
  c.fillStyle = g;
  c.fillRect(0, fadeTop, w, ay - fadeTop);
  c.fillStyle = 'rgba(0,0,0,0.9)';
  c.fillRect(0, ay, w, h - ay);
  c.globalCompositeOperation = 'source-over';
  return { canvas, size, w, h, ax, ay };
}

// Small stamps are pre-rendered into bitmaps (sprites) per stamp, size bucket and fill
// shade, so a frame mostly just copies bitmaps.
const spriteCache = new Map();
const bigStampCanvas = document.createElement('canvas');

function stampSprite(st, bucket, shade) {
  const key = st.id + ':' + bucket + ':' + shade + ':' + dpr;
  let sp = spriteCache.get(key);
  if (sp) return sp;
  sp = renderStamp(st, 1.08 ** bucket, shade);
  spriteCache.set(key, sp);
  if (spriteCache.size > 6000) spriteCache.delete(spriteCache.keys().next().value);
  return sp;
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

  rainNeeds = [];
  riverNeeds = [];
  rainDeadline = performance.now() + RAIN_SLICE_MS;
  if (settings.view === 'plates') {
    // Plates view: continents and hotspots only, no elevation.
    pendingSquares = 0;
    drawPlatesView(wx0, wy0, wx1, wy1);
  } else if (settings.view === 'rain' && view.width <= RAIN_MAX_VIEW) {
    // Rainfall view: yearly rain per 100-mile square.
    drawRainView(wx0, wy0, wx1, wy1);
    if (settings.rivers) drawRivers(wx0, wy0, wx1, wy1);
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

    // Rivers, then mountain stamps on high ground (over them).
    if (settings.rivers) drawRivers(wx0, wy0, wx1, wy1);
    if (settings.mountains) drawMountains();

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

// ---------- Rainfall view ----------
// Yearly rainfall (rain.js) per 100-mile square, from dry tan through greens to blue; sea in
// plain dark blue. A tile of squares is worked out once the elevation tiles its wind traces
// can reach (those within RAIN_RANGE of it) are computed; missing ones are fetched from the
// workers. Zoomed out beyond
// RAIN_MAX_VIEW the elevation view is shown instead (too many squares).
const RAIN_MAX_VIEW = 20000; // miles across the screen
const RAIN_STOPS = [
  [0, [222, 204, 160]],
  [150, [214, 196, 120]],
  [400, [178, 188, 98]],
  [800, [112, 164, 82]],
  [1500, [52, 128, 74]],
  [2500, [26, 96, 96]],
  [4000, [24, 64, 120]],
];
const RAIN_SEA = [58, 78, 104];
const rainTiles = new Map(); // "ta,tb" -> { canvas, mm }
let rainDeadline = 0;        // working out rain tiles stops for the frame after this time
const RAIN_SLICE_MS = 8;
let rainNeeds = [];          // elevation tiles the rain view is waiting for (see pump)

function rainColour(mm) {
  if (mm <= RAIN_STOPS[0][0]) return RAIN_STOPS[0][1];
  for (let k = 0; k < RAIN_STOPS.length - 1; k++) {
    const [m0, c0] = RAIN_STOPS[k], [m1, c1] = RAIN_STOPS[k + 1];
    if (mm <= m1) {
      const t = (mm - m0) / (m1 - m0);
      return c0.map((v, i) => v + (c1[i] - v) * t);
    }
  }
  return RAIN_STOPS[RAIN_STOPS.length - 1][1];
}

/** Rain tile (ta, tb) of the rain squares, or null while elevation tiles are pending. */
function rainTile(ta, tb) {
  const key = ta + ',' + tb;
  let t = rainTiles.get(key);
  if (t) return t;
  const L = RAIN_LEVEL;
  const n = Math.ceil(RAIN_RANGE / (TILE * LEVELS[L].size)); // tiles a trace can reach, each way
  let ready = true;
  for (let db = -n; db <= n; db++) for (let da = -n; da <= n; da++) {
    if (field.hasTile(L, ta + da, tb + db)) continue;
    ready = false;
    if (workers.length) rainNeeds.push({ D: L, ta: ta + da, tb: tb + db, key: L + ':' + (ta + da) + ',' + (tb + db), left: 1 });
    else field.tile(L, ta + da, tb + db); // no workers: compute here
  }
  if (!ready && workers.length) return null;
  if (performance.now() > rainDeadline) { dirty = true; return null; } // enough for this frame
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = TILE;
  const c = canvas.getContext('2d');
  const img = c.createImageData(TILE, TILE);
  const mm = new Float32Array(TILE * TILE);
  for (let j = 0; j < TILE; j++) {
    for (let i = 0; i < TILE; i++) {
      const a = ta * TILE + i, b = tb * TILE + j, q = j * TILE + i;
      const sea = field.value(L, a, b) < 0;
      mm[q] = field.rain.rainAt(...squareCentre(L, a, b)).mm;
      const col = sea ? RAIN_SEA : rainColour(mm[q]);
      img.data[q * 4] = col[0]; img.data[q * 4 + 1] = col[1]; img.data[q * 4 + 2] = col[2]; img.data[q * 4 + 3] = 255;
    }
  }
  c.putImageData(img, 0, 0);
  t = { canvas, mm };
  rainTiles.set(key, t);
  if (rainTiles.size > 2000) rainTiles.delete(rainTiles.keys().next().value);
  return t;
}

function drawRainView(wx0, wy0, wx1, wy1) {
  const L = RAIN_LEVEL, S = LEVELS[L].size, span = TILE * S;
  pendingSquares = 0;
  ctx.fillStyle = '#9a9a9a';
  ctx.fillRect(0, 0, cssW, cssH);
  const [a0, b0] = squareAt(L, wx0, wy0), [a1, b1] = squareAt(L, wx1, wy1);
  ctx.imageSmoothingEnabled = false;
  // Nearest the centre first, so the middle fills in first.
  const ca = (a0 + a1) / 2 / TILE, cb = (b0 + b1) / 2 / TILE;
  const list = [];
  for (let tb = Math.floor(b0 / TILE); tb <= Math.floor(b1 / TILE); tb++) {
    for (let ta = Math.floor(a0 / TILE); ta <= Math.floor(a1 / TILE); ta++) list.push([ta, tb, (ta + 0.5 - ca) ** 2 + (tb + 0.5 - cb) ** 2]);
  }
  list.sort((p, q) => p[2] - q[2]);
  for (const [ta, tb] of list) {
    const t = rainTile(ta, tb);
    if (!t) { pendingSquares += TILE * TILE; continue; }
    // Square a covers [a·S − GRID/2, (a+1)·S − GRID/2) (see squareAt).
    const [x0, y0] = toScreen(ta * span - GRID / 2, tb * span - GRID / 2);
    const [x1, y1] = toScreen((ta + 1) * span - GRID / 2, (tb + 1) * span - GRID / 2);
    ctx.drawImage(t.canvas, x0, y0, x1 - x0, y1 - y0);
  }
  if (rainNeeds.length) pump();
}

/** Rainfall (mm a year) of the rain square at (x, y), if its tile is worked out. */
function rainHere(x, y) {
  const L = RAIN_LEVEL;
  const [a, b] = squareAt(L, x, y);
  const t = rainTiles.get(Math.floor(a / TILE) + ',' + Math.floor(b / TILE));
  if (!t) return null;
  return t.mm[(b - Math.floor(b / TILE) * TILE) * TILE + (a - Math.floor(a / TILE) * TILE)];
}

// ---------- Moisture tint ----------
// In the elevation view, land is blended toward MOIST_GREEN by its yearly rainfall: up to
// MOIST_MAX of the way at MOIST_FULL mm and more, less in proportion below. Rain is per
// 100-mile square, so each square's is blended (bilinear) between the 4 rain-square
// centres around it, to avoid blocks. Applied to the 100-mile squares and finer, once a
// tile's colours are final and the rain around it is worked out (coarser squares, shown
// zoomed far out, stay untinted).
const MOIST_GREEN = [84, 132, 64];
const MOIST_MAX = 0.5;
const MOIST_FULL = 1500; // mm a year

/** Rain (mm a year) of rain square (a, b), or null if its tile isn't worked out. */
function rainOfSquare(a, b) {
  const ta = Math.floor(a / TILE), tb = Math.floor(b / TILE);
  const t = rainTile(ta, tb); // works it out, or asks for the elevation it needs
  return t ? t.mm[(b - tb * TILE) * TILE + (a - ta * TILE)] : null;
}

/** Tint tile t's land by rainfall. Returns false (to try again later) if rain isn't ready. */
function tintTile(t) {
  const S = LEVELS[t.D].size, R = LEVELS[RAIN_LEVEL].size;
  // Rain squares around the tile: their centres bracket every square centre in it.
  const fx0 = (t.ta * TILE * S) / R - 0.5, fy0 = (t.tb * TILE * S) / R - 0.5;
  const ra0 = Math.floor(fx0), rb0 = Math.floor(fy0);
  const n = Math.ceil((TILE * S) / R) + 2;
  const mm = new Float64Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const v = rainOfSquare(ra0 + i, rb0 + j);
      if (v === null) return false;
      mm[j * n + i] = v;
    }
  }
  if (!field.hasTile(t.D, t.ta, t.tb)) return false;
  const values = field.tile(t.D, t.ta, t.tb).value;
  for (let q = 0; q < TILE * TILE; q++) {
    const v = values[q];
    if (v < 0) continue; // sea
    // Square centre in rain-square units (rain square a's centre is at a + 0.5).
    const fx = ((t.ta * TILE + (q % TILE) + 0.5) * S) / R - 0.5 - ra0;
    const fy = ((t.tb * TILE + Math.floor(q / TILE) + 0.5) * S) / R - 0.5 - rb0;
    const i = Math.floor(fx), j = Math.floor(fy), u = fx - i, w = fy - j;
    const m = (1 - w) * ((1 - u) * mm[j * n + i] + u * mm[j * n + i + 1]) + w * ((1 - u) * mm[(j + 1) * n + i] + u * mm[(j + 1) * n + i + 1]);
    const k = MOIST_MAX * Math.min(1, m / MOIST_FULL);
    const p = q * 4, c = lutIndex(v);
    for (let ch = 0; ch < 3; ch++) t.rgba[p + ch] = LUT[c + ch] + (MOIST_GREEN[ch] - LUT[c + ch]) * k;
  }
  t.tinted = true;
  return true;
}

// ---------- Rivers ----------
// Blue lines (rivers.js): from a random start in some land 100-mile squares, downhill over
// the 4-mile squares to the sea or a hollow, where a lake (filled 4-mile squares) forms.
// Traced by the workers a tile of source squares at a time (they compute the 4-mile
// elevations they need), all classes at once; drawing shows only the classes for the
// current zoom: great rivers from far out, streams only close in (RIVER_CLASS_VIEW).
// Widest view (miles across the screen) at which each size class (RIVER_CLASSES) shows.
const RIVER_CLASS_VIEW = [500, 1500, 4000, 10000];
const RIVER_SOURCE = [92, 156, 224];  // colour at the source (little water)...
const RIVER_MOUTH = [28, 74, 160];    // ...deepening to this with RIVER_BANDS of flow
const RIVER_BANDS = 8;                // width/colour steps: band = log2(1 + flow)
const RIVER_TINTS = [[0, 0, 0], [-12, 10, -8], [8, -6, 10]]; // per-river: plain, greener, bluer-violet
const RIVER_EDGE = 'rgba(240, 246, 250, 0.35)';
const RIVER_FADE = 3;                 // pieces (4-mile steps) over which a river fades into the sea
const LAKE_COLOUR = 'rgb(48, 98, 180)';
const riverTiles = new Map(); // "ta,tb" -> [river, ...] (all classes)
let riverNeeds = [];          // source tiles waiting for the workers (see pump)
let riverLocal = null;        // main-thread tracer, only when there are no workers
let lakeSquares = new Set();  // "i,j" of every 4-mile lake square drawn (no stamps there)
let riverLayoutStale = false; // rivers arrived since the layout was worked out

/**
 * Where each river stops: rivers end where they meet another river or lake. Laid out
 * biggest class first, then longest (ties by start point), each river runs until it enters a 4-mile square an
 * earlier river or lake has taken, and ends there (the junction); if a lake it reaches
 * would overlap one already taken, it ends before that lake. Sets r.keep (points to draw)
 * and r.keepLakes on each river, and lakeSquares. Redone whenever more rivers arrive.
 */
function layOutRivers() {
  riverLayoutStale = false;
  const all = [];
  for (const list of riverTiles.values()) for (const r of list) all.push(r);
  // Bigger classes first (so hidden smaller rivers never cut a shown one short), then longest.
  all.sort((p, q) => q.cls - p.cls || q.points.length - p.points.length || p.points[0][0] - q.points[0][0] || p.points[0][1] - q.points[0][1]);
  const taken = new Set();
  lakeSquares = new Set();
  for (const r of all) {
    const mine = [];
    let keep = r.points.length, keepLakes = 0, li = 0;
    for (let k = 1; k < r.points.length; k++) {
      const [i, j] = squareAt(FLOW_LEVEL, ...r.points[k]);
      const key = i + ',' + j;
      if (taken.has(key)) { keep = k + 1; break; } // joins another river or lake here
      mine.push(key);
      // Lakes the river reaches at this point.
      let blocked = false;
      for (; li < r.lakes.length && r.lakes[li].at === k; li++) {
        const sq = r.lakes[li].squares.map(([a, b]) => a + ',' + b);
        if (sq.some((s) => taken.has(s))) { blocked = true; break; } // runs into another lake
        mine.push(...sq);
        keepLakes = li + 1;
      }
      if (blocked) { keep = k + 1; break; }
    }
    r.keep = keep;
    r.keepLakes = keepLakes;
    for (const key of mine) taken.add(key);
    for (let k = 0; k < keepLakes; k++) for (const [a, b] of r.lakes[k].squares) lakeSquares.add(a + ',' + b);
  }
}

function drawRivers(wx0, wy0, wx1, wy1) {
  riverNeeds = [];
  // The smallest class shown at this zoom.
  const minClass = RIVER_CLASS_VIEW.findIndex((w) => view.width <= w);
  if (minClass < 0) return;
  const L = SOURCE_LEVEL;
  // One tile of margin: rivers starting just off screen can run onto it.
  const [a0, b0] = squareAt(L, wx0, wy0), [a1, b1] = squareAt(L, wx1, wy1);
  const ta0 = Math.floor(a0 / TILE) - 1, ta1 = Math.floor(a1 / TILE) + 1;
  const tb0 = Math.floor(b0 / TILE) - 1, tb1 = Math.floor(b1 / TILE) + 1;
  if (riverLayoutStale) layOutRivers();
  const lakes = [], shown = [];
  for (let tb = tb0; tb <= tb1; tb++) {
    for (let ta = ta0; ta <= ta1; ta++) {
      let list = riverTiles.get(ta + ',' + tb);
      if (!list) {
        if (workers.length) {
          riverNeeds.push({ rivers: true, ta, tb, key: 'R:' + ta + ',' + tb, left: 1 });
          continue;
        }
        riverLocal ||= createRivers(field);
        list = [];
        for (let j = 0; j < TILE; j++) for (let i = 0; i < TILE; i++) {
          const r = riverLocal.riverFrom(ta * TILE + i, tb * TILE + j);
          if (r) list.push(r);
        }
        riverTiles.set(ta + ',' + tb, list);
        riverLayoutStale = true;
        dirty = true; // drawn once laid out, next frame
      }
      for (const r of list) {
        if (r.keep === undefined || r.cls < minClass) continue; // not laid out yet, or too small for this zoom
        shown.push(r);
        for (let k = 0; k < r.keepLakes; k++) lakes.push(r.lakes[k].squares);
      }
    }
  }
  strokeRivers(shown);
  // Lakes: their 4-mile squares as one shape (no seams between squares), filled over the
  // rivers, and outlined in the same colour with round joins so the corners are softened.
  const S = LEVELS[FLOW_LEVEL].size;
  const lakePath = new Path2D();
  for (const lake of lakes) {
    for (const [i, j] of lake) {
      const [x0, y0] = toScreen(i * S - GRID / 2, j * S - GRID / 2);
      const [x1, y1] = toScreen((i + 1) * S - GRID / 2, (j + 1) * S - GRID / 2);
      lakePath.rect(x0, y0, x1 - x0, y1 - y0);
    }
  }
  ctx.fillStyle = ctx.strokeStyle = LAKE_COLOUR;
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(1, 0.35 * S / milesPerPx());
  ctx.fill(lakePath);
  ctx.stroke(lakePath);
  if (riverNeeds.length) pump();
}

/**
 * Rivers as smooth curves (through the midpoints between square centres), widening and
 * deepening in colour downstream with the water gathered (flow), each river slightly
 * tinted its own way, over a faint pale edge. Pieces are grouped by width and colour into
 * one path per group, so a frame strokes a few dozen paths however many rivers there are.
 */
function strokeRivers(rivers) {
  // Zoom: 4-mile squares under ~12 px get thinner lines, bigger ones thicker.
  const zoom = Math.max(0.55, Math.min(1.8, (LEVELS[FLOW_LEVEL].size / milesPerPx()) / 12));
  const groups = new Map(); // "tint:band" -> Path2D
  const bandOf = (flow, cls) => Math.max(2 * cls, Math.min(RIVER_BANDS - 1, Math.floor(Math.log2(1 + flow))));
  for (const r of rivers) {
    const n = r.keep;
    if (n < 2) continue;
    const tint = Math.floor(hash(field.seed, Math.round(r.points[0][0]), Math.round(r.points[0][1]), 1300) * RIVER_TINTS.length);
    const P = [];
    for (let k = 0; k < n; k++) P.push(toScreen(...r.points[k]));
    const mid = (k) => [(P[k][0] + P[k + 1][0]) / 2, (P[k][1] + P[k + 1][1]) / 2];
    // Rivers reaching the sea (not cut short at a junction) fade out over their last
    // RIVER_FADE pieces, widening slightly like an estuary.
    const toSea = r.end === 'sea' && n === r.points.length;
    // Piece k: from the midpoint before point k, curving through it, to the midpoint after.
    for (let k = 0; k < n; k++) {
      const fade = toSea ? Math.max(0, k - (n - 1 - RIVER_FADE)) : 0; // 0 = none .. RIVER_FADE
      const key = tint + ':' + Math.min(RIVER_BANDS - 1, bandOf(r.flow[Math.min(k, r.flow.length - 1)], r.cls)) + ':' + fade;
      let path = groups.get(key);
      if (!path) groups.set(key, (path = new Path2D()));
      const from = k === 0 ? P[0] : mid(k - 1);
      const to = k === n - 1 ? P[n - 1] : mid(k);
      path.moveTo(from[0], from[1]);
      path.quadraticCurveTo(P[k][0], P[k][1], to[0], to[1]);
    }
  }
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const entries = [...groups].map(([key, path]) => {
    const [tint, band, fade] = key.split(':').map(Number);
    const f = fade / (RIVER_FADE + 1); // 0 .. under 1
    return { tint, band, path, alpha: 1 - f, width: (0.8 + 0.45 * band) * zoom * (1 + 0.6 * f) };
  }).sort((p, q) => p.band - q.band);
  // Pale edge first, then the water.
  ctx.strokeStyle = RIVER_EDGE;
  for (const e of entries) { ctx.globalAlpha = e.alpha; ctx.lineWidth = e.width + 1.6; ctx.stroke(e.path); }
  for (const e of entries) {
    const t = e.band / (RIVER_BANDS - 1);
    const c = RIVER_SOURCE.map((v, i) => v + (RIVER_MOUTH[i] - v) * t + RIVER_TINTS[e.tint][i]);
    ctx.strokeStyle = `rgb(${c.map((v) => Math.round(v)).join(',')})`;
    ctx.globalAlpha = e.alpha;
    ctx.lineWidth = e.width;
    ctx.stroke(e.path);
  }
  ctx.globalAlpha = 1;
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
  if (settings.view === 'rain' && view.width <= RAIN_MAX_VIEW) {
    const mm = rainHere(wx, wy);
    if (mm === null) { hover.textContent = 'rain: working…'; readout.textContent = ''; return; }
    const [ra, rb] = squareAt(RAIN_LEVEL, wx, wy);
    const r = field.rain.rainAt(...squareCentre(RAIN_LEVEL, ra, rb));
    const sea = field.value(RAIN_LEVEL, ra, rb) < 0;
    hover.textContent = `${Math.round(mm).toLocaleString()} mm/yr${sea ? ' (sea)' : ''}`;
    readout.textContent = `${wx.toFixed(1)}, ${wy.toFixed(1)} mi · rain ${Math.round(mm).toLocaleString()} mm/yr` +
      ` · moisture arriving ${(r.moisture * 100).toFixed(0)}%` +
      ` · climb ${r.climb >= 0 ? '+' : '−'}${Math.abs(Math.round(r.climb))} m` +
      ` · traced ${r.steps * 100} mi upwind (100-mi square)` + windText(wx, wy);
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
  if (e.key === 'm' || e.key === 'M') { toggleMountains(); return; }
  if (e.key === 'i' || e.key === 'I') { toggleRivers(); return; }
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
