# Atlas — infinite procedural map

An endless, deterministic fantasy map. Every coordinate `(x, y)` (in miles) maps to an
elevation through a pure function of the seed, so the same seed always yields the same world.

## Run

    python3 -m http.server 8000      # or: npm run serve
    open http://localhost:8000

(ES modules + module workers need to be served over HTTP, not opened as a file.)

Drag / arrows / WASD to pan (Shift = faster), mouse wheel or `+`/`-` to zoom,
`L` to toggle the mountain spine lines.
The URL hash stores seed and position, so views are shareable.

Render to PNG without a browser (handy for tuning):

    node tools/preview.mjs --seed dnd --x 0 --y 0 --z -3 --out preview.png
    node tools/preview.mjs --stats   # land %, elevation histogram

## Layout

- `src/noise.js`   — seeded simplex noise with analytic derivatives
- `src/terrain.js` — `createTerrain(seed).elevation(x, y, lod)` — the topography model
- `src/ranges.js`  — mountain ranges as line features (deterministic per cell)
- `src/render.js`  — tile shading: hypsometric tint, hillshade, contours, coastline
- `src/worker.js`  — renders tiles off the main thread
- `src/main.js`    — viewer: tile cache, worker pool, pan/zoom, readout

## Topography model

1. **Continents**: domain-warped low-frequency fBm passed through a hypsometric curve
   (abyssal plain → continental slope → shelf → coastal plain → interior). ~40% land.
   A very-low-frequency *macro* field (~9000 mi) shifts sea level regionally, so some
   regions are near-solid supercontinents and others are open ocean with scattered islands.
2. **Mountain ranges** (`src/ranges.js`): explicit spine polylines, not noise. Each
   1500-mile cell may spawn belts (a main spine plus parallel sub-ranges), more likely
   inside mountain *provinces* (a ~16K-mile field), so ranges cluster. Belts follow a
   slowly varying tectonic grain, so neighbours run roughly parallel. Each belt has its own
   peak height (most moderate, a few towering) with a high core along its length.
   Elevation falls off with distance to the spine; ridged noise adds crests.
   Press `L` in the viewer (or `--lines` in the preview tool) to see the spines.
3. **Hills**: derivative-damped ("erosion") fBm, modulated by a roughness field so there
   are flat plains as well as rugged uplands.

Detail is level-of-detail aware: octaves smaller than a pixel are skipped, but coarse
octaves are identical at every zoom, so features never move when you zoom.

Zoom `z`: `2^-z` miles per pixel (z = -6 … 5, i.e. 64 mi/px … ~50 m/px).
