// Seeded 2D simplex noise (with analytic derivatives) and small hashing utilities.
// Everything here is pure and deterministic: same seed + same coordinates => same value.

export function hashString(str) {
  // FNV-1a, 32-bit
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Integer hash of a 2D lattice point -> [0, 1). Used for cheap per-pixel texture.
export function hash2i(x, y, seed) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;

// 16 evenly spaced unit gradients -> more isotropic than the classic 12/8 set.
const NG = 16;
const GX = new Float64Array(NG);
const GY = new Float64Array(NG);
for (let k = 0; k < NG; k++) {
  const a = (2 * Math.PI * (k + 0.5)) / NG;
  GX[k] = Math.cos(a);
  GY[k] = Math.sin(a);
}

// Empirically chosen so output spans roughly [-1, 1].
const SCALE = 99.2;

export function createSimplex2D(seed) {
  const rand = mulberry32(seed >>> 0);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  const perm = new Uint8Array(512);
  const permG = new Uint8Array(512);
  for (let i = 0; i < 512; i++) {
    perm[i] = p[i & 255];
    permG[i] = perm[i] % NG;
  }

  /** Simplex noise value in ~[-1, 1]. */
  function noise(x, y) {
    const s = (x + y) * F2;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    const t = (i + j) * G2;
    const x0 = x - (i - t);
    const y0 = y - (j - t);
    const i1 = x0 > y0 ? 1 : 0;
    const j1 = 1 - i1;
    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;
    const ii = i & 255;
    const jj = j & 255;
    let n = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) {
      const g = permG[ii + perm[jj]];
      t0 *= t0;
      n += t0 * t0 * (GX[g] * x0 + GY[g] * y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) {
      const g = permG[ii + i1 + perm[jj + j1]];
      t1 *= t1;
      n += t1 * t1 * (GX[g] * x1 + GY[g] * y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) {
      const g = permG[ii + 1 + perm[jj + 1]];
      t2 *= t2;
      n += t2 * t2 * (GX[g] * x2 + GY[g] * y2);
    }
    return SCALE * n;
  }

  /** Simplex noise value; writes the analytic gradient (d/dx, d/dy) into out[0], out[1]. */
  function noiseD(x, y, out) {
    const s = (x + y) * F2;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    const t = (i + j) * G2;
    const x0 = x - (i - t);
    const y0 = y - (j - t);
    const i1 = x0 > y0 ? 1 : 0;
    const j1 = 1 - i1;
    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;
    const ii = i & 255;
    const jj = j & 255;
    let n = 0, dx = 0, dy = 0;

    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) {
      const g = permG[ii + perm[jj]];
      const gx = GX[g], gy = GY[g];
      const gd = gx * x0 + gy * y0;
      const t20 = t0 * t0, t40 = t20 * t20;
      n += t40 * gd;
      const k = -8 * t20 * t0 * gd;
      dx += k * x0 + t40 * gx;
      dy += k * y0 + t40 * gy;
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) {
      const g = permG[ii + i1 + perm[jj + j1]];
      const gx = GX[g], gy = GY[g];
      const gd = gx * x1 + gy * y1;
      const t21 = t1 * t1, t41 = t21 * t21;
      n += t41 * gd;
      const k = -8 * t21 * t1 * gd;
      dx += k * x1 + t41 * gx;
      dy += k * y1 + t41 * gy;
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) {
      const g = permG[ii + 1 + perm[jj + 1]];
      const gx = GX[g], gy = GY[g];
      const gd = gx * x2 + gy * y2;
      const t22 = t2 * t2, t42 = t22 * t22;
      n += t42 * gd;
      const k = -8 * t22 * t2 * gd;
      dx += k * x2 + t42 * gx;
      dy += k * y2 + t42 * gy;
    }
    out[0] = SCALE * dx;
    out[1] = SCALE * dy;
    return SCALE * n;
  }

  return { noise, noiseD };
}
