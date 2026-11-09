// Hotspots: fixed mantle plumes that punch volcanoes through whatever plate is moving over
// them. The plate carries older volcanoes away, so each hotspot leaves a chain running
// opposite to its plate's motion: youngest and tallest over the plume, older ones lower
// (eroded, sinking) and wider, ending as seamounts.
//
// To look natural rather than like a row of equal dots:
// - Volcanoes vary in size, and sit closer together than they are wide, so neighbours
//   merge into ridges and multi-peaked islands, with occasional gaps.
// - Each volcano is a bell shape (long gentle flanks); overlapping volcanoes add up.
// - The whole chain sits on a broad swell of raised sea floor, highest at the plume and
//   sinking gradually along the chain.

import { hash, keyOf } from './random.js';

export const HOTSPOT_CELL = 4000;     // miles: one region per possible hotspot...
export const HOTSPOT_CHANCE = 0.5;    // ...holding one with this chance
export const MIN_HEIGHT = 3800, MAX_HEIGHT = 6000; // m: typical young volcano above its surroundings
export const MIN_RADIUS = 18, MAX_RADIUS = 32;     // miles: typical young volcano's radius
export const MIN_COUNT = 8, MAX_COUNT = 30;        // volcanoes per chain
export const BASE_SPACING = 35, SPEED_SPACING = 80; // miles between volcanoes: base + per unit plate speed
export const AGE_HEIGHT = 0.86;       // each older volcano's height, relative to the next younger
export const AGE_WIDEN = 0.05;        // each older volcano's radius grows by this share
export const SWELL_HEIGHT = 1000;      // m: raised sea floor under the plume
export const SWELL_WIDTH = 150;       // miles: the swell's half-width
export const SWELL_AGE = 0.94;        // swell height per volcano step along the chain
const BELL_CUTOFF = 3;                // bells are ignored beyond this many radii

// Per-hotspot character, so chains differ from each other:
export const STRENGTH = [0.3, 1.6];   // scales volcano and swell heights (skewed toward weak)
export const BREADTH = [0.8, 2.0];    // scales volcano radius (broader ones are also lower)
export const SPACING_SCALE = [0.7, 1.4];
export const SCATTER = [0.3, 1.5];    // sideways scatter, as a share of the spacing
export const BEND = 0.05;             // max gradual turn per volcano step (radians)
export const KINK_CHANCE = 0.3;       // chance of one sharp bend (the plate changed direction)
export const MAX_KINK = 0.7;          // radians

// A chain can reach this far beyond its hotspot's region.
export const CHAIN_REACH = MAX_COUNT * 1.5 * SPACING_SCALE[1] * (BASE_SPACING + SPEED_SPACING) + SWELL_WIDTH * BELL_CUTOFF;

const SWELL_CUT2 = (SWELL_WIDTH * BELL_CUTOFF) ** 2;
// Beyond this (miles, on both axes) from a volcano, neither its bell nor its swell segment
// can reach: a segment is at most 1.5 spacings long, plus the swell's reach.
const SKIP = 1.5 * SPACING_SCALE[1] * (BASE_SPACING + SPEED_SPACING) + SWELL_WIDTH * BELL_CUTOFF;

const lerp = ([lo, hi], t) => lo + (hi - lo) * t;

/**
 * @param seed    numeric seed
 * @param plates  plate model (createPlates), to find the plate under each hotspot
 * @param GRID    size (miles) of the squares plates are assigned to
 */
