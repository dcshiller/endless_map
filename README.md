# Map

An infinite, deterministic elevation map, built up one small step at a time.

Run: `./run.sh` (serves the folder and opens the browser).

## Elevation model (`src/elevation.js`)

- **1,000-mile squares**, each centred on a grid point. Each gets a random raw elevation
  (seeded, deterministic) plus small random biases from the bigger squares it sits in
  (10K, 100K, 1M miles, …; more levels apply farther from the origin). Its average is the
  plain average of its own and its neighbours' raw values.
- **Finer levels**: 500-mile squares (2×2 per parent), then 100-mile squares (5×5 per
  parent). A square's value = what it inherits from the level above + its own bias (the
  plain average of the raw values around it).
- **Smoothing reach**: most squares average 1 square out; a random 1/3 average 2 out.
- **Edge blending**: squares near their parent's edge inherit the average of nearby
  parents' values, so steps between parents become ramps.

Settings are in `LEVELS`, `RAW_MEAN`/`RAW_STD`, `BIAS_*` and `WIDE_FRACTION`.

## Viewer (`src/main.js`)

- Zoom from 100,000 miles across to 1 mile; the finest square level that is at least 8 px
  on screen is drawn (1,000 mi down to 0.1 mi); zooming in stops once 0.1-mile squares show.
- Rendering: smooth (colours blend between square centres) or blocky (flat squares) (**R**).
- Drag / arrows / WASD to pan, wheel or +/− to zoom.
- Hover: elevation of the square under the cursor. On-map elevation labels are hidden by
  default (**L** shows them).
- Click a square: popup with its full breakdown (Esc closes).
- Settings menu (top right): wide smoothing none / 1/3 (**T**).

The earlier, more elaborate version is preserved in `v1/` (it runs on its own: `v1/run.sh`).
