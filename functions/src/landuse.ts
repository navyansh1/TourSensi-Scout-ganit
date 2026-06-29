// Land-use detection from OpenStreetMap, used to keep the heatmap honest about
// where a site physically cannot go.
//
// Two outcomes, because they want different treatment:
//
//  1. WATER (sea, rivers, lakes, canals, backwaters, lagoons) -> EXCLUDE the
//     hex entirely. It must not be drawn at all — a hex floating on a backwater
//     looks broken. OSM is the reliable source here: coastal water and lagoons
//     often read a POSITIVE elevation in Google's model (the Chennai backwaters
//     read +15..+25 m), so the elevation-only ocean check misses them. OSM knows
//     it is water regardless.
//
//  2. NO-BUILD LAND (railway, airport/runway, large forest) -> PENALISE the hex
//     (floor its score so it reads red and is never recommended) but keep it on
//     the map. OSM polygons for these can be imperfect, so flooring is the safe
//     call vs. deleting a possibly-valid adjacent plot.
//
// One Overpass query with `out geom;` returns polygon coordinates inline, so the
// point-in-polygon test runs locally with zero extra per-hex API calls. Fails
// open (empty sets) on any error.

import axios from "axios";

// Multiple Overpass mirrors, tried in order. The primary frequently returns
// 429/406 under load — when that happens silently, no-build filtering is lost
// and forests/campuses score green. Falling back to a mirror keeps the filter
// working instead of failing open on the first throttle.
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
const OVERPASS_HEADERS = {
  "Content-Type": "text/plain",
  "User-Agent": "GeoScoutIQ/1.0 (contact: navyvibrance@gmail.com)",
};

type Ring = { lat: number; lng: number }[];

export interface LandUseResult {
  waterHexes: Set<string>;    // hexes on water -> exclude/remove
  noBuildHexes: Set<string>;  // hexes on railway/airport/forest -> penalise
}

// Overpass query. Water features are tagged so we can route them to "exclude";
// everything else routes to "penalise".
function buildQuery(bbox: { south: number; west: number; north: number; east: number }): string {
  const b = `(${bbox.south},${bbox.west},${bbox.north},${bbox.east})`;
  return `[out:json][timeout:25];
(
  way["natural"="water"]${b};
  way["waterway"="riverbank"]${b};
  way["landuse"="reservoir"]${b};
  way["landuse"="basin"]${b};
  relation["natural"="water"]${b};
  way["aeroway"="aerodrome"]${b};
  way["aeroway"="runway"]${b};
  way["aeroway"="taxiway"]${b};
  way["landuse"="railway"]${b};
  way["landuse"="forest"]${b};
  way["natural"="wood"]${b};
  // Protected green land — you can't open a shop inside a reserve or city forest,
  // and there's no demand there either.
  way["leisure"="nature_reserve"]${b};
  way["boundary"="protected_area"]${b};
  way["boundary"="national_park"]${b};
  // Military / cantonment land — sealed, not leasable retail.
  way["landuse"="military"]${b};
  way["military"]${b};
  relation["aeroway"="aerodrome"]${b};
  relation["leisure"="nature_reserve"]${b};
  relation["boundary"="protected_area"]${b};
  relation["boundary"="national_park"]${b};
  relation["landuse"="military"]${b};
);
// NOTE: universities, hospitals and ordinary parks are deliberately NOT no-build.
// You can't build INSIDE them, but their edges/gates are prime sites (captive
// footfall). Their interior hexes already score low naturally (≈0 population, no
// POIs) while the gate scores high — exactly right. Flagging them no-build would
// wrongly kill the best ATM/grocery sites next to a campus or hospital.
out geom;`;
}

// True if an element's tags mark it as a water body.
function isWater(tags: Record<string, string> | undefined): boolean {
  if (!tags) return false;
  return (
    tags.natural === "water" ||
    tags.waterway === "riverbank" ||
    tags.landuse === "reservoir" ||
    tags.landuse === "basin" ||
    typeof tags.water === "string"
  );
}

// Fetch polygons, split into water rings and other no-build rings.
async function fetchRings(bbox: { south: number; west: number; north: number; east: number }): Promise<{ water: Ring[]; noBuild: Ring[] }> {
  const water: Ring[] = [];
  const noBuild: Ring[] = [];
  const query = buildQuery(bbox);
  let elements: any[] = [];
  // RACE all mirrors at once (was: try sequentially with a 30s timeout each,
  // which cost ~40s when the primary hung before a mirror answered). Each call
  // gets a tight 8s budget — Overpass answers fast or not at all. We take the
  // first response that actually has data; if all fail we fail open (empty).
  const attempts = OVERPASS_ENDPOINTS.map(endpoint =>
    axios.post(endpoint, query, { headers: OVERPASS_HEADERS, timeout: 8_000 })
      .then(resp => {
        const els: any[] = resp.data?.elements ?? [];
        if (!els.length) throw new Error("empty");   // reject so Promise.any skips it
        return els;
      }),
  );
  try {
    elements = await Promise.any(attempts);
  } catch {
    // every mirror failed or returned empty — fail open
  }
  for (const el of elements) {
    const target = isWater(el.tags) ? water : noBuild;
    if (Array.isArray(el.geometry) && el.geometry.length >= 3) {
      target.push(el.geometry.map((g: any) => ({ lat: g.lat, lng: g.lon })));
    }
    if (Array.isArray(el.members)) {
      for (const m of el.members) {
        if (m.role === "outer" && Array.isArray(m.geometry) && m.geometry.length >= 3) {
          target.push(m.geometry.map((g: any) => ({ lat: g.lat, lng: g.lon })));
        }
      }
    }
  }
  return { water, noBuild };
}

// Standard ray-casting point-in-polygon test.
function pointInRing(lat: number, lng: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i].lat, xi = ring[i].lng;
    const yj = ring[j].lat, xj = ring[j].lng;
    const intersect = (yi > lat) !== (yj > lat) &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi + 0e0) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function hexesInRings(centers: { hex: string; lat: number; lng: number }[], rings: Ring[]): Set<string> {
  const flagged = new Set<string>();
  if (!rings.length) return flagged;
  for (const c of centers) {
    for (const ring of rings) {
      if (pointInRing(c.lat, c.lng, ring)) { flagged.add(c.hex); break; }
    }
  }
  return flagged;
}

// Given hex centres, classify them into water (exclude) and no-build (penalise).
export async function classifyLandUse(
  bbox: { south: number; west: number; north: number; east: number },
  centers: { hex: string; lat: number; lng: number }[],
): Promise<LandUseResult> {
  if (!centers.length) return { waterHexes: new Set(), noBuildHexes: new Set() };
  const { water, noBuild } = await fetchRings(bbox);
  return {
    waterHexes: hexesInRings(centers, water),
    noBuildHexes: hexesInRings(centers, noBuild),
  };
}