export function createHotspots(seed, plates, GRID) {
  const cache = new Map(); // "p,q" -> hotspot or null

  /** The hotspot in region (p, q), with its volcano chain, or null. */
  function hotspotIn(p, q) {
    const key = keyOf(p, q);
    let h = cache.get(key);
    if (h !== undefined) return h;
    h = null;
    if (hash(seed, p, q, 700) < HOTSPOT_CHANCE) {
      const r = (k) => hash(seed, p, q, k);
      const x = (p + r(701)) * HOTSPOT_CELL - GRID / 2;
      const y = (q + r(702)) * HOTSPOT_CELL - GRID / 2;
      const plate = plates.at(Math.round(x / GRID), Math.round(y / GRID)).plate;
      const strength = lerp(STRENGTH, r(706) ** 1.5);
      const breadth = lerp(BREADTH, r(707));
      const scatter = lerp(SCATTER, r(708));
      const height = lerp([MIN_HEIGHT, MAX_HEIGHT], r(703)) * strength / Math.sqrt(breadth);
      const radius = lerp([MIN_RADIUS, MAX_RADIUS], r(704)) * breadth;
      const count = MIN_COUNT + Math.floor((MAX_COUNT - MIN_COUNT + 1) * r(705));
      const spacing = (BASE_SPACING + SPEED_SPACING * plate.speed) * lerp(SPACING_SCALE, r(709));
      // Older volcanoes lie back along the way the plate came: opposite its motion. The
      // track bends gradually, and sometimes sharply once (the plate changed direction).
      let angle = plate.angle + Math.PI;
      const bend = (r(750) - 0.5) * 2 * BEND;
      const kinkAt = r(751) < KINK_CHANCE ? 2 + Math.floor(r(752) * (count - 2)) : -1;
      const kink = (r(753) - 0.5) * 2 * MAX_KINK;
      const volcanoes = [];
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      let cx = x, cy = y; // point on the track
      for (let k = 0; k < count; k++) {
        // Uneven steps along the track, scattered sideways, except the youngest, which
        // sits right over the plume.
        if (k > 0) {
          angle += bend + (k === kinkAt ? kink : 0);
          const step = spacing * (0.5 + r(760 + k));
          cx += Math.cos(angle) * step; cy += Math.sin(angle) * step;
        }
        const side = k === 0 ? 0 : (r(710 + k) - 0.5) * spacing * scatter;
        const vx = cx - Math.sin(angle) * side, vy = cy + Math.cos(angle) * side;
        // Sizes skew small: a few big volcanoes, many modest ones and seamounts.
        const hScale = 0.25 + 1.25 * r(730 + k) ** 1.5;
        const rScale = 1 + 0.6 * (r(790 + k) - 0.5);
        const v = {
          x: vx, y: vy, tx: cx, ty: cy, age: k,
          h: height * hScale * AGE_HEIGHT ** k,
          r: radius * rScale * (1 + AGE_WIDEN * k),
          swell: SWELL_HEIGHT * strength * SWELL_AGE ** k,
        };
        volcanoes.push(v);
        const ext = Math.max(v.r * BELL_CUTOFF, SWELL_WIDTH * BELL_CUTOFF);
        minX = Math.min(minX, vx - ext, cx - ext); maxX = Math.max(maxX, vx + ext, cx + ext);
        minY = Math.min(minY, vy - ext, cy - ext); maxY = Math.max(maxY, vy + ext, cy + ext);
      }
      h = { id: p + ',' + q, x, y, plate, height, radius, spacing, strength, breadth, scatter, volcanoes, minX, minY, maxX, maxY };
    }
    cache.set(key, h);
    return h;
  }

  const searchCells = Math.ceil(CHAIN_REACH / HOTSPOT_CELL);

  /** Hotspots whose chains could reach (x, y). */
  function near(x, y) {
    const p0 = Math.floor((x + GRID / 2) / HOTSPOT_CELL), q0 = Math.floor((y + GRID / 2) / HOTSPOT_CELL);
    const out = [];
    for (let q = q0 - searchCells; q <= q0 + searchCells; q++) {
      for (let p = p0 - searchCells; p <= p0 + searchCells; p++) {
        const h = hotspotIn(p, q);
        if (h) out.push(h);
      }
    }
    return out;
  }

  // The chains reaching each GRID cell, found once per cell (finding them is most of the
  // cost; most cells have none, so most squares skip hotspots entirely).
  const cellCache = new Map();
  function chainsInCell(i, j) {
    const key = keyOf(i, j);
    let list = cellCache.get(key);
    if (list) return list;
    const x0 = i * GRID, y0 = j * GRID, x1 = x0 + GRID, y1 = y0 + GRID;
    list = near(x0 + GRID / 2, y0 + GRID / 2).filter((h) => h.maxX >= x0 && h.minX <= x1 && h.maxY >= y0 && h.minY <= y1);
    cellCache.set(key, list);
    if (cellCache.size > 20000) cellCache.delete(cellCache.keys().next().value);
    return list;
  }

  /**
   * Hotspot height (m) at (x, y), as seen by a square of size S miles centred there: the
   * swell plus the volcanoes. A volcano narrower than the square is spread out (wider by
   * the square's half-diagonal, lower, about the same volume), so it still shows.
   * Volcanoes add up where they overlap; the swell (along the track, not the scattered
   * volcanoes) is the highest of the chain's segments.
   */
  function effectAt(x, y, S) {
    const chains = chainsInCell(Math.floor(x / GRID), Math.floor(y / GRID));
    if (chains.length === 0) return 0;
    let total = 0;
    const pad2 = (S * S) / 2; // half the square's diagonal, squared
    for (const h of chains) {
      if (x < h.minX || x > h.maxX || y < h.minY || y > h.maxY) continue;
      const vs = h.volcanoes;
      let volcano = 0, swell = 0;
      for (let k = 0; k < vs.length; k++) {
        const v = vs[k];
        const dx = x - v.x, dy = y - v.y;
        // Quick reject: farther than any bell or swell reaches (they extend ~3 radii).
        if (Math.abs(dx) > SKIP && Math.abs(dy) > SKIP) continue;
        const r2 = v.r * v.r + pad2;
        const d2 = dx * dx + dy * dy;
        if (d2 < r2 * BELL_CUTOFF * BELL_CUTOFF) volcano += v.h * (v.r * v.r / r2) * Math.exp(-d2 / r2);
        // Swell: a ridge along the track to the next older point (or round the last).
        const w = k + 1 < vs.length ? vs[k + 1] : v;
        const sx = w.tx - v.tx, sy = w.ty - v.ty, len2 = sx * sx + sy * sy;
        const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - v.tx) * sx + (y - v.ty) * sy) / len2)) : 0;
        const ex = x - (v.tx + t * sx), ey = y - (v.ty + t * sy);
        const e2 = ex * ex + ey * ey;
        if (e2 > SWELL_CUT2) continue;
        const s = (v.swell + t * (w.swell - v.swell)) * Math.exp(-e2 / (SWELL_WIDTH * SWELL_WIDTH));
        if (s > swell) swell = s;
      }
      total = Math.max(total, volcano + swell);
    }
    return total;
  }

  return { hotspotIn, near, effectAt };
}
