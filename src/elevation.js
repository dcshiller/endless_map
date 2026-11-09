// Elevation: a coarse grid of random elevations, smoothed, refined by finer square levels.
//
// - Every GRID miles there is a grid point (i, j). Coordinates are in miles; grid point
//   (i, j) sits at (i * GRID, j * GRID).
// - Each grid point gets a raw elevation from a seeded hash: deterministic, so the same
//   seed and point always give the same number.
// - On top of that, each grid point gets a small random bias from each larger square it sits
//   in (10K, 100K, 1M miles, ...; more levels apply farther from the origin), and its
//   plate's base (see plates.js): continental plates high, oceanic low. After smoothing,
//   plate-boundary effects are added: mountains where plates collide, ridges or rifts
//   where they pull apart.
// - Its *average* elevation is the plain (uniform) average of its own raw value and its
//   neighbours' (the 8 around it, or for a random third of squares everything two squares
//   out), so neighbouring points pull each other together.
// - Each 1,000-mile square is centred on its grid point and split into finer levels of
//   squares (500, 100, 20, 4, 0.8, 0.1 mi; see LEVELS). A square's value is what it inherits from
//   its parent plus its own bias (an average of the raw values around it, same rule).
//   Squares near their parent's edge inherit an average of the parent values around them,
//   so steps between parents become ramps (edge blending).
// - Under the sea, finer levels' own biases are damped by depth (see seaRoughness): a bit
//   smoother near the coast, near-featureless abyssal plains in the deep. Ridges, trenches
//   and hotspots aren't damped, so they stand out.
// - Continental shelf: drowned squares on continental plates are raised toward sea level;
//   final values below sea level settle toward a flat abyss about 4 km down (ABYSS_DEPTH).
// - From the 100-mile squares down, hotspot volcanoes are added on top of each square's
//   value (not inherited), see hotspots.js.

import { hash, normal as normalRandom, seedFromString, keyOf } from './random.js';
import { createPlates } from './plates.js';
import { createHotspots } from './hotspots.js';
import { createClimate } from './climate.js';

export const GRID = 1000; // miles

// Raw elevations are roughly normally distributed around 0, plus the plate base
// (continental plates high, oceanic low; see plates.js). Plate-boundary effects (mountain
// belts, ridges, rifts, trenches) are added after smoothing (see average()).
// Averaging shrinks the random spread to about 0.33x (narrow) or 0.2x (wide), ±1150 m.
export const RAW_MEAN = 0;    // m
export const RAW_STD = 4000;  // m

// Bias squares: every grid point inside a square of a bias level gets that square's random
// bias (normally distributed) added to its raw value. Levels are powers of ten in size:
// level L has squares of BIAS_BASE_SIZE * 10^L miles and standard deviation
// BIAS_BASE_STD / 2^L m — small next to square-by-square randomness, so square edges
// don't show. The first BIAS_MIN_LEVELS levels always apply; each further level applies
// once a point is at least that level's square size away from (0, 0).
export const BIAS_BASE_SIZE = 10_000; // miles
export const BIAS_BASE_STD = 400;     // m
export const BIAS_MIN_LEVELS = 3;

/** Square size (miles) of bias level L. */
export const biasSize = (L) => BIAS_BASE_SIZE * 10 ** L;

/** Number of bias levels that apply at distance d (miles) from the origin. */
export function biasLevelsAt(d) {
  let n = BIAS_MIN_LEVELS;
  while (d >= biasSize(n)) n++;
  return n;
}

// Square levels, coarsest first. Level 0 is the 1,000-mile squares (values = grid-point
// averages, above). Each finer level splits its parent evenly (size must divide the
// parent's size). A square's value is what it inherits from its parent plus its own bias:
// the average of the raw values around it, which have spread rawStd. Averaging shrinks the
// spread to ~0.33x (narrow) or ~0.2x (wide), so biases are about ±0.29 * rawStd.
// edgeRadius: a square inherits the average parent value of the squares up to edgeRadius
// away (interior squares are unaffected: all their neighbours share one parent).
// Finer levels are only computed when zoomed in far enough to see them.
export const LEVELS = [
  { size: GRID },                               // 1,000 mi
  { size: 500, rawStd: 2000, edgeRadius: 1 },   // biases ≈ ±580 m; 2x2 per parent
  { size: 100, rawStd: 1000, edgeRadius: 2 },   // biases ≈ ±290 m; 5x5 per parent
  { size: 20, rawStd: 500, edgeRadius: 2 },     // biases ≈ ±145 m; 5x5 per parent
  { size: 4, rawStd: 250, edgeRadius: 2 },      // biases ≈ ±70 m;  5x5 per parent
  { size: 0.8, rawStd: 120, edgeRadius: 2 },    // biases ≈ ±35 m;  5x5 per parent
  { size: 0.1, rawStd: 60, edgeRadius: 2 },     // biases ≈ ±17 m;  8x8 per parent
];

