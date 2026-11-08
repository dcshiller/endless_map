// Tile-rendering worker. Receives {id, seed, tx, ty, z}; replies with RGBA bytes.
import { createTerrain } from './terrain.js';
import { renderTile } from './render.js';

let terrain = null;
let currentSeed = null;

self.onmessage = (e) => {
  const { id, seed, tx, ty, z } = e.data;
  if (seed !== currentSeed) {
    terrain = createTerrain(seed);
    currentSeed = seed;
  }
  const px = renderTile(terrain, tx, ty, z);
  self.postMessage({ id, buf: px.buffer }, [px.buffer]);
};
