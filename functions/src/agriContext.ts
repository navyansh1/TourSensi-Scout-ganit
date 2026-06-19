// Agricultural geographic context — the farmer-loan use case.
//
// When a bank lends against AGRICULTURAL land, repayment capacity hinges on the
// land being productive, and productivity hinges on WATER. This module answers
// the concrete questions a credit officer would ask on a site visit:
//   • Is there a water body NEARBY for irrigation? (river / canal / lake /
//     reservoir / tank / well) — and how far?
//   • Is the surrounding land actually farmed (farmland / orchard / irrigation
//     infrastructure present), i.e. is this a real agricultural belt?
//
// IMPORTANT distinction from flood.ts: flood.ts asks "is the PARCEL ITSELF under
// water" (bad — unbuildable / flood-prone). This module asks the opposite — "is
// water ACCESSIBLE nearby" (good — irrigable). A parcel can be dry (good, not
// flooded) yet have a canal 600 m away (good, irrigable). Both readings matter.
//
// Source: OpenStreetMap Overpass — VERIFIED working for water features (rivers,
// lakes, canals are mapped far more completely than rural POIs). We use
// `out center` so polygon `way`s return a usable coordinate for distance. Fails
// open to an empty result, never blocks the analysis.

import axios from "axios";

const OVERPASS = "https://overpass-api.de/api/interpreter";
const OVERPASS_HEADERS = {
  "Content-Type": "text/plain",
  // Overpass 406s a blank User-Agent — always identify ourselves.
  "User-Agent": "GeoScoutIQ/1.0 (contact: navyvibrance@gmail.com)",
};

export type WaterKind = "river" | "canal" | "lake" | "reservoir" | "tank" | "stream" | "well" | "spring";

export interface NearbyWater {
  kind: WaterKind;
  name: string;
  lat: number;
  lng: number;
  distanceM: number;
}

export interface AgriContext {
  // Closest irrigation-relevant water feature, if any within the search radius.
  nearestWater: NearbyWater | null;
  // A few of the closest water features (for evidence + map links).
  waters: NearbyWater[];
  // Is the surrounding area actually farmed? (farmland/orchard/irrigation tags)
  farmedNearby: boolean;
  farmlandCount: number;
  irrigationNearby: boolean;      // canals / irrigation ditches present
  // 0..100 irrigation/water-access score — closer + more permanent water = higher.
  waterAccessScore: number;
  // Human one-liner for the collateral report.
  note: string;
}

function metresBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function coordOf(e: any): { lat: number; lng: number } | null {
  if (typeof e.lat === "number" && typeof e.lon === "number") return { lat: e.lat, lng: e.lon };
  if (e.center && typeof e.center.lat === "number") return { lat: e.center.lat, lng: e.center.lon };
  return null;
}

function classifyWater(tags: Record<string, string>): WaterKind | null {
  if (tags.waterway === "river") return "river";
  if (tags.waterway === "canal") return "canal";
  if (tags.waterway === "stream") return "stream";
  if (tags.water === "reservoir" || tags.landuse === "reservoir") return "reservoir";
  if (tags.water === "pond" || tags.water === "tank" || tags.natural === "water") return tags.water === "tank" ? "tank" : "lake";
  if (tags.natural === "spring") return "spring";
  if (tags.man_made === "water_well" || tags.man_made === "borehole") return "well";
  return null;
}

// Permanence-ish weight for the access score: a river/canal/reservoir is a more
// reliable irrigation source than a seasonal stream or a single well.
const KIND_WEIGHT: Record<WaterKind, number> = {
  river: 1.0, canal: 1.0, reservoir: 1.0, lake: 0.9, tank: 0.8,
  well: 0.6, spring: 0.5, stream: 0.5,
};

const KIND_LABEL: Record<WaterKind, string> = {
  river: "river", canal: "irrigation canal", reservoir: "reservoir",
  lake: "lake", tank: "tank/pond", well: "well", spring: "spring", stream: "stream",
};

