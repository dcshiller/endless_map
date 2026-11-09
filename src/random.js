// Deterministic randomness shared by the elevation and plate models.

/** Deterministic hash of (seed, i, j, k) -> [0, 1). */
export function hash(seed, i, j, k) {
  let h = Math.imul(seed | 0, 0x27d4eb2d) ^ Math.imul(i | 0, 0x165667b1) ^ Math.imul(j | 0, 0x9e3779b1) ^ Math.imul(k | 0, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** Standard normal random value for (i, j) on channel k (Box–Muller from two hashes). */
export function normal(seed, i, j, k) {
  const u1 = Math.max(1e-12, hash(seed, i, j, k));
  const u2 = hash(seed, i, j, k + 1);
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// Cache keys: a number for integer pair (a, b) when both fit in ±2^25 (fast, no string
// building), else a string (pairs farther out still work, just a little slower).
const KEY_LIMIT = 2 ** 25;
export const keyOf = (a, b) =>
  a > -KEY_LIMIT && a < KEY_LIMIT && b > -KEY_LIMIT && b < KEY_LIMIT ? a * 2 ** 26 + b : a + ',' + b;

/** 32-bit seed from a string (FNV-1a). */
export function seedFromString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
