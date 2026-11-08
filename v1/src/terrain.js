// Deterministic topography: (x, y) in miles -> elevation in meters (sea level = 0).
//
// The world is infinite, so nothing here can be simulated globally (no plate tectonics,
// no drainage-basin erosion). Instead each point is computed from layered noise designed
// to mimic the *statistics* of real terrain:
//
//   1. Continentalness  — very low-frequency, domain-warped fBm. Mapped through a
//                         hypsometric curve: abyssal plain -> continental slope -> shelf
//                         -> coastal plain -> interior uplands. This produces the
//                         bimodal elevation distribution real planets have.
//   2. Mountain ranges  — explicit spine polylines (see ranges.js), clustered into
//                         provinces, each belt with its own peak height. Height falls off
//                         with distance to the spine; ridged noise adds crests and cols.
//   3. Hills / relief   — derivative-damped fBm ("erosion fBm"): fine detail is suppressed
//                         on steep slopes, which reads as eroded valleys and spurs.
//                         Amplitude is modulated by a roughness field, giving both flat
//                         plains and rugged uplands.
//
// The `px` argument (miles per pixel) is a level-of-detail hint: octaves smaller than a
// pixel are skipped (with a fractional last octave, so detail fades in smoothly).
// Coarse octaves are identical at every LOD, so features don't move when you zoom.

import { createSimplex2D, hashString } from './noise.js';
import { createRanges } from './ranges.js';

const ROT_C = 0.8; // per-octave rotation (~36.87°) hides lattice alignment
const ROT_S = 0.6;

function clamp(x, a, b) {
  return x < a ? a : x > b ? b : x;
}
function smoothstep(a, b, x) {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Number of octaves (fractional) needed so the finest one is ~2 pixels wide. */
function octavesFor(wavelength, px, max) {
  return clamp(Math.log2(wavelength / (2 * px)) + 1, 1, max);
}

/** Plain fBm. Not normalized, so truncating octaves never changes coarse structure. */
function fbm(noise, x, y, octaves, gain) {
  let sum = 0, amp = 1;
  const n = Math.ceil(octaves);
  for (let i = 0; i < n; i++) {
    const w = i === n - 1 ? octaves - i : 1;
    sum += amp * w * noise(x, y);
    const nx = (ROT_C * x - ROT_S * y) * 2 + 13.7;
    y = (ROT_S * x + ROT_C * y) * 2 - 7.3;
    x = nx;
    amp *= gain;
  }
  return sum;
}

/** Musgrave ridged multifractal, roughly [0, 1.3]. */
function ridged(noise, x, y, octaves, gain) {
  let sum = 0, amp = 1, weight = 1;
  const n = Math.ceil(octaves);
  for (let i = 0; i < n; i++) {
    const w = i === n - 1 ? octaves - i : 1;
    let s = 1 - Math.abs(noise(x, y));
    s *= s;
    s *= weight;
    weight = clamp(s * 2, 0, 1);
    sum += s * amp * w;
    const nx = (ROT_C * x - ROT_S * y) * 2 + 5.1;
    y = (ROT_S * x + ROT_C * y) * 2 + 11.9;
    x = nx;
    amp *= gain;
  }
  return sum;
}

/** Derivative-damped fBm (after Inigo Quilez): high octaves fade on steep slopes. */
const D = new Float64Array(2);
function erodedFbm(sd, x, y, octaves, damp) {
  let sum = 0, amp = 1, dx = 0, dy = 0;
  const n = Math.ceil(octaves);
  for (let i = 0; i < n; i++) {
    const w = i === n - 1 ? octaves - i : 1;
    const v = sd.noiseD(x, y, D);
    dx += D[0] * amp * damp;
    dy += D[1] * amp * damp;
    sum += (amp * w * v) / (1 + dx * dx + dy * dy);
    const nx = (ROT_C * x - ROT_S * y) * 2 + 3.7;
    y = (ROT_S * x + ROT_C * y) * 2 - 1.9;
    x = nx;
    amp *= 0.5;
  }
  return sum;
}

/** Monotone cubic (Fritsch–Carlson) interpolation through control points. */
function monotoneSpline(points) {
  const n = points.length;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const d = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  const m = new Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i];
    const h = a * a + b * b;
    if (h > 9) {
      const t = 3 / Math.sqrt(h);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  return function (x) {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i];
    const t = (x - xs[i]) / h;
    const t2 = t * t, t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * ys[i] +
      (t3 - 2 * t2 + t) * h * m[i] +
      (-2 * t3 + 3 * t2) * ys[i + 1] +
      (t3 - t2) * h * m[i + 1]
    );
  };
}

