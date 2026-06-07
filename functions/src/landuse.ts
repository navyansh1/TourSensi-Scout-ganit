// No-build land-use detection: railways, airports, water bodies (rivers/lakes)
// and large forests/parks. A site obviously cannot open on a runway, a railway
// track, or in the middle of a river, so any hex whose centre falls inside one
// of these features is flagged. We PENALISE such hexes (floor their score) in
// the scoring engine rather than deleting them — OSM polygons aren't perfect, so
// penalising avoids wrongly erasing a valid plot next to (but not on) a feature,
// while still guaranteeing these zones never get recommended.
//
// Source: OpenStreetMap Overpass. `out geom;` returns each way's polygon
// coordinates inline, so we can run a local point-in-polygon test per hex with
// zero extra API calls. Fails open (empty set) on any error.

import axios from "axios";

const OVERPASS = "https://overpass-api.de/api/interpreter";
const OVERPASS_HEADERS = {
  "Content-Type": "text/plain",
  "User-Agent": "GeoScoutIQ/1.0 (contact: navyvibrance@gmail.com)",
};

type Ring = { lat: number; lng: number }[];

// Overpass query for no-build features within a bbox. We pull ways (and the
// outer ring of multipolygon relations) for each category and ask for geometry.
function buildQuery(bbox: { south: number; west: number; north: number; east: number }): string {
  const b = `(${bbox.south},${bbox.west},${bbox.north},${bbox.east})`;
  return `[out:json][timeout:25];
(
  way["aeroway"="aerodrome"]${b};
  way["aeroway"="runway"]${b};
  way["aeroway"="taxiway"]${b};
  way["landuse"="railway"]${b};
  way["natural"="water"]${b};
  way["waterway"="riverbank"]${b};
  way["landuse"="forest"]${b};
  way["natural"="wood"]${b};
  relation["natural"="water"]${b};
  relation["aeroway"="aerodrome"]${b};
);
out geom;`;
}

// Fetch all no-build polygons (as coordinate rings) within the bbox.
async function fetchNoBuildRings(bbox: { south: number; west: number; north: number; east: number }): Promise<Ring[]> {
  try {
    const resp = await axios.post(OVERPASS, buildQuery(bbox), {
      headers: OVERPASS_HEADERS,
      timeout: 30_000,
    });
    const elements: any[] = resp.data?.elements ?? [];
    const rings: Ring[] = [];
    for (const el of elements) {
      // Ways carry `geometry` directly.
      if (Array.isArray(el.geometry) && el.geometry.length >= 3) {
        rings.push(el.geometry.map((g: any) => ({ lat: g.lat, lng: g.lon })));
      }
      // Relations carry members, each with its own geometry (outer rings).
      if (Array.isArray(el.members)) {
        for (const m of el.members) {
          if (m.role === "outer" && Array.isArray(m.geometry) && m.geometry.length >= 3) {
            rings.push(m.geometry.map((g: any) => ({ lat: g.lat, lng: g.lon })));
          }
        }
      }
    }
    return rings;
  } catch {
    return []; // fail open
  }
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

// Given hex centres, return the set of hex ids that sit on a no-build feature.
export async function noBuildHexes(
  bbox: { south: number; west: number; north: number; east: number },
  centers: { hex: string; lat: number; lng: number }[],
): Promise<Set<string>> {
  const flagged = new Set<string>();
  if (!centers.length) return flagged;

  const rings = await fetchNoBuildRings(bbox);
  if (!rings.length) return flagged;

  for (const c of centers) {
    for (const ring of rings) {
      if (pointInRing(c.lat, c.lng, ring)) { flagged.add(c.hex); break; }
    }
  }
  return flagged;
}
