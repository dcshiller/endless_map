// Tectonic plates: decided first, then turned into elevation adjustments for the
// 1,000-mile squares.
//
// - Plate seeds: each PLATE_CELL x PLATE_CELL region holds one seed at a random spot,
//   except a random share of regions hold none (their area goes to neighbouring plates,
//   so plate sizes vary). Each seed also has a reach, mostly small but occasionally huge,
//   so a few plates grow far bigger than the rest. Every 1,000-mile square belongs to the
//   plate whose seed is nearest after subtracting reach (a power diagram: distance² −
//   reach²), so boundaries stay straight lines.
// - Each plate has a random direction and speed, and is continental or oceanic.
// - Plate base: continental plates sit high, oceanic plates low.
// - Boundaries: from the two plates' motions, how hard they push together (convergence > 0)
//   or pull apart (< 0) across the boundary. The effect depends on the plate types and
//   fades with distance from the boundary (see BOUNDARY).

import { hash, keyOf } from './random.js';

export const PLATE_CELL = 5000;        // miles: one plate seed per region this size...
export const PLATE_SEED_CHANCE = 0.65; // ...with this chance (else neighbours take over)
export const CONTINENTAL_CHANCE = 0.4; // share of plates that are continental
export const CONTINENT_BASE = 1000;     // m added to squares on continental plates
export const OCEAN_BASE = -1600;       // m added to squares on oceanic plates
export const MIN_SPEED = 0.3, MAX_SPEED = 1; // plate speeds (relative units)
export const MAX_REACH = 9000;         // miles: the largest reach a plate seed can have...
export const REACH_SKEW = 3;           // ...drawn as MAX_REACH * u^REACH_SKEW (mostly small)
const SEARCH = 4;                      // plate regions searched on each side (covers MAX_REACH)

// Boundary effects, in metres per unit of convergence (relative speed across the
// boundary, typically 0–1.5), fading as exp(-(distance / width)^2).
export const BOUNDARY = {
  width: 800,                 // miles
  continentCollision: 3000,   // continent meets continent: mountain belt both sides
  continentOverOcean: 2500,   // continent side where an ocean plate dives under it
  oceanTrench: -1500,         // ocean side of that, narrower (width / 2)
  islandArc: 1500,            // ocean meets ocean
  midOceanRidge: 1200,        // two oceanic plates pulling apart
  rift: -800,                 // pulling apart where a continent is involved
};

/** Kind of boundary between plates A and B with convergence c (from A's side). */
export function boundaryKind(A, B, c) {
  if (Math.abs(c) < 0.15) return 'transform';
  if (c > 0) {
    if (A.continental && B.continental) return 'collision';
    if (A.continental || B.continental) return 'subduction';
    return 'island arc';
  }
  return A.continental || B.continental ? 'rift' : 'mid-ocean ridge';
}

/**
 * @param seed  numeric seed
 * @param GRID  size (miles) of the squares that plates are assigned to (1,000)
 */
export function createPlates(seed, GRID) {
  const plateCache = new Map(); // "p,q" -> plate or null
  const squareCache = new Map(); // "i,j" -> tectonics of that 1,000-mile square

  /** The plate seeded in region (p, q), or null if that region has no seed. */
  function plateIn(p, q) {
    const key = keyOf(p, q);
    let pl = plateCache.get(key);
    if (pl !== undefined) return pl;
    pl = null;
    if (hash(seed, p, q, 600) < PLATE_SEED_CHANCE) {
      const angle = 2 * Math.PI * hash(seed, p, q, 603);
      const speed = MIN_SPEED + (MAX_SPEED - MIN_SPEED) * hash(seed, p, q, 604);
      pl = {
        id: p + ',' + q, p, q,
        // Seed point somewhere in the middle 80% of the region.
        sx: (p + 0.1 + 0.8 * hash(seed, p, q, 601)) * PLATE_CELL - GRID / 2,
        sy: (q + 0.1 + 0.8 * hash(seed, p, q, 602)) * PLATE_CELL - GRID / 2,
        reach: MAX_REACH * hash(seed, p, q, 606) ** REACH_SKEW,
        angle, speed, vx: speed * Math.cos(angle), vy: speed * Math.sin(angle),
        continental: hash(seed, p, q, 605) < CONTINENTAL_CHANCE,
      };
    }
    plateCache.set(key, pl);
    return pl;
  }

  /** Convergence of A and B across their boundary (> 0: pushing together). */
  function convergence(A, B) {
    const nx = B.sx - A.sx, ny = B.sy - A.sy;
    const len = Math.hypot(nx, ny);
    return ((A.vx - B.vx) * nx + (A.vy - B.vy) * ny) / len;
  }

  /**
   * Tectonics of 1,000-mile square (i, j): its plate, the nearest other plate, the
   * distance to their boundary, the convergence, and the resulting elevation adjustment.
   */
  function at(i, j) {
    const key = keyOf(i, j);
    let t = squareCache.get(key);
    if (t) return t;
    const x = i * GRID, y = j * GRID;
    const p0 = Math.floor((x + GRID / 2) / PLATE_CELL), q0 = Math.floor((y + GRID / 2) / PLATE_CELL);
    let A = null, B = null, dA = Infinity, dB = Infinity;
    for (let q = q0 - SEARCH; q <= q0 + SEARCH; q++) {
      for (let p = p0 - SEARCH; p <= p0 + SEARCH; p++) {
        const pl = plateIn(p, q);
        if (!pl) continue;
        const d = (pl.sx - x) ** 2 + (pl.sy - y) ** 2 - pl.reach ** 2; // power distance
        if (d < dA) { B = A; dB = dA; A = pl; dA = d; }
        else if (d < dB) { B = pl; dB = d; }
      }
    }
    // Distance to the boundary with B: a straight line perpendicular to the two seeds
    // (power diagram), at this distance from the square.
    const dist = (dB - dA) / (2 * Math.hypot(B.sx - A.sx, B.sy - A.sy));
    const c = convergence(A, B);
    const kind = boundaryKind(A, B, c);
    const fade = (w) => Math.exp(-((dist / w) ** 2));
    const W = BOUNDARY.width;
    let boundary = 0;
    if (kind === 'collision') boundary = BOUNDARY.continentCollision * c * fade(W);
    else if (kind === 'subduction') {
      boundary = A.continental ? BOUNDARY.continentOverOcean * c * fade(W) : BOUNDARY.oceanTrench * c * fade(W / 2);
    } else if (kind === 'island arc') boundary = BOUNDARY.islandArc * c * fade(W);
    else if (kind === 'mid-ocean ridge') boundary = BOUNDARY.midOceanRidge * -c * fade(W);
    else if (kind === 'rift') boundary = BOUNDARY.rift * -c * fade(W);
    const base = A.continental ? CONTINENT_BASE : OCEAN_BASE;
    t = { plate: A, other: B, dist, convergence: c, kind, base, boundary, total: base + boundary };
    squareCache.set(key, t);
    if (squareCache.size > 100000) squareCache.delete(squareCache.keys().next().value);
    return t;
  }

  return { at, plateIn, convergence };
}
