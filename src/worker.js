// Background worker: computes elevation tiles (see computeTile in elevation.js) off the main
// thread. Each worker runs its own copy of the model with the same seed and settings, so it
// gives exactly the values the main thread would.
//
// Messages in:  { type: 'config', seed, wideFraction, gen }   (re)create the model
//               { type: 'tile', L, ta, tb, gen }              compute one tile
// Messages out: { type: 'tiles', gen, tiles: [{ L, ta, tb, core, value }, ...] }
//   the requested tile, plus the ancestor tiles (coarser levels) above it that this worker
//   hasn't sent yet, so the main thread can show coarse colours while finer ones are pending.

import { createElevation, TILE, parentOf } from './elevation.js';

let field = null, gen = 0;
let sent = new Set(); // "L:ta,tb" of tiles already sent for this model

function pack(L, ta, tb, out, transfer) {
  const key = L + ':' + ta + ',' + tb;
  if (sent.has(key)) return;
  sent.add(key);
  const t = field.tile(L, ta, tb);
  // Copies: the worker keeps its own (it needs them as parents for finer tiles).
  const core = t.core.slice(), value = t.value.slice();
  out.push({ L, ta, tb, core, value });
  transfer.push(core.buffer, value.buffer);
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'config') {
    field = createElevation(m.seed, { wideFraction: m.wideFraction });
    gen = m.gen;
    sent = new Set();
    return;
  }
  if (m.type === 'tile' && m.gen === gen) {
    const out = [], transfer = [];
    field.tile(m.L, m.ta, m.tb); // computes its ancestors on the way
    pack(m.L, m.ta, m.tb, out, transfer);
    // Ancestors: the tiles holding the parents of this tile's corner squares, up to level 0.
    let corners = [[m.ta * TILE, m.tb * TILE], [m.ta * TILE + TILE - 1, m.tb * TILE + TILE - 1],
      [m.ta * TILE + TILE - 1, m.tb * TILE], [m.ta * TILE, m.tb * TILE + TILE - 1]];
    for (let L = m.L; L > 0; L--) {
      corners = corners.map(([a, b]) => parentOf(L, a, b));
      for (const [a, b] of corners) {
        const ta = Math.floor(a / TILE), tb = Math.floor(b / TILE);
        if (field.hasTile(L - 1, ta, tb)) pack(L - 1, ta, tb, out, transfer);
      }
    }
    self.postMessage({ type: 'tiles', gen, tiles: out }, transfer);
  }
};