// Square (a, b) of a level with size S spans x in [a*S - GRID/2, (a+1)*S - GRID/2), same
// for y. The offset makes level-0 square i centred on grid point i, and every level tiles
// its parent exactly.

/** Index of the level-L square containing (x, y) miles. */
export const squareAt = (L, x, y) => {
  const S = LEVELS[L].size;
  return [Math.floor((x + GRID / 2) / S), Math.floor((y + GRID / 2) / S)];
};

/** Centre (miles) of level-L square (a, b). */
export const squareCentre = (L, a, b) => {
  const S = LEVELS[L].size;
  return [a * S - GRID / 2 + S / 2, b * S - GRID / 2 + S / 2];
};

/** Squares per parent side at each level (RATIO[0] unused). */
const RATIO = LEVELS.map((lv, L) => (L ? Math.round(LEVELS[L - 1].size / lv.size) : 1));

/** Index of the parent (level L-1) of level-L square (a, b). */
export const parentOf = (L, a, b) => {
  const r = Math.round(LEVELS[L - 1].size / LEVELS[L].size); // exact integer (sizes like 0.8 / 0.1)
  return [Math.floor(a / r), Math.floor(b / r)];
};

/** Store v in cache under key, dropping the oldest entry beyond max. */
function remember(cache, key, v, max) {
  cache.set(key, v);
  if (cache.size > max) cache.delete(cache.keys().next().value);
}

// All levels are computed in blocks of TILE x TILE squares (see computeTile);
// up to TILE_STORE_MAX blocks per level are kept.
export const TILE = 16;
const TILE_STORE_MAX = 4000;

// Smoothing: a plain (uniform) average. Most squares average themselves with the 8 squares
// around them (radius 1); WIDE_FRACTION of squares, chosen at random per square, average
// everything up to two squares out (radius 2).
export const WIDE_FRACTION = 1 / 3;

// Sea floor: below sea level, each finer square's own bias is scaled by a roughness that
// eases from COAST_ROUGHNESS just under the surface to DEEP_ROUGHNESS at DEEP_DEPTH and
// below. Land keeps full roughness.
export const COAST_ROUGHNESS = 0.6;
export const DEEP_ROUGHNESS = 0.08;
export const DEEP_DEPTH = -1500; // m

/** Roughness (multiplier on a square's own bias) for a square inheriting elevation h. */
export function seaRoughness(h) {
  if (h >= 0) return 1;
  const t = Math.min(1, h / DEEP_DEPTH);
  const s = t * t * (3 - 2 * t); // smoothstep
  return COAST_ROUGHNESS + (DEEP_ROUGHNESS - COAST_ROUGHNESS) * s;
}

// Sea floor profile: real ocean is a shallow shelf along the coast, a steep slope, then a
// flat abyssal plain about 4 km down. Every square's final depth d (below sea level) is
// remapped:
// - shelf: down to SHELF_EDGE, depths are halved (so shelves are at most ~200 m deep);
// - beyond: a drop that settles toward ABYSS_DEPTH over ABYSS_RAMP, plus a small share
//   (ABYSS_TAIL) of the remaining depth so trenches stay deeper still.
// Applied to final values only (never inherited) and never changes sign, so coastlines
// don't move.
export const SHELF_EDGE = -400;   // m (before remapping)
export const ABYSS_DEPTH = -3800; // m
export const ABYSS_RAMP = 300;    // m: depth scale over which the slope drops to the abyss
export const ABYSS_TAIL = 0.15;

