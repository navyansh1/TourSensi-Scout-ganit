// Water / ocean detection so the heatmap never paints hexes out at sea.
//
// We use the Google Maps Elevation API: open ocean and sea reliably return an
// elevation at or below ~0 m. At H3 res-8 across a ~2.5 km box there are only a
// few dozen hexes, and the Elevation API accepts up to 512 points per request,
// so this is a single cheap call.
//
// Note: this is tuned to drop OCEAN / SEA, not every inland water body. A
// threshold of 0 m keeps coastal land (which sits slightly above sea level)
// while removing hexes whose centre is actually on the water. Some low-lying
// coastal land can read 0–1 m, so we only drop strictly-negative-or-zero points
// that also sit at the very edge of the box (see caller), keeping the filter
// conservative — we would rather keep a borderline land hex than wrongly delete
// a valid one.

import axios from "axios";

const ELEVATION_URL = "https://maps.googleapis.com/maps/api/elevation/json";
const KEY = () => process.env.GOOGLE_MAPS_SERVER_KEY || "";

// Returns a Set of "lat,lng"-rounded keys that are water, given hex centres.
// On any failure it returns an empty set (fail-open: better to show a hex than
// to blank the map because the elevation call hiccuped).
export async function waterCenters(
  points: { lat: number; lng: number }[],
): Promise<Set<string>> {
  const water = new Set<string>();
  if (!points.length || !KEY()) return water;

  try {
    // Elevation API: pipe-separated "lat,lng" locations, up to 512.
    const locations = points
      .slice(0, 512)
      .map((p) => `${p.lat},${p.lng}`)
      .join("|");

    const resp = await axios.get(ELEVATION_URL, {
      params: { locations, key: KEY() },
      timeout: 10_000,
    });

    const results: any[] = resp.data?.results ?? [];
    if (resp.data?.status !== "OK" || !results.length) return water;

    results.forEach((r, i) => {
      const p = points[i];
      if (!p) return;
      // Sea level is 0 m; the open ocean reads at or just below it. We treat
      // elevation <= 0 as water. (Coastal land is typically a few metres up.)
      if (typeof r.elevation === "number" && r.elevation <= 0) {
        water.add(centerKey(p.lat, p.lng));
      }
    });
  } catch {
    // fail-open
  }
  return water;
}

export function centerKey(lat: number, lng: number): string {
  return `${lat.toFixed(5)},${lng.toFixed(5)}`;
}