// Continentalness -> base elevation (m). Shape follows Earth's hypsometric curve:
// broad abyssal plains, a steep continental slope, a flat shelf, then gently rising land.
const hypsometry = monotoneSpline([
  [-1.2, -5600],
  [-0.45, -4900],
  [-0.2, -3900],
  [-0.1, -1400],
  [-0.06, -180],
  [-0.01, -40],
  [0.0, -4],
  [0.03, 25],
  [0.12, 120],
  [0.3, 300],
  [0.6, 420],
  [1.2, 500],
  [3.0, 560],
]);
// Inland, height comes mostly from the regional uplift field below, not from
// continentalness — otherwise big continents become one monotonous high plateau.

export const PARAMS = {
  continentWavelengthBig: 4000,   // miles: regions of few, large continents
  continentWavelengthSmall: 1000, // miles: regions of many, small continents
  sizeWavelength: 10000,          // size of those regions
  coastDetailWavelength: 300,
  continentBias: -0.2,       // lower => more ocean
  macroWavelength: 55000,    // size of land-heavy vs. ocean-heavy regions (tuned so ~20% of
                             // 16384-mi squares at the widest zoom are >=80% land)
  macroStrength: 2.0,        // how strongly the macro field shifts the land/sea balance
  macroNeutral: 0.12,        // |macro| below this = balanced region (continent size shows)
  interiorHeight: 900,       // m, base height far from any coast
  interiorSaturation: 1500,  // miles inland at which the interior rise mostly levels off
  upliftWavelength: 2600,   // size of interior basins / plateaus
  upliftHeight: 800,         // m, typical high-plateau lift
  warpWavelength: 1400,
  warpAmplitude: 260,
  provinceWavelength: 16000, // size of mountain provinces (where ranges cluster)
  grainWavelength: 14000,    // how quickly range orientation changes across the world
  mountainWavelength: 160,   // spacing of individual crests
  hillWavelength: 140,
};

