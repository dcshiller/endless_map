// Map colours by elevation (shared by the map and the stamp preview page).
// Elevation only, no vegetation: blues for water (darker = deeper), browns for land
// (darker = higher).
export const STOPS = [
  [-4000, [29, 59, 92]],
  [-1000, [52, 98, 140]],
  [-1, [111, 163, 192]],
  [0, [226, 205, 165]],
  [500, [201, 168, 120]],
  [1500, [166, 122, 78]],
  [3000, [118, 82, 50]],
  [4500, [78, 52, 30]],
];
export function colour(e) {
  if (e <= STOPS[0][0]) return STOPS[0][1];
  for (let k = 0; k < STOPS.length - 1; k++) {
    const [e0, c0] = STOPS[k], [e1, c1] = STOPS[k + 1];
    if (e <= e1) {
      const t = (e - e0) / (e1 - e0);
      return [c0[0] + (c1[0] - c0[0]) * t, c0[1] + (c1[1] - c0[1]) * t, c0[2] + (c1[2] - c0[2]) * t];
    }
  }
  return STOPS[STOPS.length - 1][1];
}
