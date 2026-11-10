// Rivers: each land 100-mile square (SOURCE_LEVEL) may start a river at a random point
// inside it: a RIVER_CHANCE if it gets RIVER_FULL_RAIN mm of rain a year or more, and in
// proportion to its rain below that (so deserts rarely start one). Each river has a size
// class (RIVER_CLASSES) by the water it gathers: the few biggest are major or great
// rivers, shown from further out; most are streams, shown only zoomed in. The river runs downhill
// over the 4-mile squares (FLOW_LEVEL): from the square holding the start point it steps to
// the lowest of the 8 squares around it, again and again. "Lowest" uses smoothed heights:
// each square's height averaged over the squares SMOOTH around it (15x15, 60 miles), so
// rivers follow the broad tilt of the land rather than each square's own random detail,
// plus LOCAL_SHARE of the square's own difference from that average, so that on smooth
// slopes the course still wanders instead of running dead straight along the grid.
// (The sea is still judged by real height.) The river keeps its own level: where it flows
// downhill, the ground's.
// Where no neighbour is lower, it cuts the lowest one (the exit) down to just below the
// river's level (CUT_MARGIN), and flows through at the cut level (so the level only
// ever falls, and it never re-enters a square it has been through). Cuts add up over
// consecutive steps, a canyon through a rim, up to MAX_CUT; the count resets where the
// ground falls away below the river again. It stops at the sea. Everything is decided by
// the seed, so a square always gets the same river.
//
// Lakes: past MAX_CUT the river is in a hollow. It fills it as a lake, like rising water
// (always covering the lowest square touching the lake next), until the water reaches the
// lowest point of the rim; it spills there and the river carries on from the outlet,
// except that NO_OVERFLOW of full lakes (by the spill point) never spill: the water
// evaporates and the river ends in the lake. A
// river only has so much water: each step adds LAKE_PER_STEP lake squares' worth where the
// rain there (its 100-mile square) is RIVER_FULL_RAIN, in proportion to the rain otherwise
// (so a river crossing desert gains almost nothing); it can fill at most that much, and
// never more than MAX_LAKE. A hollow needing more than that before it spills
// stops the river: it ends there, in a lake of the size it can fill (filled the same way).

import { hash } from './random.js';
import { squareAt, squareCentre } from './elevation.js';

export const SOURCE_LEVEL = 2;    // the 100-mile squares
export const FLOW_LEVEL = 4;      // the 4-mile squares
export const RIVER_CHANCE = 0.5;  // chance a land source square starts a river, at full rain...
export const RIVER_FULL_RAIN = 600; // ...mm a year and up; less in proportion below it
// Size classes, smallest first, by the water a river has gathered by its end (lake squares'
// worth; see LAKE_PER_STEP): the long, well-fed rivers are the big ones. Thresholds are set
// so that, in this terrain, about 30% of rivers are rivers or bigger, 8% major or bigger,
// and 2% great. The map shows a class only when zoomed in under its view width (main.js).
export const RIVER_CLASSES = [
  { name: 'stream', water: 0 },
  { name: 'river', water: 60 },
  { name: 'major river', water: 150 },
  { name: 'great river', water: 275 },
];
export const MAX_STEPS = 5000;    // safety cap on a river's length, in steps
export const LAKE_PER_STEP = 2;   // lake squares a river can fill per step it has come, at RIVER_FULL_RAIN (in proportion to rain)
export const CUT_MARGIN = 1;      // m: a river cuts an exit to this much below its level...
export const MAX_CUT = 400;       // m: ...up to this much in a row (since the ground last fell away)
export const SMOOTH = 7;          // rivers judge height by the average over this many squares around (15x15, 60 miles)
export const LOCAL_SHARE = 0.3;   // share of each square's own local height mixed back in (so courses wander a little)
export const NO_OVERFLOW = 0.5;   // share of full lakes that don't spill over (rivers end in them)
export const MAX_LAKE = 2000;     // 4-mile squares: a hollow needing a bigger lake than this has no outlet

/**
 * @param field  the elevation model (elevation.js)
 */
