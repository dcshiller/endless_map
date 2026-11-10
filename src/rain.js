// Rainfall: wind picks up moisture over water and drops it over the squares it passes.
//
// Rain lives on the 100-mile squares (level RAIN_LEVEL). Wind comes from the weather model
// (climate.js: steered wind on the 500-mile squares). The map is infinite, so rain is
// traced backward, one square at a time, with no global simulation:
//   1. From the square's centre, follow the wind upstream in RAIN_STEP-mile steps, up to
//      RAIN_RANGE miles (stopping early in calm air, which carries nothing).
//   2. Come back downstream from the farthest point, carrying moisture (0 = dry air,
//      1 = saturated):
//      Speeds are relative to TYPICAL_SPEED (s = speed / TYPICAL_SPEED, so 1 is ordinary).
//      - over water it picks moisture up: M += (1 − M) · (1 − e^(−PICKUP · s)), so
//        faster wind picks up more;
//      - at each step a share f of the moisture falls as rain:
//          f = 1 − e^(−k / s)   (slower air has longer over each square, so drops more)
//          k = RAIN_LAND (or RAIN_SEA over water)
//              + CLIMB_RAIN · climb / 1000   when the air climbs (climb in m over the step)
//          k is scaled by DESCENT_DRY when it goes downhill (sinking air dries out, which
//          with the climb gives rain shadows behind ranges).
//   3. The square's rainfall is what falls at the last step (the square itself), times the
//      amount of air passing (s), times RAIN_MM.
// Moisture only tapers over land, so far inland gets only small amounts. In this terrain,
// median land rainfall with sea this far upwind: 100–200 miles, about 660 mm a year;
// 300–500, about 170 mm; 600–1,000, about 90 mm; 1,100–2,000, about 30 mm; 2,100–3,000,
// about 12 mm; 3,100–4,000, about 3 mm. Land rises inland from most coasts, so the climb takes
// much of the moisture early. Beyond RAIN_RANGE from the sea (upwind), nothing.

export const RAIN_LEVEL = 2;     // the 100-mile squares
export const RAIN_STEP = 100;    // miles per step of the trace
export const RAIN_RANGE = 4000;  // miles: farthest upstream the trace looks
export const CALM = 0.05;        // wind speed below which air carries nothing
export const TYPICAL_SPEED = 0.5; // wind speed (climate.js units) counted as ordinary: about the median over land
export const PICKUP = 0.5;       // moisture pickup over water, per step at ordinary speed
export const RAIN_LAND = 0.1;    // share-rate of moisture rained per step over land
export const RAIN_SEA = 0.08;    // ... over water
export const CLIMB_RAIN = 0.6;  // extra rain-rate per 1,000 m of climb over a step
export const DESCENT_DRY = 0.35; // rain-rate scale for air going downhill
export const MIN_SPEED = 0.3;    // floor on relative speed in f (so near-calm air doesn't drop it all at once)
export const RAIN_MM = 6500;     // mm per year for rain amount 1

/**
 * @param climate  the weather model (climate.js): weatherAt(x, y) -> { u, v, speed }
 * @param surface  (x, y) -> { h: surface elevation (m, sea = 0), water: bool } of the
 *                 rain square containing (x, y)
 */
export function createRain(climate, surface) {
  /**
   * Rainfall at (x, y): { mm (per year), moisture (arriving, 0..1), climb (m over the
   * last step), speed, steps (how far upstream the trace reached, in steps) }.
   */
  function rainAt(x, y) {
    // 1. Upstream points, nearest first.
    const pts = [[x, y]];
    let px = x, py = y;
    for (let k = 0; k < RAIN_RANGE / RAIN_STEP; k++) {
      const w = climate.weatherAt(px, py);
      if (w.speed < CALM) break;
      px -= (w.u / w.speed) * RAIN_STEP;
      py -= (w.v / w.speed) * RAIN_STEP;
      pts.push([px, py]);
    }
    // 2. Back downstream from the farthest.
    let M = 0, prevH = surface(...pts[pts.length - 1]).h;
    let last = { mm: 0, moisture: 0, climb: 0, speed: 0 };
    for (let k = pts.length - 1; k >= 0; k--) {
      const s = surface(...pts[k]);
      const w = climate.weatherAt(...pts[k]);
      const speed = w.speed / TYPICAL_SPEED;
      if (s.water) M += (1 - M) * (1 - Math.exp(-PICKUP * speed));
      const climb = s.h - prevH;
      prevH = s.h;
      let rate = s.water ? RAIN_SEA : RAIN_LAND;
      if (climb > 0) rate += CLIMB_RAIN * climb / 1000;
      else if (climb < 0) rate *= DESCENT_DRY;
      const f = 1 - Math.exp(-rate / Math.max(MIN_SPEED, speed));
      const arriving = M;
      const fall = M * f;
      M -= fall;
      if (k === 0) last = { mm: fall * speed * RAIN_MM, moisture: arriving, climb, speed: w.speed };
    }
    return { ...last, steps: pts.length - 1 };
  }

  return { rainAt };
}
