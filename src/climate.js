// Wind: Earth-like latitude bands mixed with weather cells (highs and lows).
//
// Latitude: the world repeats north-south. y = 0 is an equator, the next pole is
// POLE_DISTANCE miles north (−y), the next equator the same distance beyond, and so on in
// both directions. In the "northern" belts the pole is up (−y); in the "southern" belts
// the pole is down (+y).
//
// Band wind (Earth's pattern, by latitude): doldrums at the equator, trade winds 0–30°
// (from the east, toward the equator), westerlies 30–60° (from the west, toward the pole),
// polar easterlies 60–90° (from the east, toward the equator).
//
// Weather cells: each CELL_SIZE region may hold a high- or low-pressure centre. Wind
// circles them because of the planet's spin (anticlockwise around lows where the pole is
// up, clockwise where it's down; the spin effect fades to nothing at the equator), and
// drifts a little from high to low pressure.
//
// Wind = BAND_STRENGTH * band wind + CELL_STRENGTH * cell wind. Directions use map axes:
// +x east, +y south.
//
// Weather (steered wind, and later moisture) is coarse-grained: one value per weather
// square (the 500-mile squares), used for everything inside it. Steering: wind blowing up
// a slope is partly turned to run along it (more for steeper slopes); what still climbs
// is the square's uplift (for rain later). Wind over land is slowed by LAND_DRAG.

import { hash, normal, keyOf } from './random.js';

export const POLE_DISTANCE = 6000;   // miles from an equator to the next pole
export const BAND_STRENGTH = 0.6;    // weight of the latitude-band wind
export const CELL_STRENGTH = 1.0;    // weight of the weather-cell wind
export const BAND_SPEEDS = { trades: 1.0, westerlies: 1.3, polar: 0.6 };
export const BAND_POLEWARD = 0.4;    // north-south share of band wind, relative to east-west

export const CELL_SIZE = 3000;       // miles: one possible pressure centre per region...
export const CELL_CHANCE = 0.8;      // ...with this chance
export const MIN_CELL_RADIUS = 1200, MAX_CELL_RADIUS = 2200; // miles
export const DOWNHILL = 0.3;         // share of cell wind blowing from high to low pressure
export const SPIN = 1.0;             // share of cell wind circling the centres

export const STEEP_SLOPE = 3;        // m per mile: slopes this steep turn uphill wind fully
export const ALONG_SHARE = 0.6;      // share of turned (uphill) wind kept, now running along the slope
export const LAND_DRAG = 0.85;       // wind speed multiplier over land

/**
 * Latitude at map y: { lat (0 = equator, 90 = pole), poleUp (true if the nearest pole is
 * north on the map, −y) }.
 */
export function latitudeAt(y) {
  const period = 2 * POLE_DISTANCE;
  const t = ((y % period) + period) % period; // 0 at an equator, POLE_DISTANCE at a pole
  if (t <= POLE_DISTANCE) return { lat: (t / POLE_DISTANCE) * 90, poleUp: false };
  return { lat: ((period - t) / POLE_DISTANCE) * 90, poleUp: true };
}

/** Name of the wind band at a latitude. */
export function bandName(lat) {
  if (lat < 5) return 'doldrums';
  if (lat < 30) return 'trade winds';
  if (lat < 60) return 'westerlies';
  return 'polar easterlies';
}

/**
 * @param seed     numeric seed
 * @param terrain  the weather squares: { size (miles), squareAt(x, y) -> [a, b],
 *                 centre(a, b) -> [x, y], height(a, b) -> elevation (m) }
 */
