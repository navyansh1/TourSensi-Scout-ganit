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

const OVERPASS = "https://overpass-api.de/api/interpreter";
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
  relation["aeroway"="aerodrome"]${b};
);
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
  try {
    const resp = await axios.post(OVERPASS, buildQuery(bbox), {
      headers: OVERPASS_HEADERS,
      timeout: 30_000,
    });
    const elements: any[] = resp.data?.elements ?? [];
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
  } catch {
    // fail open
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
