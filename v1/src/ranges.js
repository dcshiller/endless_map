// Mountain ranges as explicit line features.
//
// The world is divided into CELL x CELL-mile cells. Each cell deterministically (from the
// seed and its coordinates) may spawn one or more *belts*: a sinuous main spine plus a few
// parallel subsidiary ranges. Every spine is a polyline whose vertices carry a crest
// height and a half-width. Elevation near a spine falls off with distance to it.
//
// Grouping comes from two places:
//   - a very-low-frequency "province" field controls how likely a cell is to host belts,
//     so mountains cluster into orogenic provinces with quiet regions between;
//   - each belt carries parallel sub-ranges, so ranges come in bundles.
// Heights are drawn from a skewed distribution (most belts moderate, a few very high),
// and vary along each spine, so every belt has a high core and lower ends.

import { mulberry32, hashString } from './noise.js';

export const RANGE_PARAMS = {
  cell: 1500,          // miles
  step: 40,            // miles between spine vertices
  minLength: 1200,
  maxLength: 4500,
  baseHeight: 1400,    // m, lowest typical crest
  extraHeight: 4600,   // m, added with a strongly skewed distribution
  oceanChance: 0.12,   // chance to keep a belt whose origin is at sea (island arcs)
  reachWidths: 3.5,    // influence radius, in half-widths
};

const P = RANGE_PARAMS;

/**
 * @param seed       numeric seed
 * @param province   (x, y) -> [0, 1], how tectonically active a region is
 * @param landAt     (x, y) -> continentalness (>0 means land), coarse
 * @param grain      (x, y) -> preferred range orientation (radians), slowly varying, so
 *                   neighbouring belts run roughly parallel like a real orogen
 */
