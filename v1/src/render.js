// Turns elevation samples into map-style pixels: hypsometric tint + hillshade + contours.
// Pure function of (terrain, tile coords, zoom) so it runs in workers and in Node.

import { hash2i } from './noise.js';

export const TILE = 256;
export const METERS_PER_MILE = 1609.344;

/** Miles per (device) pixel at integer zoom z. z=0 => 1 mile/px. */
export function mppForZoom(z) {
  return Math.pow(2, -z);
}

// Elevation color stops (m -> rgb). Muted, parchment-leaning palette.
const WATER_STOPS = [
  [-6000, [38, 62, 92]],
  [-4000, [50, 82, 116]],
  [-2000, [66, 104, 138]],
  [-500, [96, 140, 168]],
  [-150, [128, 170, 190]],
  [-30, [160, 196, 206]],
  [0, [180, 210, 214]],
];
const LAND_STOPS = [
  [0, [182, 196, 146]],
  [80, [168, 186, 128]],
  [250, [184, 190, 134]],
  [500, [206, 196, 144]],
  [900, [210, 182, 132]],
  [1400, [190, 156, 112]],
  [2000, [160, 128, 96]],
  [2800, [138, 118, 102]],
  [3600, [168, 162, 156]],
  [4300, [236, 234, 228]],
  [6000, [252, 252, 250]],
];

function buildLut(stops, lo, hi, step) {
  const n = Math.round((hi - lo) / step) + 1;
  const lut = new Uint8Array(n * 3);
  let s = 0;
  for (let k = 0; k < n; k++) {
    const e = lo + k * step;
    while (s < stops.length - 2 && e > stops[s + 1][0]) s++;
    const [e0, c0] = stops[s];
    const [e1, c1] = stops[s + 1];
    const t = Math.min(1, Math.max(0, (e - e0) / (e1 - e0)));
    for (let ch = 0; ch < 3; ch++) lut[k * 3 + ch] = Math.round(c0[ch] + (c1[ch] - c0[ch]) * t);
  }
  return lut;
}
const LUT_STEP = 5;
const WATER_LUT = buildLut(WATER_STOPS, -6000, 0, LUT_STEP);
const LAND_LUT = buildLut(LAND_STOPS, 0, 6000, LUT_STEP);
const WATER_N = WATER_LUT.length / 3;
const LAND_N = LAND_LUT.length / 3;

/** Contour interval (m) appropriate for the scale. Every 5th line is an index contour. */
export function contourInterval(mpp) {
  if (mpp >= 8) return 500;
  if (mpp >= 2) return 200;
  if (mpp >= 0.5) return 100;
  if (mpp >= 0.125) return 50;
  if (mpp >= 0.03) return 20;
  return 10;
}

const BATHY_LEVELS = [-50, -200, -1000, -2000, -4000];

// Light from the north-west, 45° altitude (the cartographic convention).
const LX = -0.5, LY = -0.5, LZ = Math.SQRT1_2;

/** Relief exaggeration grows with scale so landforms stay legible when zoomed out. */
function verticalExaggeration(mpp) {
  return 3 * Math.pow(mpp, 0.5) + 1;
}

/**
 * Render one tile. Returns RGBA bytes (TILE*TILE*4).
 * Tile (tx, ty) at zoom z covers world pixels [tx*TILE, (tx+1)*TILE) at that zoom;
 * world y grows southward.
 */
export function renderTile(terrain, tx, ty, z, size = TILE) {
  const mpp = mppForZoom(z);
  const G = size + 2; // one-pixel apron for gradients/contours
  const E = new Float32Array(G * G);
  const ox = tx * size - 1, oy = ty * size - 1;
  const sample = terrain.sampler(ox * mpp, oy * mpp, (ox + G) * mpp, (oy + G) * mpp);
  for (let j = 0; j < G; j++) {
    const wy = (oy + j + 0.5) * mpp;
    for (let i = 0; i < G; i++) {
      E[j * G + i] = sample((ox + i + 0.5) * mpp, wy, mpp);
    }
  }

  const out = new Uint8ClampedArray(size * size * 4);
  const ci = contourInterval(mpp);
  const k = verticalExaggeration(mpp) / (2 * mpp * METERS_PER_MILE);
  const seed = terrain.seed | 0;

  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const g = (j + 1) * G + (i + 1);
      const e = E[g], eL = E[g - 1], eR = E[g + 1], eU = E[g - G], eD = E[g + G];
      const land = e >= 0;

      let r, gr, b;
      if (land) {
        const idx = Math.min(LAND_N - 1, (e / LUT_STEP) | 0) * 3;
        r = LAND_LUT[idx]; gr = LAND_LUT[idx + 1]; b = LAND_LUT[idx + 2];
      } else {
        const idx = Math.max(0, WATER_N - 1 + Math.ceil(e / LUT_STEP)) * 3;
        r = WATER_LUT[idx]; gr = WATER_LUT[idx + 1]; b = WATER_LUT[idx + 2];
      }

      // Hillshade (Lambertian, normalized so flat ground = 1).
      const dzx = (eR - eL) * k, dzy = (eD - eU) * k;
      const lam = (-dzx * LX - dzy * LY + LZ) / Math.sqrt(dzx * dzx + dzy * dzy + 1);
      let s = lam / LZ;
      s = 1 + (s - 1) * (land ? 0.85 : 0.3);
      s = s < 0.4 ? 0.4 : s > 1.35 ? 1.35 : s;
      r *= s; gr *= s; b *= s;

      // Contours.
      if (land) {
        const l = Math.floor(e / ci), lr = Math.floor(eR / ci), ld = Math.floor(eD / ci);
        if ((l !== lr && eR >= 0) || (l !== ld && eD >= 0)) {
          const top = Math.max(l, lr, ld);
          const f = top % 5 === 0 ? 0.62 : 0.82;
          r = r * f + 70 * (1 - f); gr = gr * f + 48 * (1 - f); b = b * f + 30 * (1 - f);
        }
      } else {
        for (let q = 0; q < BATHY_LEVELS.length; q++) {
          const d = BATHY_LEVELS[q];
          const a = e > d;
          if (a !== eR > d || a !== eD > d) {
            r *= 0.88; gr *= 0.9; b *= 0.93;
            break;
          }
        }
      }

      // Coastline: a two-pixel ink line straddling sea level.
      if (land !== eL >= 0 || land !== eR >= 0 || land !== eU >= 0 || land !== eD >= 0) {
        r = 52; gr = 58; b = 60;
      }

      // Paper grain, stable in world space.
      const n = (hash2i(tx * size + i, ty * size + j, seed) - 0.5) * 10;

      const o = (j * size + i) * 4;
      out[o] = r + n;
      out[o + 1] = gr + n;
      out[o + 2] = b + n;
      out[o + 3] = 255;
    }
  }
  return out;
}
