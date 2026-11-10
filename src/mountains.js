// Mountain stamps: hand-drawn-style map symbols, generated deterministically from a seed so
// there's plenty of variety without hand-drawing files.
//
// Each stamp is drawn in a 100-wide box with its ground line at y = 100 (SVG coordinates,
// y down); anchor it by its bottom centre (50, 100). A stamp is one or more peaks, painted
// back to front, each as:
//   fill   silhouette (solid, so nearer stamps hide farther ones in a chain)
//   shade  the shadowed right-hand face (light comes from the upper left)
//   hatch  thin strokes across the shadowed face
//   ink    outline, ridge line, snow line and ground ticks
// All four are SVG path strings, usable as <path d> or with Path2D on a canvas.
//
// Kinds: peak, crag (tall and jagged), broad, twin, range (three peaks), hill, foothills.

import { hash } from './random.js';
import { colour } from './colour.js';

export const STAMP_STYLE = {
  fill: '#efe4c8',
  shade: 'rgba(110, 78, 44, 0.28)',
  ink: '#4a3420',
  inkWidth: 1.6,   // in stamp units (box is 100 wide)
  hatchWidth: 0.9,
};

const B = 100; // ground line

/** Small deterministic generator for one stamp. */
function rng(seed, n) {
  let s = Math.floor(hash(seed, n, 0, 900) * 4294967296) >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const lerp = (a, b, t) => a + (b - a) * t;

/** Line from a to b, roughened by midpoint displacement (rough = share of segment length). */
function roughLine(r, a, b, rough, depth = 3) {
  let pts = [a, b];
  for (let d = 0; d < depth; d++) {
    const next = [pts[0]];
    for (let k = 1; k < pts.length; k++) {
      const [x0, y0] = pts[k - 1], [x1, y1] = pts[k];
      const len = Math.hypot(x1 - x0, y1 - y0);
      const off = (r() - 0.5) * 2 * rough * len;
      // Perpendicular offset of the midpoint.
      next.push([(x0 + x1) / 2 - ((y1 - y0) / len) * off, (y0 + y1) / 2 + ((x1 - x0) / len) * off], pts[k]);
    }
    pts = next;
    rough *= 0.6;
  }
  return pts;
}

/** Point at fraction t of a polyline's length. */
function along(pts, t) {
  let total = 0;
  for (let k = 1; k < pts.length; k++) total += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
  let want = t * total;
  for (let k = 1; k < pts.length; k++) {
    const seg = Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
    if (want <= seg || k === pts.length - 1) {
      const u = seg ? Math.min(1, want / seg) : 0;
      return [lerp(pts[k - 1][0], pts[k][0], u), lerp(pts[k - 1][1], pts[k][1], u)];
    }
    want -= seg;
  }
  return pts[pts.length - 1];
}

const f = (v) => Math.round(v * 10) / 10;

/** SVG path data for a polyline; smooth = Catmull-Rom curves through the points. */
function pathOf(pts, { close = false, smooth = false } = {}) {
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  if (!smooth || pts.length < 3) {
    for (let k = 1; k < pts.length; k++) d += `L${f(pts[k][0])} ${f(pts[k][1])}`;
  } else {
    for (let k = 0; k < pts.length - 1; k++) {
      const p0 = pts[Math.max(0, k - 1)], p1 = pts[k], p2 = pts[k + 1], p3 = pts[Math.min(pts.length - 1, k + 2)];
      const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
      const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
      d += `C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(p2[0])} ${f(p2[1])}`;
    }
  }
  return close ? d + 'Z' : d;
}

/**
 * One peak: base from x0 to x1 on the ground line, summit at (px, py).
 * opts: rough (flank craggedness), smooth (rounded hill), snow, hatches, ticks.
 */
function makePeak(r, x0, x1, px, py, { rough = 0.15, smooth = false, snow = false, hatches = 6, ticks = true } = {}) {
  const depth = smooth ? 2 : 3;
  // Flanks bulge slightly outward (convex shoulders) before the roughening.
  // at = where along a→b the shoulder sits (lower down = broad base, steeper summit).
  const shoulder = (a, b, bulge, at) => {
    const m = [lerp(a[0], b[0], at), lerp(a[1], b[1], at)];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    // Outward (away from the mountain's middle): perpendicular on the left of a→b travel.
    return [m[0] + ((b[1] - a[1]) / len) * bulge * len, m[1] - ((b[0] - a[0]) / len) * bulge * len];
  };
  const L0 = [x0, B], P = [px, py], R0 = [x1, B];
  const lm = shoulder(L0, P, smooth ? 0.16 : lerp(0.02, 0.08, r()), smooth ? 0.5 : 0.35);
  const rm = shoulder(P, R0, smooth ? 0.16 : lerp(0.02, 0.08, r()), smooth ? 0.5 : 0.65);
  const left = [...roughLine(r, L0, lm, rough, depth - 1), ...roughLine(r, lm, P, rough, depth - 1).slice(1)];
  const right = [...roughLine(r, P, rm, rough, depth - 1), ...roughLine(r, rm, R0, rough, depth - 1).slice(1)];
  const outline = [...left, ...right.slice(1)];

  // Ridge: from the summit down to a foot right of it, splitting lit and shaded faces.
  const foot = [lerp(px, x1, lerp(0.15, 0.45, r())), B];
  const ridgeMid = [lerp(px, foot[0], 0.5) + (r() - 0.5) * 6, lerp(py, B, 0.5)];
  const ridge = smooth
    ? [P, [lerp(px, foot[0], 0.6), lerp(py, B, 0.55)]] // hills: a short shadow curve only
    : [...roughLine(r, P, ridgeMid, rough * 0.8, 2), ...roughLine(r, ridgeMid, foot, rough * 0.8, 2).slice(1)];
  const ridgeEnd = ridge[ridge.length - 1];
  const shadePts = smooth
    ? [...right, [ridgeEnd[0] + 4, B], ...[...ridge].reverse()]
    : [...right, foot, ...[...ridge].reverse().slice(1)];

  // Hatching: strokes from the shaded flank toward the ridge.
  let hatch = '';
  for (let k = 0; k < hatches; k++) {
    const t = lerp(0.12, 0.92, (k + 0.3 + 0.4 * r()) / hatches);
    const a = along(right, t), b = along(ridge, Math.min(1, t * (smooth ? 1.2 : 1)));
    const len = lerp(0.35, 0.8, r());
    const e = [lerp(a[0], b[0], len), lerp(a[1], b[1], len) + (r() - 0.3) * 3];
    hatch += `M${f(a[0] - 0.5)} ${f(a[1])}L${f(e[0])} ${f(e[1])}`;
  }

  let ink = pathOf(outline, { smooth }) + pathOf(ridge, { smooth });
  if (snow) {
    // Zigzag snow line across the upper slopes.
    const t = lerp(0.18, 0.3, r());
    const a = along([...left].reverse(), t), c = along(right, t * 0.9);
    const n = 3 + Math.floor(r() * 2);
    const zig = [a];
    for (let k = 1; k < n; k++) zig.push([lerp(a[0], c[0], k / n), lerp(a[1], c[1], k / n) + (k % 2 ? 3.5 : -1) * (0.6 + r() * 0.6)]);
    zig.push(c);
    ink += pathOf(zig);
  }
  if (ticks) {
    // Ground ticks beside the base.
    const w = lerp(3, 8, r());
    ink += `M${f(x1 - 2)} ${B}L${f(x1 + w)} ${B}`;
    if (r() < 0.6) ink += `M${f(x0 - w * 0.6)} ${B}L${f(x0 + 2)} ${B}`;
  }
  return { fill: pathOf(outline, { close: true, smooth }), shade: pathOf(shadePts, { close: true, smooth }), hatch, ink, top: Math.min(...outline.map((p) => p[1])) };
}

// Where each kind belongs. Placement (the map) chooses a kind from the terrain with
// stampKindFor() below, then any stamp of that kind, so the shapes can be redrawn or
// replaced later without touching placement. Elevations are in metres; relief is the
// local spread of elevations around a spot relative to what's normal at that zoom level
// (1 = typical, 2 = twice as rugged).
export const STAMP_TERRAIN = {
  crag: 'The highest, steepest ground: young collision ranges. Above 2,800 m, or above 2,200 m with relief over 1.6.',
  range: 'The spine of a big range, where high ground continues all around. Above 2,200 m with every neighbour above 2,000 m.',
  peak: 'High mountains. 2,200–2,800 m.',
  broad: 'High but gentle ground: plateaus and old, worn-down massifs. Above 1,600 m with relief under 0.7.',
  twin: 'Ordinary mountains. 1,600–2,200 m.',
  foothills: 'Low rises at the feet of higher ground. 1,000–1,600 m, with ground at least 400 m higher close by.',
  hill: 'Rolling uplands away from big ranges. 1,000–1,600 m.',
};

/**
 * The stamp kind for a spot, or null for ground too low for one.
 * @param elev      elevation (m)
 * @param relief    local relief relative to normal (see STAMP_TERRAIN)
 * @param minNear   lowest neighbouring elevation (m)
 * @param maxAround highest elevation in the wider surroundings (m)
 */
export function stampKindFor(elev, relief, minNear, maxAround) {
  if (elev < 1000) return null;
  if (elev >= 2800 || (elev >= 2200 && relief > 1.6)) return 'crag';
  if (elev >= 2200 && minNear >= 2000) return 'range';
  if (elev >= 2200) return 'peak';
  if (elev >= 1600 && relief < 0.7) return 'broad';
  if (elev >= 1600) return 'twin';
  if (maxAround >= elev + 400) return 'foothills';
  return 'hill';
}

/** Stamps of the set grouped by kind: { kind: [stamp, ...] }, every kind non-empty. */
export function stampsByKind(seed, perKind = 6) {
  const out = {};
  let n = 0;
  for (const [kind] of KINDS) {
    out[kind] = [];
    for (let k = 0; k < perKind; k++) out[kind].push(makeStamp(seed, n++, kind));
  }
  return out;
}

const KINDS = [
  ['peak', 4], ['crag', 2], ['broad', 2], ['twin', 3], ['range', 2], ['hill', 3], ['foothills', 2],
];
const KIND_TOTAL = KINDS.reduce((s, [, w]) => s + w, 0);

/** Stamp n of the set for this seed: { id, kind, peaks: [{ fill, shade, hatch, ink }], top }. */
export function makeStamp(seed, n, kind) {
  const r = rng(seed, n);
  if (!kind) {
    let pick = r() * KIND_TOTAL;
    for (const [k, w] of KINDS) { if ((pick -= w) < 0) { kind = k; break; } }
  }
  const J = (lo, hi) => lerp(lo, hi, r());
  const peaks = [];
  switch (kind) {
    case 'peak': {
      const px = J(42, 58);
      peaks.push(makePeak(r, J(4, 16), J(84, 96), px, J(16, 34), { rough: J(0.12, 0.2), snow: r() < 0.6, hatches: 6 + Math.floor(r() * 4) }));
      break;
    }
    case 'crag': {
      peaks.push(makePeak(r, J(10, 20), J(78, 90), J(40, 55), J(4, 14), { rough: J(0.2, 0.28), snow: r() < 0.8, hatches: 8 + Math.floor(r() * 3) }));
      break;
    }
    case 'broad': {
      peaks.push(makePeak(r, J(0, 6), J(94, 100), J(38, 62), J(40, 56), { rough: J(0.08, 0.14), snow: r() < 0.25, hatches: 7 + Math.floor(r() * 3) }));
      break;
    }
    case 'twin': {
      // Taller one behind, smaller one in front, to either side.
      const flip = r() < 0.5 ? 1 : -1;
      const bx = 50 - flip * J(8, 14);
      peaks.push(makePeak(r, bx - J(32, 40), bx + J(30, 38), bx + J(-4, 4), J(10, 26), { rough: J(0.12, 0.22), snow: r() < 0.6, hatches: 6, ticks: false }));
      const fx = 50 + flip * J(14, 22);
      peaks.push(makePeak(r, fx - J(24, 30), fx + J(22, 28), fx + J(-3, 3), J(38, 52), { rough: J(0.12, 0.2), hatches: 5 }));
      break;
    }
    case 'range': {
      peaks.push(makePeak(r, J(22, 30), J(70, 78), J(46, 54), J(4, 18), { rough: J(0.14, 0.24), snow: r() < 0.7, hatches: 7, ticks: false }));
      peaks.push(makePeak(r, J(0, 6), J(42, 50), J(20, 28), J(34, 46), { rough: J(0.12, 0.2), hatches: 5, ticks: false }));
      peaks.push(makePeak(r, J(52, 60), J(94, 100), J(72, 80), J(42, 54), { rough: J(0.12, 0.2), hatches: 5 }));
      break;
    }
    case 'hill': {
      peaks.push(makePeak(r, J(14, 24), J(76, 86), J(44, 56), J(62, 74), { rough: 0.04, smooth: true, hatches: 3 + Math.floor(r() * 2) }));
      break;
    }
    case 'foothills': {
      peaks.push(makePeak(r, J(30, 40), J(86, 96), J(58, 68), J(64, 74), { rough: 0.04, smooth: true, hatches: 3, ticks: false }));
      peaks.push(makePeak(r, J(4, 12), J(58, 66), J(30, 38), J(72, 82), { rough: 0.04, smooth: true, hatches: 2 }));
      break;
    }
  }
  return { id: n, kind, peaks, top: Math.min(...peaks.map((p) => p.top)) };
}

/** A set of count stamps (a mix of kinds). */
export function makeStamps(seed, count = 36) {
  return Array.from({ length: count }, (_, n) => makeStamp(seed, n));
}

/** SVG group markup for a stamp (no <svg> wrapper). */
export function stampGroup(stamp, style = STAMP_STYLE) {
  return stamp.peaks.map((p) =>
    `<path d="${p.fill}" fill="${style.fill}"/>` +
    `<path d="${p.shade}" fill="${style.shade}"/>` +
    `<path d="${p.hatch}" fill="none" stroke="${style.ink}" stroke-width="${style.hatchWidth}" stroke-linecap="round"/>` +
    `<path d="${p.ink}" fill="none" stroke="${style.ink}" stroke-width="${style.inkWidth}" stroke-linejoin="round" stroke-linecap="round"/>`,
  ).join('');
}

/** A standalone SVG document for a stamp. */
export function stampSvg(stamp, style = STAMP_STYLE) {
  const top = Math.floor(stamp.top) - 4;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-6 ${top} 112 ${B + 4 - top}">${stampGroup(stamp, style)}</svg>`;
}

// ---------- Relief stamps ----------
// A second set, chosen by the shape of the ground around a spot, not by its altitude, so a
// sharp rise in a lowland and one on a high plateau get the same symbol. Sized for single
// mountains (a few miles across) on the 4-mile squares. Measures (all in metres, from the
// 4-mile squares; the ring is the squares about 20 miles out):
//   p      prominence: elevation minus the ring's average
//   dropW  elevation minus the average of the ring's west side (dropE: east side)
//   inner  elevation minus the average of the 8 squares around it
// The thresholds come from how these are spread over this terrain's land; the shares below
// are of land squares. Checked in this order, first match wins.
export const RELIEF_TERRAIN = {
  scarpE: 'Cliff facing east: the ground east (20 mi) is 140 m or more lower, the west side no higher and dropping under 30% as much. Gentle back slope west (~2.5%).',
  scarpW: 'Same, mirrored: cliff facing west (~2%).',
  mesa: 'Broad-topped: 90 m or more above the ring, but under 5% of that above its 8 neighbours, so the top is broad (~3%).',
  spire: 'The most prominent spots: 255 m or more above the ring (~0.6%), easing to 153 m on ground at 3,000 m and up, and to half that on the highest 5% of land (from ~2,400 m).',
  peak: 'Clear mountains: 192–255 m above the ring (~1.7%), easing to 115–153 m on ground at 3,000 m and up, and to half that on the highest 5% of land.',
  hill: 'Hills: 90 m above the ring, up to where peaks start (~8%).',
  rise: 'Low rises: 45–90 m above the ring (~13%).',
  knoll: 'Slight swells: 20–45 m above the ring (~10%).',
};

// Mountains are commoner on high ground (still rugged, recently raised) than in worn-down
// lowlands: the spire and peak thresholds are scaled by a factor easing from 1 at
// MOUNTAIN_EASE[0] m and below to MOUNTAIN_HIGH_SCALE at MOUNTAIN_EASE[1] m and above.
// On top of that, the highest ground (the top 5% of land, from about 2,400 m in this
// terrain) has its thresholds scaled again by MOUNTAIN_TOP_SCALE, eased in over the 200 m
// below, which doubles its share of mountains (about 16% of squares to 32%).
export const MOUNTAIN_EASE = [1000, 3000];
export const MOUNTAIN_HIGH_SCALE = 0.6;
export const MOUNTAIN_TOP = [2200, 2400];
export const MOUNTAIN_TOP_SCALE = 0.5;

/** Spire/peak threshold scale for elevation e (m). */
export function mountainScale(e) {
  const ease = (lo, hi) => Math.min(1, Math.max(0, (e - lo) / (hi - lo)));
  return (1 + (MOUNTAIN_HIGH_SCALE - 1) * ease(...MOUNTAIN_EASE))
    * (1 + (MOUNTAIN_TOP_SCALE - 1) * ease(...MOUNTAIN_TOP));
}

/** The relief stamp kind for a spot (measures as in RELIEF_TERRAIN; e = elevation, m), or null. */
export function reliefKindFor({ e, p, dropW, dropE, inner }) {
  const steep = Math.max(dropW, dropE), gentle = Math.min(dropW, dropE);
  if (steep >= 140 && gentle >= 0 && gentle < 0.3 * steep) return dropE > dropW ? 'scarpE' : 'scarpW';
  if (p >= 90 && inner < 0.05 * p) return 'mesa';
  const m = mountainScale(e);
  if (p >= 255 * m) return 'spire';
  if (p >= 192 * m) return 'peak';
  if (p >= 90) return 'hill';
  if (p >= 45) return 'rise';
  if (p >= 20) return 'knoll';
  return null;
}

export const RELIEF_KINDS = ['spire', 'peak', 'hill', 'rise', 'knoll', 'scarpE', 'scarpW', 'mesa'];

const mirror = (pts) => pts.map(([x, y]) => [100 - x, y]);

/** Vertical hatch strokes hanging from points along a cliff line (rim to foot). */
function cliffHatch(r, cliff, n, flipX, scale = 1) {
  let out = '';
  for (let k = 0; k < n; k++) {
    const [x, y] = along(cliff, (k + 0.3 + 0.4 * r()) / n);
    const len = lerp(4, 10, r()) * scale;
    const seg = [[x + 0.6, y + 1], [x + 0.6 - 0.4 * r(), Math.min(B - 1, y + len)]];
    out += pathOf(flipX ? mirror(seg) : seg);
  }
  return out;
}

/**
 * Escarpment (cuesta): a long gentle slope up from x0 to a crest, then a steep cliff and a
 * talus apron down to x1. Cliff on the right (east); flip = cliff on the left (west).
 * Varies (at random) in:
 *   back slope  bulging, sagging, or with a small knob partway up
 *   rim         a sharp edge, or rounded over
 *   cliff       one face, or two steps with a ledge between
 *   ticks       ground ticks at the foot, or none
 * hatchScale scales the hatch strokes (smaller for small scarps).
 */
function makeScarp(r, x0, x1, crestX, crestY, flip, { hatchScale = 0.5 } = {}) {
  const L0 = [x0, B], C = [crestX, crestY];
  const h = B - crestY; // height of the crest
  // Back slope profile.
  const t = lerp(0.4, 0.7, r());
  const profile = r();
  let back;
  if (profile < 0.4) { // bulging up
    const M = [lerp(x0, crestX, t), lerp(B, crestY, t) - lerp(0.04, 0.12, r()) * h];
    back = [...roughLine(r, L0, M, 0.03, 2), ...roughLine(r, M, C, 0.03, 2).slice(1)];
  } else if (profile < 0.75) { // sagging (concave), steepening toward the crest
    const M = [lerp(x0, crestX, t), lerp(B, crestY, t) + lerp(0.06, 0.16, r()) * h];
    back = [...roughLine(r, L0, M, 0.03, 2), ...roughLine(r, M, C, 0.03, 2).slice(1)];
  } else { // a small knob partway up
    const k0 = lerp(0.35, 0.6, r()), kw = lerp(0.08, 0.14, r());
    const A = [lerp(x0, crestX, k0), lerp(B, crestY, k0)];
    const K = [lerp(x0, crestX, k0 + kw / 2), lerp(B, crestY, k0 + kw / 2) - lerp(0.1, 0.2, r()) * h];
    const D = [lerp(x0, crestX, k0 + kw), lerp(B, crestY, k0 + kw) + lerp(0, 0.04, r()) * h];
    back = [...roughLine(r, L0, A, 0.03, 2), K, ...roughLine(r, D, C, 0.03, 2)];
  }
  // Rim: sharp (a short cap, then straight over the edge) or rounded over.
  const rounded = r() < 0.35;
  const E = rounded
    ? [crestX + lerp(3, 6, r()), crestY + lerp(0.08, 0.15, r()) * h]
    : [crestX + lerp(1, 4, r()), crestY + lerp(0, 0.05, r()) * h];
  const cap = rounded ? [[lerp(crestX, E[0], 0.6), crestY + 0.02 * h]] : [];
  // Cliff: one face, or two with a ledge between.
  const footH = lerp(0.25, 0.45, r()) * h; // talus top, above the ground
  const F = [E[0] + lerp(1.5, 3.5, r()), B - footH];
  let cliff;
  if (r() < 0.35) {
    const ly = lerp(E[1], F[1], lerp(0.4, 0.6, r()));
    const l0 = [lerp(E[0], F[0], 0.45), ly], l1 = [l0[0] + lerp(2, 4, r()), ly + lerp(0, 1, r())];
    cliff = [...roughLine(r, E, l0, 0.2, 2), l1, ...roughLine(r, l1, [F[0] + (l1[0] - l0[0]), F[1]], 0.2, 2).slice(1)];
  } else {
    cliff = roughLine(r, E, F, 0.22, 3);
  }
  const talus = roughLine(r, cliff[cliff.length - 1], [x1, B], 0.06, 2);
  const outline = [...back, ...cap, ...cliff, ...talus.slice(1)];
  const shade = [...cliff, ...talus.slice(1), [lerp(E[0], x1, 0.12), B]];
  // Hatching: on the cliff, plus a few slanted strokes on the talus.
  let hatch = cliffHatch(r, cliff, 5 + Math.floor(r() * 4), flip, hatchScale);
  for (let k = 0; k < 2; k++) {
    const [x, y] = along(talus, 0.25 + 0.35 * k);
    const seg = [[x, y + 1], [x - 2 * hatchScale * 2, y + 4 * hatchScale * 2]];
    hatch += pathOf(flip ? mirror(seg) : seg);
  }
  const m = flip ? mirror : (q) => q;
  let ink = pathOf(m(outline));
  if (r() < 0.7) ink += pathOf(m([[x1 - 1, B], [x1 + lerp(3, 7, r()), B]]));
  return { fill: pathOf(m(outline), { close: true }), shade: pathOf(m(shade), { close: true }), hatch, ink, top: Math.min(...outline.map((q) => q[1])) };
}

/**
 * Mesa: steep (not sheer) sides over talus, and a broad top at about height ty that's
 * uneven and gently crowned, highest somewhere off-centre, not table-flat.
 */
function makeMesa(r, x0, x1, ty) {
  const J = (lo, hi) => lerp(lo, hi, r());
  const L0 = [x0, B], LF = [x0 + J(5, 9), B - J(10, 16)], TL = [x0 + J(16, 22), ty + J(4, 9)];
  const TR = [x1 - J(16, 22), ty + J(4, 9)], RF = [x1 - J(5, 9), B - J(10, 16)], R0 = [x1, B];
  const crown = [lerp(TL[0], TR[0], J(0.3, 0.7)), ty - J(1, 5)];
  const lTalus = roughLine(r, L0, LF, 0.06, 2), lCliff = roughLine(r, LF, TL, 0.16, 3);
  const top = [...roughLine(r, TL, crown, 0.06, 2), ...roughLine(r, crown, TR, 0.06, 2).slice(1)];
  const rCliff = roughLine(r, TR, RF, 0.16, 3), rTalus = roughLine(r, RF, R0, 0.06, 2);
  const outline = [...lTalus, ...lCliff.slice(1), ...top.slice(1), ...rCliff.slice(1), ...rTalus.slice(1)];
  const shade = [...rCliff, ...rTalus.slice(1), [lerp(TR[0], x1, 0.15), B]];
  const hatch = cliffHatch(r, rCliff, 5 + Math.floor(r() * 3)) + cliffHatch(r, [...lCliff].reverse(), 2);
  const ink = pathOf(outline, { smooth: true }) + `M${f(x1 - 1)} ${B}L${f(x1 + J(3, 7))} ${B}`;
  return { fill: pathOf(outline, { close: true, smooth: true }), shade: pathOf(shade, { close: true }), hatch, ink, top: Math.min(...outline.map((q) => q[1])) };
}

/** Relief stamp n of the set: { id, kind, peaks, top } (ids start at 1000, apart from the first set). */
export function makeReliefStamp(seed, n, kind) {
  const r = rng(seed, 5000 + n);
  const J = (lo, hi) => lerp(lo, hi, r());
  const peaks = [];
  switch (kind) {
    case 'spire': // tall, narrow and jagged
      peaks.push(makePeak(r, J(14, 24), J(76, 86), J(42, 56), J(0, 10), { rough: J(0.2, 0.3), hatches: 7 + Math.floor(r() * 3) }));
      break;
    case 'peak': // an ordinary mountain, sometimes with a lower shoulder beside it
      if (r() < 0.4) {
        const flip = r() < 0.5 ? 1 : -1;
        peaks.push(makePeak(r, J(8, 18), J(82, 92), 50 - flip * J(4, 10), J(18, 30), { rough: J(0.12, 0.2), hatches: 6, ticks: false }));
        const fx = 50 + flip * J(18, 26);
        peaks.push(makePeak(r, fx - J(20, 26), fx + J(20, 26), fx + J(-3, 3), J(50, 62), { rough: J(0.1, 0.16), hatches: 4 }));
      } else {
        peaks.push(makePeak(r, J(6, 16), J(84, 94), J(42, 58), J(18, 32), { rough: J(0.12, 0.2), hatches: 6 + Math.floor(r() * 3) }));
      }
      break;
    case 'hill': // rounded
      peaks.push(makePeak(r, J(10, 20), J(80, 90), J(42, 58), J(50, 62), { rough: 0.04, smooth: true, hatches: 4 }));
      break;
    case 'rise': // low and broad
      peaks.push(makePeak(r, J(4, 14), J(86, 96), J(40, 60), J(70, 80), { rough: 0.03, smooth: true, hatches: 2 + Math.floor(r() * 2), ticks: r() < 0.5 }));
      break;
    case 'knoll': // a slight swell, barely off the ground
      peaks.push(makePeak(r, J(16, 26), J(74, 84), J(42, 58), J(82, 88), { rough: 0.02, smooth: true, hatches: 1 + Math.floor(r() * 2), ticks: false }));
      break;
    case 'scarpE': // gentle slope up from the west, cliff to the east
    case 'scarpW': {
      const flip = kind === 'scarpW';
      // Sometimes a second, lower scarp behind (layered beds), offset back from the cliff.
      if (r() < 0.3) {
        const back = flip ? 1 : -1; // toward the gentle side
        const ox = back * J(14, 24);
        peaks.push(makeScarp(r, J(0, 8) + Math.min(0, ox) + 4, J(84, 94) + Math.min(0, ox), J(56, 66) + ox * 0.6, J(78, 84), flip, { hatchScale: 0.35 }));
      }
      peaks.push(makeScarp(r, J(0, 10), J(88, 100), J(55, 78), J(70, 84), flip));
      break;
    }
    case 'mesa':
      peaks.push(makeMesa(r, J(2, 10), J(90, 98), J(48, 60)));
      break;
  }
  return { id: 1000 + n, kind, peaks, top: Math.min(...peaks.map((p) => p.top)) };
}

/** Relief stamps grouped by kind: { kind: [stamp, ...] }. */
export function reliefStampsByKind(seed, perKind = 6) {
  const out = {};
  let n = 0;
  for (const kind of RELIEF_KINDS) {
    out[kind] = [];
    for (let k = 0; k < perKind; k++) out[kind].push(makeReliefStamp(seed, n++, kind));
  }
  return out;
}

// How relief stamps blend into the terrain under them: the fill is the land colour at the
// stamp's elevation, a little lighter on the lit face; the shaded face, hatching and ink
// are darker versions of that same colour, with the ink partly see-through; and the bottom
// baseFade of the stamp's height fades out into the ground, so there's no hard base line.
export const RELIEF_STYLE = {
  lighten: 0.12,  // lit face: this share of the way to white
  shadeDark: 0.8, // shaded face: land colour times this
  inkDark: 0.4,   // ink and hatching: land colour times this...
  inkAlpha: 0.75, // ...this opaque
  baseFade: 0.35, // share of the stamp's height (from the base) that fades out
};

/** CSS colours { fill, shade, ink } for a relief stamp on land at elevation e (m). */
export function reliefColours(e, style = RELIEF_STYLE) {
  const [r, g, b] = colour(e);
  const mix = (t) => `rgb(${r + (255 - r) * t | 0},${g + (255 - g) * t | 0},${b + (255 - b) * t | 0})`;
  const dark = (t, a = 1) => `rgba(${r * t | 0},${g * t | 0},${b * t | 0},${a})`;
  return { fill: mix(style.lighten), shade: dark(style.shadeDark), ink: dark(style.inkDark, style.inkAlpha) };
}

let svgIds = 0;
/** A standalone SVG for a relief stamp coloured as on the map at elevation e (m), base faded. */
export function reliefSvg(stamp, e, style = RELIEF_STYLE) {
  const c = reliefColours(e, style);
  const top = Math.floor(stamp.top) - 4;
  const id = 'fade' + svgIds++;
  const fadeTop = B - style.baseFade * (B - stamp.top);
  const group = stamp.peaks.map((p) =>
    `<path d="${p.fill}" fill="${c.fill}"/><path d="${p.shade}" fill="${c.shade}"/>` +
    `<path d="${p.hatch}" fill="none" stroke="${c.ink}" stroke-width="${STAMP_STYLE.hatchWidth}" stroke-linecap="round"/>` +
    `<path d="${p.ink}" fill="none" stroke="${c.ink}" stroke-width="${STAMP_STYLE.inkWidth}" stroke-linejoin="round" stroke-linecap="round"/>`,
  ).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-6 ${top} 112 ${B + 4 - top}">` +
    `<defs><linearGradient id="${id}g" gradientUnits="userSpaceOnUse" x1="0" y1="${f(fadeTop)}" x2="0" y2="${B}">` +
    `<stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0.1"/></linearGradient>` +
    `<mask id="${id}"><rect x="-6" y="${top}" width="112" height="${f(fadeTop - top)}" fill="#fff"/>` +
    `<rect x="-6" y="${f(fadeTop)}" width="112" height="${f(B - fadeTop)}" fill="url(#${id}g)"/>` +
    `<rect x="-6" y="${B}" width="112" height="4" fill="#fff" fill-opacity="0.1"/></mask></defs>` +
    `<g mask="url(#${id})">${group}</g></svg>`;
}