export function createClimate(seed, terrain) {
  const cellCache = new Map(); // "p,q" -> pressure centre or null

  /** Pressure centre in region (p, q): { x, y, strength (+ high, − low), radius } or null. */
  function cellIn(p, q) {
    const key = keyOf(p, q);
    let c = cellCache.get(key);
    if (c !== undefined) return c;
    c = null;
    if (hash(seed, p, q, 800) < CELL_CHANCE) {
      c = {
        id: p + ',' + q,
        x: (p + hash(seed, p, q, 801)) * CELL_SIZE,
        y: (q + hash(seed, p, q, 802)) * CELL_SIZE,
        strength: normal(seed, p, q, 803),
        radius: MIN_CELL_RADIUS + (MAX_CELL_RADIUS - MIN_CELL_RADIUS) * hash(seed, p, q, 805),
      };
    }
    cellCache.set(key, c);
    return c;
  }

  /** Pressure centres whose influence could reach (x, y). */
  function cellsNear(x, y) {
    const reach = Math.ceil((MAX_CELL_RADIUS * 2.5) / CELL_SIZE);
    const p0 = Math.floor(x / CELL_SIZE), q0 = Math.floor(y / CELL_SIZE);
    const out = [];
    for (let q = q0 - reach; q <= q0 + reach; q++) {
      for (let p = p0 - reach; p <= p0 + reach; p++) {
        const c = cellIn(p, q);
        if (c) out.push(c);
      }
    }
    return out;
  }

  /** Band wind at map y: [east, south] components. */
  function bandWind(y) {
    const { lat, poleUp } = latitudeAt(y);
    const speed = lat < 30 ? BAND_SPEEDS.trades : lat < 60 ? BAND_SPEEDS.westerlies : BAND_SPEEDS.polar;
    // Negative in the easterly bands (blowing west), positive in the westerlies; zero at
    // the equator, 30°, 60° and the pole.
    const s = -Math.sin((Math.PI * lat) / 30) * speed;
    const poleward = poleUp ? -1 : 1; // map y direction toward the pole
    // Easterlies blow toward the equator, westerlies toward the pole: both follow s's sign.
    return [s, s * BAND_POLEWARD * poleward];
  }

  /** Cell wind at (x, y): [east, south] components, and the pressure there. */
  function cellWind(x, y) {
    let P = 0, gx = 0, gy = 0;
    for (const c of cellsNear(x, y)) {
      const dx = (x - c.x) / c.radius, dy = (y - c.y) / c.radius;
      const e = c.strength * Math.exp(-(dx * dx + dy * dy));
      P += e;
      gx += -2 * dx * e; // pressure gradient, per cell radius
      gy += -2 * dy * e;
    }
    const { lat, poleUp } = latitudeAt(y);
    // Spin deflection: strongest near the poles, zero at the equator; opposite senses in
    // pole-up and pole-down belts. Rotating the gradient a quarter turn anticlockwise (as
    // seen on the map) gives anticlockwise flow around lows.
    const f = Math.sin((lat * Math.PI) / 180) * (poleUp ? 1 : -1);
    return {
      pressure: P,
      wind: [-DOWNHILL * gx + SPIN * f * gy, -DOWNHILL * gy - SPIN * f * gx],
    };
  }

  const windCache = new Map();
  /**
   * Wind at (x, y): { u (east), v (south), speed, lat, poleUp, band, pressure }.
   * Cached by 100-mile cell, which is far finer than the wind varies.
   */
  function windAt(x, y) {
    const key = keyOf(Math.round(x / 100), Math.round(y / 100));
    let w = windCache.get(key);
    if (w) return w;
    const [bu, bv] = bandWind(y);
    const { pressure, wind: [cu, cv] } = cellWind(x, y);
    const u = BAND_STRENGTH * bu + CELL_STRENGTH * cu, v = BAND_STRENGTH * bv + CELL_STRENGTH * cv;
    const { lat, poleUp } = latitudeAt(y);
    w = { u, v, speed: Math.hypot(u, v), lat, poleUp, band: bandName(lat), pressure };
    windCache.set(key, w);
    if (windCache.size > 100000) windCache.delete(windCache.keys().next().value);
    return w;
  }

  const weatherCache = new Map();
  /**
   * Weather of the weather square containing (x, y): the large-scale wind at its centre,
   * steered by the slope between its neighbours. Returns { a, b, u, v, speed, uplift,
   * slope, base (unsteered wind), land, lat, poleUp, band, pressure }.
   */
  function weatherAt(x, y) {
    const [a, b] = terrain.squareAt(x, y);
    const key = keyOf(a, b);
    let w = weatherCache.get(key);
    if (w) return w;
    const base = windAt(...terrain.centre(a, b));
    const h = terrain.height(a, b);
    // Slope (m per mile) from the neighbours on each side: points uphill. Wind blows over
    // the sea surface, not the sea floor, so anything below sea level counts as 0.
    const S = terrain.size;
    const surface = (a, b) => Math.max(0, terrain.height(a, b));
    const sx = (surface(a + 1, b) - surface(a - 1, b)) / (2 * S);
    const sy = (surface(a, b + 1) - surface(a, b - 1)) / (2 * S);
    const slope = Math.hypot(sx, sy);
    let u = base.u, v = base.v, uplift = 0;
    if (slope > 1e-6) {
      const nx = sx / slope, ny = sy / slope;           // uphill direction
      const up = u * nx + v * ny;                       // wind component blowing uphill
      if (up > 0) {
        const turn = Math.min(1, slope / STEEP_SLOPE);  // how much of it gets turned
        const tx = -ny, ty = nx;                        // along-slope direction...
        const side = u * tx + v * ty >= 0 ? 1 : -1;     // ...the way the wind already leans
        u += -turn * up * nx + ALONG_SHARE * turn * up * side * tx;
        v += -turn * up * ny + ALONG_SHARE * turn * up * side * ty;
        uplift = (1 - turn) * up * slope;               // climbing wind x steepness
      }
    }
    const land = h >= 0;
    if (land) { u *= LAND_DRAG; v *= LAND_DRAG; }
    w = { a, b, u, v, speed: Math.hypot(u, v), uplift, slope, base, land,
      lat: base.lat, poleUp: base.poleUp, band: base.band, pressure: base.pressure };
    weatherCache.set(key, w);
    if (weatherCache.size > 100000) weatherCache.delete(weatherCache.keys().next().value);
    return w;
  }

  return { windAt, weatherAt, cellIn, cellsNear };
}
