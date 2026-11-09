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