export function createTerrain(seedInput) {
  const base = typeof seedInput === 'number' ? seedInput >>> 0 : hashString(String(seedInput));
  const sub = (k) => createSimplex2D(hashString(base + ':' + k));
  const nWx = sub('warpx').noise;
  const nWy = sub('warpy').noise;
  const nC = sub('continent').noise;
  const nC2 = sub('continent-detail').noise;
  const nCs = sub('continent-small').noise;
  const nSize = sub('continent-size').noise;
  const nMacro = sub('macro').noise;
  const nUplift = sub('uplift').noise;
  const nProv = sub('mountain-province').noise;
  const nGrain = sub('tectonic-grain').noise;
  const nRwx = sub('ridge-warpx').noise;
  const nRwy = sub('ridge-warpy').noise;
  const nR = sub('ridge').noise;
  const nRough = sub('roughness').noise;
  const sH = sub('hills');

  const P = PARAMS;

  // Warped coordinates from the last continent() call (avoids allocating a result object).
  let wx = 0, wy = 0;

  /** Continentalness at (x, y): > 0 is land. Also sets wx, wy. */
  function continent(x, y, px) {
    const c = coarseContinent(x, y, px);
    // Fine octaves: fractal coastlines at every zoom. Not warped — warping smears them.
    const dw = P.coastDetailWavelength;
    return c + 0.9 * 0.52 ** 3 * fbm(nC2, x / dw, y / dw, octavesFor(dw, px, 10), 0.52);
  }

  /** Smooth large-scale continentalness (no coastline detail). Also sets wx, wy. */
  function coarseContinent(x, y, px) {
    // Large-scale domain warp: bends continents into organic shapes.
    wx = x + P.warpAmplitude * fbm(nWx, x / P.warpWavelength, y / P.warpWavelength, 4, 0.5);
    wy = y + P.warpAmplitude * fbm(nWy, x / P.warpWavelength, y / P.warpWavelength, 4, 0.5);

    // 1. Continents. Fine octaves make coastlines fractal at every zoom level.
    // Only the coarse octaves are warped; warping the fine ones smears coastlines.
    // Continent *size* varies by region: a ~10K-mile field blends between a long-wavelength
    // pattern (few big continents) and a short one (many small continents). The blend is
    // variance-normalized so the share of land doesn't change across the transition.
    const sz = fbm(nSize, x / P.sizeWavelength - 0.83, y / P.sizeWavelength + 0.29, 2, 0.5);
    const tBig = smoothstep(-0.25, 0.25, sz);
    const cwB = P.continentWavelengthBig, cwS = P.continentWavelengthSmall;
    let c = 0;
    if (tBig > 0) c += tBig * fbm(nC, wx / cwB, wy / cwB, Math.min(3, octavesFor(cwB, px, 3)), 0.52);
    if (tBig < 1) c += (1 - tBig) * fbm(nCs, wx / cwS, wy / cwS, Math.min(2, octavesFor(cwS, px, 2)), 0.52);
    c /= Math.sqrt(tBig * tBig + (1 - tBig) * (1 - tBig));
    // Macro field: a very-low-frequency regional sea-level shift. Where it is high,
    // continents merge into supercontinents; where low, open ocean with scattered islands.
    const mw0 = P.macroWavelength;
    const m0 = fbm(nMacro, x / mw0 + 0.37, y / mw0 - 0.61, 3, 0.55);
    // Three regimes: a neutral band (balanced land/sea, where continent size shows) and
    // strong shifts toward supercontinent or open ocean beyond it.
    const macro = Math.sign(m0) * smoothstep(P.macroNeutral, P.macroNeutral + 0.35, Math.abs(m0));
    return 0.9 * c + P.continentBias + P.macroStrength * macro;
  }

  // Mountain provinces: very-low-frequency field, so ranges cluster like oceans do.
  const province = (x, y) =>
    smoothstep(-0.05, 0.45, fbm(nProv, x / P.provinceWavelength + 0.5, y / P.provinceWavelength - 0.2, 2, 0.5));
  // Tectonic grain: the direction ranges run in, varying over thousands of miles.
  const grain = (x, y) => 0.6 * Math.PI * fbm(nGrain, x / P.grainWavelength, y / P.grainWavelength, 2, 0.5);
  const ranges = createRanges(base, province, (x, y) => continent(x, y, 200), grain);
  const M = { height: 0, influence: 0 };

  /**
   * Approximate distance (miles) from (x, y) inland to the coast, from the smooth
   * continent field: distance to its zero-set ≈ value / |gradient|. 0 at sea.
   */
  function coastDistance(x, y) {
    const h = 25;
    const c0 = coarseContinent(x, y, 200);
    if (c0 <= 0) return 0;
    const gx = (coarseContinent(x + h, y, 200) - c0) / h;
    const gy = (coarseContinent(x, y + h, 200) - c0) / h;
    const g = Math.sqrt(gx * gx + gy * gy);
    return Math.min(P.interiorSaturation * 2, c0 / Math.max(g, 1e-6));
  }

  function elevationWith(lines, x, y, px) {
    const dist = coastDistance(x, y); // before continent(): both set wx, wy
    const c = continent(x, y, px);
    let e = hypsometry(c);
    const interior = smoothstep(-0.02, 0.2, c);

    // Land rises with distance from the coast: coastal plain -> interior uplands.
    // (hypsometry alone flattens out a little way inland.)
    const inland = smoothstep(0, P.interiorSaturation, dist);
    if (c > 0) {
      e = Math.min(e, 90) + P.interiorHeight * (1 - Math.exp(-dist / (0.4 * P.interiorSaturation)));
    }

    // Regional uplift: lowland basins, uplands and high plateaus, mostly well inland.
    if (inland > 0) {
      const u = fbm(nUplift, wx / P.upliftWavelength, wy / P.upliftWavelength, 3, 0.5);
      e += inland * (u > 0 ? u * u * P.upliftHeight : u * 380);
      e = Math.max(e, 150 * inland); // interior basin floors stay above sea level
    }

    // 2. Mountain ranges from spine lines. A small warp makes crests and edges wander.
    const qx = x + 30 * fbm(nRwx, x / 220, y / 220, 3, 0.5);
    const qy = y + 30 * fbm(nRwy, x / 220, y / 220, 3, 0.5);
    ranges.sample(lines, qx, qy, M);
    if (M.height > 0) {
      const mw = P.mountainWavelength;
      const r = ridged(nR, qx / mw, qy / mw, octavesFor(mw, px, 12), 0.6);
      e += M.height * (0.6 + 0.55 * r);
    }
    const mInfl = M.influence;

    // 3. Hills and general relief. Roughness gives plains vs. rugged country.
    const rough = smoothstep(-0.35, 0.45, fbm(nRough, x / 650 - 4.4, y / 650 + 2.2, 3, 0.5));
    const hillAmp = (40 + 420 * rough) * (0.2 + 0.3 * interior + 0.5 * inland) + 1300 * mInfl;
    // Hills use only a gentle local warp; the continental warp would smear them.
    const hw = P.hillWavelength;
    const hx = x + 18 * fbm(nRwy, x / 90 + 7.7, y / 90, 2, 0.5);
    const hy = y + 18 * fbm(nRwx, x / 90, y / 90 - 3.1, 2, 0.5);
    e += hillAmp * erodedFbm(sH, hx / hw, hy / hw, octavesFor(hw, px, 14), 0.35);
    // Away from the coast, hills never dip below sea level (no lake speckle inland).
    if (c > 0.06) e = Math.max(e, 25);

    return e;
  }

  /** Region-level fields at (x, y), for tooling/debugging. */
  function debug(x, y) {
    const sz = fbm(nSize, x / P.sizeWavelength - 0.83, y / P.sizeWavelength + 0.29, 2, 0.5);
    const m0 = fbm(nMacro, x / P.macroWavelength + 0.37, y / P.macroWavelength - 0.61, 3, 0.55);
    const macro = Math.sign(m0) * smoothstep(P.macroNeutral, P.macroNeutral + 0.35, Math.abs(m0));
    return { tBig: smoothstep(-0.25, 0.25, sz), macro, dist: coastDistance(x, y) };
  }

  /** Elevation in meters at (x, y) miles. `px` = miles per pixel (LOD); omit for full detail. */
  function elevation(x, y, px = 0.005) {
    return elevationWith(ranges.linesIn(x, y, x, y), x, y, px);
  }

  /** Fast elevation function for many points inside a box (looks up nearby spines once). */
  function sampler(x0, y0, x1, y1) {
    const lines = ranges.linesIn(x0, y0, x1, y1);
    return (x, y, px = 0.005) => elevationWith(lines, x, y, px);
  }

  /** Mountain spine polylines overlapping a box (for drawing / debugging). */
  const rangeLines = (x0, y0, x1, y1) => ranges.linesIn(x0, y0, x1, y1);

  return { elevation, sampler, rangeLines, debug, seed: base };
}