export function createRanges(seed, province, landAt, grain) {
  const cache = new Map();
  const CACHE_MAX = 4096;

  function cellBelts(ci, cj) {
    const key = ci + ',' + cj;
    let v = cache.get(key);
    if (v) return v;
    v = generateCell(ci, cj);
    cache.set(key, v);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return v;
  }

  function generateCell(ci, cj) {
    const rng = mulberry32(hashString(seed + ':belt:' + ci + ',' + cj));
    const lines = [];
    const x0 = ci * P.cell, y0 = cj * P.cell;
    const prov = province(x0 + P.cell / 2, y0 + P.cell / 2);
    // Up to three belt attempts; active provinces get more.
    for (let attempt = 0; attempt < 3; attempt++) {
      const chance = attempt === 0 ? 0.03 + 0.97 * prov ** 1.5 : prov * prov * (attempt === 1 ? 0.7 : 0.35);
      const roll = rng();
      // Always draw the same number of randoms per attempt so cells stay stable.
      const sx = x0 + rng() * P.cell, sy = y0 + rng() * P.cell;
      const keepOcean = rng();
      const beltSeed = (rng() * 4294967296) >>> 0;
      if (roll >= chance) continue;
      if (landAt(sx, sy) < -0.02 && keepOcean > P.oceanChance) continue;
      makeBelt(mulberry32(beltSeed), sx, sy, prov, lines);
    }
    return lines;
  }

  function makeBelt(rng, sx, sy, prov, out) {
    const length = P.minLength + (P.maxLength - P.minLength) * rng() * (0.5 + 0.5 * prov);
    const n = Math.max(4, Math.round(length / P.step));
    // Skewed peak height: most belts moderate, a few towering.
    const r = rng();
    const peak = (P.baseHeight + P.extraHeight * r * r * r) * (0.65 + 0.35 * prov);
    const halfWidth = 50 + 35 * (peak / 1000);

    // Main spine: random walk with smoothly varying curvature, grown from the middle out.
    const theta0 = grain(sx, sy) + (rng() - 0.5) * 0.2;
    const curve = (rng() - 0.5) * 0.01;
    const wob1 = rng() * 6.28, wob2 = rng() * 6.28, wobA = 0.012 + 0.02 * rng();
    const bias = theta0 - grain(sx, sy); // keep this belt's offset from the local grain
    const pts = new Array(n);
    const mid = n >> 1;
    const walk = (dir) => {
      let x = sx, y = sy, th = theta0 + (dir < 0 ? Math.PI : 0);
      for (let k = mid; k >= 0 && k < n; k += dir) {
        pts[k] = [x, y];
        const s = k / n;
        th += dir * (curve + wobA * Math.sin(s * 9 + wob1) + 0.6 * wobA * Math.sin(s * 23 + wob2));
        // Steer back toward the local tectonic grain (axis-aligned: either direction).
        let target = grain(x, y) + bias + (dir < 0 ? Math.PI : 0);
        let diff = Math.atan2(Math.sin(target - th), Math.cos(target - th));
        th += 0.12 * diff;
        x += Math.cos(th) * P.step;
        y += Math.sin(th) * P.step;
      }
    };
    walk(1);
    walk(-1);

    // Height profile along the spine: high core, tapering ends, a few saddles and summits.
    const core = 0.3 + 0.4 * rng();
    const ph1 = rng() * 6.28, ph2 = rng() * 6.28;
    const heightAt = (s) => {
      const taper = Math.pow(Math.sin(Math.PI * s), 0.5);
      const coreBoost = Math.exp(-((s - core) ** 2) / 0.06);
      const undulate = 0.82 + 0.12 * Math.sin(s * 17 + ph1) + 0.06 * Math.sin(s * 41 + ph2);
      return peak * taper * (0.55 + 0.45 * coreBoost) * undulate;
    };
    out.push(buildLine(pts, (k) => heightAt(k / (n - 1)), (k) => halfWidth * (0.6 + 0.4 * Math.sin(Math.PI * k / (n - 1))), 0));

    // Parallel sub-ranges on either side: shorter, lower, partly overlapping the main one.
    const nSub = Math.floor(rng() * (1.5 + 2.5 * prov));
    for (let q = 0; q < nSub; q++) {
      const side = rng() < 0.5 ? -1 : 1;
      const offset = side * halfWidth * (1.3 + 1.4 * rng());
      const a = Math.floor(rng() * n * 0.4);
      const b = Math.min(n - 1, a + Math.floor(n * (0.35 + 0.5 * rng())));
      if (b - a < 3) continue;
      const rel = 0.35 + 0.4 * rng();
      const wph = rng() * 6.28;
      const sub = [];
      for (let k = a; k <= b; k++) {
        const k0 = Math.max(0, k - 1), k1 = Math.min(n - 1, k + 1);
        const dx = pts[k1][0] - pts[k0][0], dy = pts[k1][1] - pts[k0][1];
        const len = Math.hypot(dx, dy) || 1;
        const o = offset * (1 + 0.25 * Math.sin(k * 0.35 + wph));
        sub.push([pts[k][0] - (dy / len) * o, pts[k][1] + (dx / len) * o]);
      }
      const m = sub.length;
      out.push(buildLine(
        sub,
        (k) => heightAt((a + k) / (n - 1)) * rel * Math.pow(Math.sin(Math.PI * (k + 0.5) / m), 0.4),
        () => halfWidth * 0.7,
        1,
      ));
    }
  }

  function buildLine(pts, hFn, wFn, rank) {
    const n = pts.length;
    const xs = new Float64Array(n), ys = new Float64Array(n);
    const hs = new Float64Array(n), ws = new Float64Array(n);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, maxW = 0, maxH = 0;
    for (let k = 0; k < n; k++) {
      xs[k] = pts[k][0]; ys[k] = pts[k][1];
      hs[k] = hFn(k); ws[k] = wFn(k);
      if (xs[k] < minX) minX = xs[k];
      if (xs[k] > maxX) maxX = xs[k];
      if (ys[k] < minY) minY = ys[k];
      if (ys[k] > maxY) maxY = ys[k];
      if (ws[k] > maxW) maxW = ws[k];
      if (hs[k] > maxH) maxH = hs[k];
    }
    const reach = maxW * P.reachWidths;
    return { xs, ys, hs, ws, n, rank, maxH, reach, minX: minX - reach, minY: minY - reach, maxX: maxX + reach, maxY: maxY + reach };
  }

  /** All spines whose influence overlaps the given box. */
  function linesIn(x0, y0, x1, y1) {
    const pad = P.maxLength / 2 + 300 * P.reachWidths; // a belt can reach this far from its cell
    const ci0 = Math.floor((x0 - pad) / P.cell), ci1 = Math.floor((x1 + pad) / P.cell);
    const cj0 = Math.floor((y0 - pad) / P.cell), cj1 = Math.floor((y1 + pad) / P.cell);
    const res = [];
    for (let cj = cj0; cj <= cj1; cj++) {
      for (let ci = ci0; ci <= ci1; ci++) {
        for (const L of cellBelts(ci, cj)) {
          if (L.maxX >= x0 && L.minX <= x1 && L.maxY >= y0 && L.minY <= y1) res.push(L);
        }
      }
    }
    return res;
  }

  /**
   * Mountain height at (x, y) from a pre-filtered list of spines.
   * Writes {height, influence} into out. Overlapping ranges combine by max, not sum.
   */
  function sample(lines, x, y, out) {
    let best = 0, infl = 0;
    for (let li = 0; li < lines.length; li++) {
      const L = lines[li];
      if (x < L.minX || x > L.maxX || y < L.minY || y > L.maxY) continue;
      const { xs, ys, n, reach } = L;
      const r2 = reach * reach;
      let bd2 = Infinity, bk = 0, bt = 0;
      for (let k = 0; k < n - 1; k++) {
        const ax = xs[k], ay = ys[k];
        const vx = xs[k + 1] - ax, vy = ys[k + 1] - ay;
        const qx = x - ax, qy = y - ay;
        // Cheap reject: point far from this segment's start (segments are short).
        if (qx * qx + qy * qy > r2 + 6 * P.step * reach + 9 * P.step * P.step) continue;
        let t = (qx * vx + qy * vy) / (vx * vx + vy * vy);
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const dx = qx - vx * t, dy = qy - vy * t;
        const d2 = dx * dx + dy * dy;
        if (d2 < bd2) { bd2 = d2; bk = k; bt = t; }
      }
      if (bd2 >= r2) continue;
      const w = L.ws[bk] + (L.ws[bk + 1] - L.ws[bk]) * bt;
      const h = L.hs[bk] + (L.hs[bk + 1] - L.hs[bk]) * bt;
      const u2 = bd2 / (w * w);
      // Sharp crest + broad foothill apron.
      const prof = 0.7 * Math.exp(-3 * u2) + 0.3 * Math.exp(-0.5 * u2);
      const v = h * prof;
      if (v > best) best = v;
      if (prof > infl) infl = prof;
    }
    out.height = best;
    out.influence = infl;
  }

  return { linesIn, sample };
}
