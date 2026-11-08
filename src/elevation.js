// Elevation: a coarse grid of random elevations, smoothed, refined by finer square levels.
//
// - Every GRID miles there is a grid point (i, j). Coordinates are in miles; grid point
//   (i, j) sits at (i * GRID, j * GRID).
// - Each grid point gets a raw elevation from a seeded hash: deterministic, so the same
//   seed and point always give the same number.
// - On top of that, each grid point gets a small random bias from each larger square it sits
//   in (10K, 100K, 1M miles, ...). More levels apply farther from the origin.
// - Its *average* elevation is the plain (uniform) average of its own raw value and its
//   neighbours' (the 8 around it, or for a random third of squares everything two squares
//   out), so neighbouring points pull each other together.
// - Each 1,000-mile square is centred on its grid point and split into finer levels of
//   squares (500, 100, 20, 4, 0.8, 0.1 mi; see LEVELS). A square's value is what it inherits from
//   its parent plus its own bias (an average of the raw values around it, same rule).
//   Squares near their parent's edge inherit an average of the parent values around them,
//   so steps between parents become ramps (edge blending).

export const GRID = 1000; // miles

// Raw elevations are roughly normally distributed. Averaging shrinks the spread to about
// 0.33x (narrow) or 0.2x (wide), so averages are about -500 ± 1150 m before biases.
export const RAW_MEAN = -500; // m
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

/** Index of the parent (level L-1) of level-L square (a, b). */
export const parentOf = (L, a, b) => {
  const r = Math.round(LEVELS[L - 1].size / LEVELS[L].size); // exact integer (sizes like 0.8 / 0.1)
  return [Math.floor(a / r), Math.floor(b / r)];
};

// Smoothing: a plain (uniform) average. Most squares average themselves with the 8 squares
// around them (radius 1); WIDE_FRACTION of squares, chosen at random per square, average
// everything up to two squares out (radius 2).
export const WIDE_FRACTION = 1 / 3;

/** Deterministic hash of (seed, i, j, k) -> [0, 1). */
function hash(seed, i, j, k) {
  let h = Math.imul(seed | 0, 0x27d4eb2d) ^ Math.imul(i | 0, 0x165667b1) ^ Math.imul(j | 0, 0x9e3779b1) ^ Math.imul(k | 0, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

function seedFromString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * @param seedInput  seed (string or number)
 * @param options.wideFraction  share of squares using the wide blend (default WIDE_FRACTION)
 */
export function createElevation(seedInput = 'dnd', { wideFraction = WIDE_FRACTION } = {}) {
  const seed = typeof seedInput === 'number' ? seedInput : seedFromString(String(seedInput));
  const avgCache = new Map();

  /** Standard normal random value for (i, j) on channel k (Box–Muller from two hashes). */
  function normal(i, j, k) {
    const u1 = Math.max(1e-12, hash(seed, i, j, k));
    const u2 = hash(seed, i, j, k + 1);
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

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

  /** Raw (unsmoothed) elevation of grid point (i, j), in meters, including biases. */
  function raw(i, j) {
    let v = RAW_MEAN + RAW_STD * normal(i, j, 1);
    for (const b of biases(i * GRID, j * GRID)) v += b;
    return v;
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

  /** Average (smoothed) elevation of grid point (i, j), in meters. */
  function average(i, j) {
    const key = i + ',' + j;
    let v = avgCache.get(key);
    if (v !== undefined) return v;
    v = blend(0, i, j, raw);
    avgCache.set(key, v);
    if (avgCache.size > 100000) avgCache.delete(avgCache.keys().next().value);
    return v;
  }

  /** Raw (pre-smoothing) value of level-L square (a, b), in meters (L >= 1). */
  function levelRaw(L, a, b) {
    return LEVELS[L].rawStd * normal(a, b, 200 + 10 * L);
  }

  /** Bias of level-L square (a, b): plain average of the raw values around it. */
  function bias(L, a, b) {
    return blend(L, a, b, (x, y) => levelRaw(L, x, y));
  }

  /**
   * What level-L square (a, b) inherits from the level above: the average parent value of
   * the squares up to edgeRadius around it (edge blending). For interior squares that's
   * just their own parent's value; near a parent's edge it ramps toward the neighbour.
   */
  function inherited(L, a, b) {
    const r = LEVELS[L].edgeRadius;
    let v = 0;
    for (let db = -r; db <= r; db++) {
      for (let da = -r; da <= r; da++) v += value(L - 1, ...parentOf(L, a + da, b + db));
    }
    return v / ((2 * r + 1) * (2 * r + 1));
  }

  const valueCache = new Map();
  /** Elevation (m) of level-L square (a, b): inherited value plus own bias (level 0: average). */
  function value(L, a, b) {
    if (L === 0) return average(a, b);
    const key = L + ':' + a + ',' + b;
    let v = valueCache.get(key);
    if (v !== undefined) return v;
    v = inherited(L, a, b) + bias(L, a, b);
    valueCache.set(key, v);
    if (valueCache.size > 300000) valueCache.delete(valueCache.keys().next().value);
    return v;
  }

  /** Value of level-L square (a, b) if it's already computed, else undefined (no work done). */
  function peek(L, a, b) {
    return L === 0 ? avgCache.get(a + ',' + b) : valueCache.get(L + ':' + a + ',' + b);
  }

  return { average, raw, levelRaw, biases, value, peek, inherited, bias, isWide, wideFraction, seed };
}