/** Ocean depth remap (see SHELF_EDGE, ABYSS_DEPTH). */
export function abyss(d) {
  if (d >= SHELF_EDGE) return d >= 0 ? d : d * 0.5;
  const top = SHELF_EDGE * 0.5, e = d - SHELF_EDGE;
  return top + (ABYSS_DEPTH - top) * (1 - Math.exp(e / ABYSS_RAMP)) + ABYSS_TAIL * e;
}

// Continental shelf: a 1,000-mile square on a continental plate that ends up below sea level
// keeps only this share of its depth (continental crust is thick and floats high, so
// drowned continent is shallow sea). Oceanic plates are unaffected, so the drop to the deep
// comes at the edge of the continental plate.
export const SHELF_DEPTH_SCALE = 0.3;

// Hotspot volcanoes (see hotspots.js) are added from this level down: the 100-mile squares.
export const HOTSPOT_MIN_LEVEL = 2;

// Weather (steered wind, later moisture) is coarse-grained: one value per square of this
// level, the 500-mile squares.
export const WEATHER_LEVEL = 1;

/**
 * @param seedInput  seed (string or number)
 * @param options.wideFraction  share of squares using the wide blend (default WIDE_FRACTION)
 */
export function createElevation(seedInput = 'dnd', { wideFraction = WIDE_FRACTION } = {}) {
  const seed = typeof seedInput === 'number' ? seedInput : seedFromString(String(seedInput));
  const plates = createPlates(seed, GRID);
  const hotspots = createHotspots(seed, plates, GRID);
  // Weather lives on the 500-mile squares (level WEATHER_LEVEL); it reads their elevations
  // for steering but doesn't affect elevation.
  const climate = createClimate(seed, {
    size: LEVELS[WEATHER_LEVEL].size,
    squareAt: (x, y) => squareAt(WEATHER_LEVEL, x, y),
    centre: (a, b) => squareCentre(WEATHER_LEVEL, a, b),
    height: (a, b) => value(WEATHER_LEVEL, a, b),
  });

  /** Standard normal random value for (i, j) on channel k. */
  const normal = (i, j, k) => normalRandom(seed, i, j, k);

  /** Bias (m) of the level-L square with index (si, sj). */
  function squareBias(L, si, sj) {
    return (BIAS_BASE_STD / 2 ** L) * normal(si, sj, 100 + 2 * L);
  }

  /** Biases (one per applicable level) for the squares containing point (x, y) miles. */
  function biases(x, y) {
    const n = biasLevelsAt(Math.hypot(x, y));
    const out = [];
    for (let L = 0; L < n; L++) out.push(squareBias(L, Math.floor(x / biasSize(L)), Math.floor(y / biasSize(L))));
    return out;
  }

  /** Raw (unsmoothed) elevation of grid point (i, j), in meters: random + biases + plate base. */
  function raw(i, j) {
    let v = RAW_MEAN + RAW_STD * normal(i, j, 1);
    // Same as summing biases(x, y), without building the array.
    const x = i * GRID, y = j * GRID, n = biasLevelsAt(Math.hypot(x, y));
    for (let L = 0; L < n; L++) v += squareBias(L, Math.floor(x / biasSize(L)), Math.floor(y / biasSize(L)));
    return v + plates.at(i, j).base;
  }

  /** Does square (a, b) at level L use the wide (two-squares-out) blend? */
  function isWide(L, a, b) {
    return hash(seed, a, b, 300 + L) < wideFraction;
  }

  /** Plain average of rawFn over the neighbourhood of (a, b): radius 1, or 2 if wide. */
  function blend(L, a, b, rawFn) {
    const r = isWide(L, a, b) ? 2 : 1;
    let v = 0;
    for (let db = -r; db <= r; db++) {
      for (let da = -r; da <= r; da++) v += rawFn(a + da, b + db);
    }
    return v / ((2 * r + 1) * (2 * r + 1));
  }

  /**
   * Average (smoothed) elevation of grid point (i, j), in meters, plus its plate-boundary
   * effect. The boundary effect is added after smoothing: it's already smooth (it fades
   * with distance), and averaging across a boundary would cancel mountain belts against
   * the other plate's lowlands. Drowned squares on continental plates are made shallow
   * (the continental shelf, SHELF_DEPTH_SCALE).
   */
  function average(i, j) {
    return core(0, i, j);
  }

  /** Raw (pre-smoothing) value of level-L square (a, b), in meters (L >= 1). */
  function levelRaw(L, a, b) {
    return LEVELS[L].rawStd * normal(a, b, 200 + 10 * L);
  }

  /** Undamped bias of level-L square (a, b): plain average of the raw values around it. */
  function rawBias(L, a, b) {
    return blend(L, a, b, (x, y) => levelRaw(L, x, y));
  }

  /** Bias of level-L square (a, b) as applied: damped under the sea (seaRoughness). */
  function bias(L, a, b) {
    return rawBias(L, a, b) * seaRoughness(inherited(L, a, b));
  }

  /**
   * What level-L square (a, b) inherits from the level above: the average parent value of
   * the squares up to edgeRadius around it (edge blending). For interior squares that's
   * just their own parent's value; near a parent's edge it ramps toward the neighbour.
   * Uses the parents' values without hotspot volcanoes (those are added per square).
   */
  function inherited(L, a, b) {
    // The (2r+1)^2 neighbours fall in at most 2 parent columns and 2 parent rows, so look
    // up each distinct parent once, weighted by how many neighbours it covers.
    const r = LEVELS[L].edgeRadius, n = RATIO[L];
    const pa0 = Math.floor((a - r) / n), pa1 = Math.floor((a + r) / n);
    const pb0 = Math.floor((b - r) / n), pb1 = Math.floor((b + r) / n);
    if (pa0 === pa1 && pb0 === pb1) return core(L - 1, pa0, pb0); // interior: one parent
    let v = 0;
    for (let pb = pb0; pb <= pb1; pb++) {
      const wb = Math.min(b + r, pb * n + n - 1) - Math.max(b - r, pb * n) + 1;
      for (let pa = pa0; pa <= pa1; pa++) {
        const wa = Math.min(a + r, pa * n + n - 1) - Math.max(a - r, pa * n) + 1;
        v += wa * wb * core(L - 1, pa, pb);
      }
    }
    return v / ((2 * r + 1) * (2 * r + 1));
  }

  // All levels are computed and stored a TILE x TILE block at a time: the block's
  // raw values are generated once into an array (instead of once per neighbour that uses
  // them), and results live in typed arrays (no per-square cache entries). Each square is
  // still computed exactly as described above, in the same order, so values are identical.
  const tileStores = LEVELS.map(() => new Map()); // per level: tile key -> { core, value }

  /** The computed tile (ta, tb) of level L. */
  function tileOf(L, ta, tb) {
    const store = tileStores[L], key = keyOf(ta, tb);
    let t = store.get(key);
    if (!t) { t = computeTile(L, ta, tb); remember(store, key, t, TILE_STORE_MAX); }
    return t;
  }

  function computeTile(L, ta, tb) {
    const a0 = ta * TILE, b0 = tb * TILE, W = TILE + 4; // raw values with a 2-square margin
    const raws = new Float64Array(W * W);
    if (L === 0) {
      for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) raws[j * W + i] = raw(a0 - 2 + i, b0 - 2 + j);
    } else {
      const std = LEVELS[L].rawStd, channel = 200 + 10 * L;
      for (let j = 0; j < W; j++) {
        for (let i = 0; i < W; i++) raws[j * W + i] = std * normal(a0 - 2 + i, b0 - 2 + j, channel);
      }
    }
    const cores = new Float64Array(TILE * TILE), values = new Float64Array(TILE * TILE);
    const volcanoes = L >= HOTSPOT_MIN_LEVEL;
    // Parent values covering the tile and its edge-blending margin, looked up once (same
    // sums as inherited(), read from this array).
    let parents, pa0, pb0, PW, n, er;
    if (L > 0) {
      n = RATIO[L]; er = LEVELS[L].edgeRadius;
      pa0 = Math.floor((a0 - er) / n); pb0 = Math.floor((b0 - er) / n);
      PW = Math.floor((a0 + TILE - 1 + er) / n) - pa0 + 1;
      const PH = Math.floor((b0 + TILE - 1 + er) / n) - pb0 + 1;
      parents = new Float64Array(PW * PH);
      for (let pj = 0; pj < PH; pj++) for (let pi = 0; pi < PW; pi++) parents[pj * PW + pi] = core(L - 1, pa0 + pi, pb0 + pj);
    }
    for (let j = 0; j < TILE; j++) {
      for (let i = 0; i < TILE; i++) {
        const a = a0 + i, b = b0 + j, q = j * TILE + i;
        // Own bias: plain average of the raw values around (same as rawBias).
        const r = isWide(L, a, b) ? 2 : 1;
        let sum = 0;
        for (let db = -r; db <= r; db++) {
          const row = (j + 2 + db) * W + i + 2;
          for (let da = -r; da <= r; da++) sum += raws[row + da];
        }
        const smoothed = sum / ((2 * r + 1) * (2 * r + 1));
        let c;
        if (L === 0) {
          // The 1,000-mile average, plus plate boundary effects and the continental shelf.
          const t = plates.at(a, b);
          c = smoothed + t.boundary;
          if (c < 0 && t.plate.continental) c *= SHELF_DEPTH_SCALE;
        } else {
          // Same as inherited(L, a, b).
          const qa0 = Math.floor((a - er) / n), qa1 = Math.floor((a + er) / n);
          const qb0 = Math.floor((b - er) / n), qb1 = Math.floor((b + er) / n);
          let inh;
          if (qa0 === qa1 && qb0 === qb1) inh = parents[(qb0 - pb0) * PW + (qa0 - pa0)];
          else {
            inh = 0;
            for (let pb = qb0; pb <= qb1; pb++) {
              const wb = Math.min(b + er, pb * n + n - 1) - Math.max(b - er, pb * n) + 1;
              for (let pa = qa0; pa <= qa1; pa++) {
                const wa = Math.min(a + er, pa * n + n - 1) - Math.max(a - er, pa * n) + 1;
                inh += wa * wb * parents[(pb - pb0) * PW + (pa - pa0)];
              }
            }
            inh /= (2 * er + 1) * (2 * er + 1);
          }
          c = inh + smoothed * seaRoughness(inh);
        }
        cores[q] = c;
        values[q] = abyss(c) + (volcanoes ? hotspot(L, a, b) : 0);
      }
    }
    return { core: cores, value: values };
  }

  /** Elevation (m) of level-L square (a, b) without hotspot volcanoes: inherited + own bias. */
  function core(L, a, b) {
    const ta = Math.floor(a / TILE), tb = Math.floor(b / TILE);
    return tileOf(L, ta, tb).core[(b - tb * TILE) * TILE + (a - ta * TILE)];
  }

  /**
   * Hotspot volcano height (m) on level-L square (a, b), from HOTSPOT_MIN_LEVEL down
   * (coarser squares are far wider than a volcano). Measured at the square's centre and
   * kept out of inheritance, so it's exact at every zoom.
   */
  function hotspot(L, a, b) {
    if (L < HOTSPOT_MIN_LEVEL) return 0;
    return hotspots.effectAt(...squareCentre(L, a, b), LEVELS[L].size);
  }

  /**
   * Elevation (m) of level-L square (a, b): core value with the ocean settled toward the
   * abyss, plus hotspot volcanoes (which rise from the abyss floor).
   */
  function value(L, a, b) {
    const ta = Math.floor(a / TILE), tb = Math.floor(b / TILE);
    return tileOf(L, ta, tb).value[(b - tb * TILE) * TILE + (a - ta * TILE)];
  }

  /**
   * Store tile (ta, tb) of level L computed elsewhere (by a worker running the same model
   * with the same settings): { core, value } typed arrays as computeTile returns.
   */
  function importTile(L, ta, tb, t) {
    const store = tileStores[L], key = keyOf(ta, tb);
    if (!store.has(key)) remember(store, key, t, TILE_STORE_MAX);
  }

  /** Is tile (ta, tb) of level L already computed (or imported)? */
  const hasTile = (L, ta, tb) => tileStores[L].has(keyOf(ta, tb));

  /** Value of level-L square (a, b) if it's already computed, else undefined (no work done). */
  function peek(L, a, b) {
    const ta = Math.floor(a / TILE), tb = Math.floor(b / TILE);
    const t = tileStores[L].get(keyOf(ta, tb));
    return t ? t.value[(b - tb * TILE) * TILE + (a - ta * TILE)] : undefined;
  }

  return { tile: tileOf, importTile, hasTile, average, raw, levelRaw, biases, value, core, hotspot, peek, inherited, bias, rawBias, isWide, wideFraction, plates, hotspots, climate, seed };
}