export function createRivers(field) {
  const seed = field.seed;
  const smoothCache = new Map();
  const rainCache = new Map(); // "a,b" of a rain (100-mile) square -> mm a year

  /** Rainfall (mm a year) of the 100-mile square holding point (x, y). */
  function rainAt(x, y) {
    const [a, b] = squareAt(SOURCE_LEVEL, x, y), key = a + ',' + b;
    let mm = rainCache.get(key);
    if (mm === undefined) {
      mm = field.rain.rainAt(...squareCentre(SOURCE_LEVEL, a, b)).mm;
      rainCache.set(key, mm);
      if (rainCache.size > 50000) rainCache.delete(rainCache.keys().next().value);
    }
    return mm;
  }
  /** Lake squares' worth of water a step at (x, y) adds: LAKE_PER_STEP at RIVER_FULL_RAIN. */
  const waterAt = (x, y) => LAKE_PER_STEP * rainAt(x, y) / RIVER_FULL_RAIN;

  /** Smoothed height of 4-mile square (i, j): the average over the squares SMOOTH around it. */
  function height(i, j) {
    const key = i + ',' + j;
    let h = smoothCache.get(key);
    if (h !== undefined) return h;
    const R = SMOOTH;
    h = 0;
    for (let dj = -R; dj <= R; dj++) for (let di = -R; di <= R; di++) h += field.value(FLOW_LEVEL, i + di, j + dj);
    h /= (2 * R + 1) * (2 * R + 1);
    h += LOCAL_SHARE * (field.value(FLOW_LEVEL, i, j) - h); // some of the local terrain back
    smoothCache.set(key, h);
    if (smoothCache.size > 200000) smoothCache.delete(smoothCache.keys().next().value);
    return h;
  }
  /** Is 4-mile square (i, j) sea? (Real height, not smoothed.) */
  const isSea = (i, j) => field.value(FLOW_LEVEL, i, j) < 0;

  /**
   * The river starting in source square (a, b), or null: { cls (size class, index into
   * RIVER_CLASSES), points: [[x, y], ...] (miles,
   * from the start point, then the centre of each 4-mile square it flows through),
   * flow: [water gathered by each point, in lake squares' worth], end: 'sea' | 'hollow' | 'lake' (a full lake that doesn't overflow) | 'cap', lakes: [{ at, squares: [[i, j], ...] }, ...] (each
   * lake on its way, and at its end if it ends in a hollow: the 4-mile squares it covers,
   * and at = the index in points where the river reached it), cuts: how many exits it cut
   * through }.
   */
  function riverFrom(a, b) {
    const roll = hash(seed, a, b, 1100);
    if (roll >= RIVER_CHANCE) return null; // can't start one even at full rain
    if (field.value(SOURCE_LEVEL, a, b) < 0) return null;
    const [cx, cy] = squareCentre(SOURCE_LEVEL, a, b);
    // Wetter squares are likelier to start a river: full chance at RIVER_FULL_RAIN mm a year.
    const mm = rainAt(cx, cy);
    if (roll >= RIVER_CHANCE * Math.min(1, mm / RIVER_FULL_RAIN)) return null;
    const S = 100; // source square size (miles)
    const x0 = cx + (hash(seed, a, b, 1101) - 0.5) * S, y0 = cy + (hash(seed, a, b, 1102) - 0.5) * S;
    const L = FLOW_LEVEL;
    let [i, j] = squareAt(L, x0, y0);
    if (field.value(L, i, j) < 0) return null; // the point itself is in the sea
    const points = [[x0, y0], squareCentre(L, i, j)];
    let water = waterAt(...points[1]); // lake squares' worth of water gathered so far
    const flow = [0, water];           // water gathered by each point (for drawing)
    const visited = new Map(); // "i,j" -> the river's level there (or the lake's water)
    const lakes = [];
    let level = height(i, j); // the river's own level (below the ground where it cut)
    visited.set(i + ',' + j, level);
    let end = 'cap', cuts = 0, run = 0; // run: depth cut since the ground last fell away
    for (let k = 0; k < MAX_STEPS; k++) {
      // The lowest neighbour it hasn't been through: the exit.
      let best = Infinity, bi = i, bj = j;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if ((!di && !dj) || visited.has((i + di) + ',' + (j + dj))) continue;
          const v = height(i + di, j + dj);
          if (v < best) { best = v; bi = i + di; bj = j + dj; }
        }
      }
      if (best < level) { level = best; run = 0; } // downhill
      else {
        // Cut the exit down just below the river's level (CUT_MARGIN under it).
        const depth = best - level + CUT_MARGIN;
        if (run + depth <= MAX_CUT) {
          run += depth;
          level = best - depth;
          cuts++;
        } else {
          // A hollow: fill it as a lake until it spills over the lowest point of its rim.
          // A lake it can fill: limited by how far it has come (its water), and MAX_LAKE.
          const budget = Math.min(MAX_LAKE, Math.max(1, Math.round(water)));
          const lake = spill(i, j, level, visited, budget);
          if (!lake) { end = 'hollow'; break; } // too big to fill: ends here
          lakes.push({ at: points.length - 1, squares: lake.squares });
          // Some full lakes never overflow (the water evaporates): decided by the spill
          // point, so every river reaching the same lake agrees. The river ends here.
          if (!lake.sea && hash(seed, lake.outlet[0], lake.outlet[1], 1200) < NO_OVERFLOW) { end = 'lake'; break; }
          for (const [li, lj] of lake.squares) visited.set(li + ',' + lj, lake.water);
          [bi, bj, best] = lake.outlet;
          level = best;
          if (lake.sea) { i = bi; j = bj; points.push(squareCentre(L, i, j)); flow.push(water); end = 'sea'; break; }
          run = 0;
        }
      }
      i = bi; j = bj;
      visited.set(i + ',' + j, level);
      points.push(squareCentre(L, i, j));
      flow.push(water);
      if (isSea(i, j)) { end = 'sea'; break; }
      water += waterAt(...points[points.length - 1]);
    }
    // A river ending in a hollow too big to fill: a lake sized by the river's length.
    if (end === 'hollow') lakes.push({ at: points.length - 1, squares: fillLake(i, j, Math.min(MAX_LAKE, Math.max(1, Math.round(water)))) });
    // Size class: the biggest whose water threshold it gathered by its end.
    let cls = 0;
    while (cls + 1 < RIVER_CLASSES.length && water >= RIVER_CLASSES[cls + 1].water) cls++;
    return { cls, points, flow, end, lakes, cuts };
  }

  /**
   * Fill the hollow around (i, j) like rising water, from the river's level: always take
   * next the lowest square touching the lake (8 neighbours). Once the lowest touching
   * square is below the water (or is sea), the lake spills there, unless the river has
   * already been through it (an earlier lake or its own channel, part of the same basin),
   * which the water just covers (at the river's level there, as cut). Returns { squares:
   * [[i, j], ...], outlet: [i, j, elevation], water (the lake's level) }, or null
   * if the lake passes maxSize squares first.
   */
  function spill(i, j, level, visited, maxSize) {
    const L = FLOW_LEVEL;
    const squares = [[i, j]];
    const seen = new Set([i + ',' + j]);
    const heap = []; // [elevation, i, j], lowest first
    const push = (item) => {
      heap.push(item);
      let c = heap.length - 1;
      while (c > 0) {
        const p = (c - 1) >> 1;
        if (heap[p][0] <= heap[c][0]) break;
        [heap[p], heap[c]] = [heap[c], heap[p]];
        c = p;
      }
    };
    const pop = () => {
      const top = heap[0], last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        let c = 0;
        for (;;) {
          const l = 2 * c + 1, r = l + 1;
          let m = c;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === c) break;
          [heap[m], heap[c]] = [heap[c], heap[m]];
          c = m;
        }
      }
      return top;
    };
    const touch = (ci, cj) => {
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const k = (ci + di) + ',' + (cj + dj);
        if (seen.has(k)) continue;
        seen.add(k);
        // Ground the river has been through counts at its level there (its cut channel).
        const h = height(ci + di, cj + dj), was = visited.get(k);
        push([was === undefined ? h : Math.min(h, was), ci + di, cj + dj]);
      }
    };
    let water = level;
    touch(i, j);
    while (heap.length) {
      const [e, ni, nj] = pop();
      if (isSea(ni, nj)) return { squares, outlet: [ni, nj, e], sea: true, water }; // drains into the sea
      // Spills here, unless it's ground the river has already been through: then it's part
      // of the same basin (an earlier lake or the river's own channel), and the water covers it.
      if (e < water && !visited.has(ni + ',' + nj)) return { squares, outlet: [ni, nj, e], water };
      water = Math.max(water, e); // the water rises to this square's height and covers it
      squares.push([ni, nj]);
      if (squares.length > maxSize) return null;
      touch(ni, nj);
    }
    return null;
  }

  /** Up to size 4-mile squares filled from (i, j), lowest touching square first. */
  function fillLake(i, j, size) {
    const L = FLOW_LEVEL;
    const lake = [[i, j]];
    const seen = new Set([i + ',' + j]); // squares in the lake or on its edge
    let frontier = []; // [elevation, i, j] of squares touching the lake
    const touch = (ci, cj) => {
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const k = (ci + di) + ',' + (cj + dj);
        if (seen.has(k)) continue;
        seen.add(k);
        frontier.push([height(ci + di, cj + dj), ci + di, cj + dj]);
      }
    };
    touch(i, j);
    while (lake.length < size && frontier.length) {
      let m = 0;
      for (let k = 1; k < frontier.length; k++) if (frontier[k][0] < frontier[m][0]) m = k;
      const [, ni, nj] = frontier[m];
      if (isSea(ni, nj)) break; // reached the sea
      frontier[m] = frontier[frontier.length - 1];
      frontier.pop();
      lake.push([ni, nj]);
      touch(ni, nj);
    }
    return lake;
  }

  return { riverFrom };
}