export async function agriContext(lat: number, lng: number, radiusM = 5000): Promise<AgriContext> {
  const empty: AgriContext = {
    nearestWater: null, waters: [], farmedNearby: false, farmlandCount: 0,
    irrigationNearby: false, waterAccessScore: 0,
    note: "No mapped water bodies or farmland detected nearby (OSM may be sparse here).",
  };

  // One Overpass query for water features + farmland evidence. `out center` so
  // polygon ways (lakes, farmland) return a coordinate.
  const q = `[out:json][timeout:25];
(
  way["waterway"="river"](around:${radiusM},${lat},${lng});
  way["waterway"="canal"](around:${radiusM},${lat},${lng});
  way["waterway"="stream"](around:${radiusM},${lat},${lng});
  way["natural"="water"](around:${radiusM},${lat},${lng});
  way["water"="reservoir"](around:${radiusM},${lat},${lng});
  way["landuse"="reservoir"](around:${radiusM},${lat},${lng});
  node["man_made"="water_well"](around:${radiusM},${lat},${lng});
  node["natural"="spring"](around:${radiusM},${lat},${lng});
  way["landuse"="farmland"](around:${radiusM},${lat},${lng});
  way["landuse"="orchard"](around:${radiusM},${lat},${lng});
  way["landuse"="farmyard"](around:${radiusM},${lat},${lng});
);
out center 80;`;

  let elements: any[] = [];
  try {
    const resp = await axios.post(OVERPASS, q, { headers: OVERPASS_HEADERS, timeout: 30_000 });
    elements = resp.data?.elements ?? [];
  } catch (e) {
    console.warn("agriContext Overpass failed:", (e as Error).message);
    return empty;
  }
  if (!elements.length) return empty;

  const waters: NearbyWater[] = [];
  let farmlandCount = 0;
  let irrigationNearby = false;

  for (const e of elements) {
    const tags = e.tags ?? {};
    // Farmland evidence (no distance needed — just presence/count nearby).
    if (tags.landuse === "farmland" || tags.landuse === "orchard" || tags.landuse === "farmyard") {
      farmlandCount++;
      continue;
    }
    const kind = classifyWater(tags);
    if (!kind) continue;
    if (kind === "canal") irrigationNearby = true;
    const c = coordOf(e);
    if (!c) continue;
    waters.push({
      kind,
      name: tags.name || KIND_LABEL[kind],
      lat: c.lat, lng: c.lng,
      distanceM: Math.round(metresBetween(lat, lng, c.lat, c.lng)),
    });
  }

  waters.sort((a, b) => a.distanceM - b.distanceM);
  const nearestWater = waters[0] ?? null;
  const farmedNearby = farmlandCount >= 2;

  // Water-access score: closer + more reliable source = higher. ≤500 m of a
  // river/canal ≈ 100; ~3 km of a seasonal stream ≈ low. No water → 0.
  let waterAccessScore = 0;
  if (nearestWater) {
    const proximity = Math.max(0, 1 - nearestWater.distanceM / radiusM); // 1 at parcel, 0 at radius edge
    waterAccessScore = Math.round(100 * proximity * KIND_WEIGHT[nearestWater.kind]);
    // A nearby canal is a strong irrigation signal even if a river is closer.
    if (irrigationNearby) waterAccessScore = Math.min(100, waterAccessScore + 8);
  }

  // Human note for the report.
  let note: string;
  if (nearestWater) {
    const km = nearestWater.distanceM >= 1000
      ? `${(nearestWater.distanceM / 1000).toFixed(1)} km`
      : `${nearestWater.distanceM} m`;
    const access = waterAccessScore >= 70 ? "strong irrigation access"
      : waterAccessScore >= 40 ? "moderate irrigation access"
      : "limited irrigation access";
    note = `Nearest water: ${KIND_LABEL[nearestWater.kind]}${nearestWater.name && nearestWater.name !== KIND_LABEL[nearestWater.kind] ? ` "${nearestWater.name}"` : ""} ~${km} away — ${access}.`;
    if (farmedNearby) note += ` Surrounded by active farmland (${farmlandCount} parcels) — established agricultural belt.`;
  } else {
    note = farmedNearby
      ? `Farmland present nearby (${farmlandCount} parcels) but no mapped surface water within ${radiusM / 1000} km — likely groundwater/borewell dependent.`
      : `No mapped water bodies or farmland within ${radiusM / 1000} km (OSM may be sparse here).`;
  }

  return {
    nearestWater, waters: waters.slice(0, 6), farmedNearby, farmlandCount,
    irrigationNearby, waterAccessScore, note,
  };
}
