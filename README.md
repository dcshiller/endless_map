# Map

An infinite, deterministic elevation map, built up one small step at a time.

Run: `./run.sh` (serves the folder and opens the browser).

## Plates and hotspots (`src/plates.js`, `src/hotspots.js`)

- **Plates**: one seed per 5,000-mile region (about a third of regions have none). Each
  seed has a reach, mostly small but occasionally up to 9,000 miles, and each 1,000-mile
  square joins the plate whose seed is nearest after subtracting reach (a power diagram),
  so a few plates, and so a few continents, are far bigger than the rest. Each plate has a
  random direction and speed and is continental (40%) or oceanic.
- **Plate base**: continental plates +1,000 m, oceanic −1,600 m (added before smoothing).
- **Boundaries**: depending on how hard two plates push together or pull apart, and their
  types: collision mountains, subduction mountains and trenches, island arcs, mid-ocean
  ridges, rifts (added after smoothing, fading over ~800 miles).
- **Hotspots**: fixed plumes (one per 4,000-mile region, half the time). Each leaves a
  chain of 8–30 volcanoes, rising from the abyss floor, running opposite to its plate's
  motion: youngest tallest over the plume, older ones lower and wider. Chains differ in
  strength (many weak, a few strong), breadth, spacing and sideways scatter; tracks bend
  gradually, and some bend sharply once. Volcanoes vary in size, are bell-shaped and add up
  where they overlap; the chain sits on a broad swell of raised sea floor that sinks away
  from the plume. Added on top of squares from 100 miles down. Nearby chains are looked up
  once per 1,000-mile square, so squares away from chains skip hotspots entirely.

## Wind (`src/climate.js`)

- **Latitude** repeats north–south: an equator at y = 0, a pole 6,000 miles north, the
  next equator 6,000 miles beyond, and so on.
- **Band wind** (Earth's pattern): doldrums, trade winds (0–30°), westerlies (30–60°),
  polar easterlies (60–90°), mixed with **weather cells**: highs and lows (one per 3,000-mile
  region, 80% of the time) that wind circles, with the spin fading at the equator.
- **Weather is coarse-grained**: one steered wind per 500-mile square. Wind blowing up a
  slope is partly turned to run along it; what still climbs is recorded as uplift (for
  rain later). Wind over land is slowed 15%. Below sea level counts as flat for steering.

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
- **Sea floor**: under the sea, each finer square's own bias is damped by depth: to 60%
  just below the surface, easing to 8% by 1,500 m deep. Coasts are a little smoother and
  the deep ocean is near-featureless plain; ridges, trenches and hotspots aren't damped.
- **Continental shelf**: a drowned 1,000-mile square on a continental plate keeps only 30%
  of its depth, so drowned continent is shallow sea.
- **Sea floor profile**: every square's final depth is remapped: a shallow shelf (to about
  −200 m) just below sea level, then a steep slope, then a flat abyssal plain near −3,800 m
  (trenches a little deeper). Only final values are remapped, never inherited ones, so
  coastlines don't move.

Computation runs in Web Workers (`src/worker.js`, one per spare CPU core, up to 8), each
with its own copy of the model, so the page stays responsive; if workers can't start, it
falls back to a background loop on the main thread. Every level is computed in 16×16 blocks of squares. Each block's raw random
values and parent values are fetched once into typed arrays and reused by all its squares
(rather than once per neighbour), and results are stored in typed arrays per block. Caches
use numeric keys. The values are the same as computing square by square.

Settings are in `LEVELS`, `RAW_MEAN`/`RAW_STD`, `BIAS_*`, `WIDE_FRACTION`,
`COAST_ROUGHNESS`/`DEEP_ROUGHNESS`/`DEEP_DEPTH`, `SHELF_DEPTH_SCALE` and
`SHELF_EDGE`/`ABYSS_*`.

## Viewer (`src/main.js`)

- Zoom from 100,000 miles across to 1 mile; the finest square level that is at least 8 px
  on screen is drawn (1,000 mi down to 0.1 mi); zooming in stops once 0.1-mile squares show.
- Rendering: smooth (colours blend between square centres) or blocky (flat squares) (**R**).
- Drag / arrows / WASD to pan, wheel or +/− to zoom.
- Hover: elevation of the square under the cursor. On-map elevation labels are hidden by
  default (**L** shows them).
- Click a square: popup with its full breakdown (Esc closes).
- Views (**V**): elevation, or plates & hotspots only (plate types, boundaries, motion
  arrows, hotspot chains; no elevation).
- Plates overlay on the elevation view (**P**): boundaries by type, motion arrows, hotspots.
- Wind overlay (**N**): steered wind arrows, H/L pressure centres, latitude lines.
- Settings menu (top right): wide smoothing none / 1/3 (**T**).

The earlier, more elaborate version is preserved in `v1/` (it runs on its own: `v1/run.sh`).
