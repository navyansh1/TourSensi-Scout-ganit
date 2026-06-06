// OpenStreetMap Overpass API — free, unlimited (within rate limits) POI source.
// We use it as a backup density signal alongside Google Places.

import axios from "axios";

const OVERPASS = "https://overpass-api.de/api/interpreter";

export interface OsmPoi {
  id: string;
  name: string;
  lat: number;
  lng: number;
  tags: Record<string, string>;
}

// OSM tag mappings for each vertical.
const OSM_TAGS: Record<string, string[]> = {
  BFSI_ATM:       ["amenity=atm"],
  BFSI_BRANCH:    ["amenity=bank"],
  FMCG_RETAIL:    ["shop=supermarket", "shop=convenience", "shop=mall"],
  FMCG_WAREHOUSE: ["building=warehouse", "landuse=industrial"],
};

// Pull all POIs of a given vertical within bbox.
export async function osmPois(opts: {
  vertical: string;
  south: number;
  west: number;
  north: number;
  east: number;
}): Promise<OsmPoi[]> {
  const tags = OSM_TAGS[opts.vertical] ?? [];
  if (tags.length === 0) return [];

  const filters = tags.map(t => {
    const [k, v] = t.split("=");
    return `node["${k}"="${v}"](${opts.south},${opts.west},${opts.north},${opts.east});`;
  }).join("");

  const query = `[out:json][timeout:25];(${filters});out body;`;

  const resp = await axios.post(OVERPASS, query, {
    headers: { "Content-Type": "text/plain" },
    timeout: 30_000,
  });

  const elements = resp.data?.elements ?? [];
  return elements.map((e: any) => ({
    id: String(e.id),
    name: e.tags?.name ?? e.tags?.brand ?? "(unnamed)",
    lat: e.lat,
    lng: e.lon,
    tags: e.tags ?? {},
  }));
}

// Pull richer "context" POIs that we draw on the map as overlays:
// metro stations, malls, schools, hospitals. These help the visual story
// without changing the scoring.
export async function osmOverlayPois(bbox: { south: number; west: number; north: number; east: number; }): Promise<Array<OsmPoi & { kind: string; icon: string }>> {
  const q = `[out:json][timeout:25];
(
  node["railway"="station"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
  node["railway"="subway_entrance"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
  node["station"="subway"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
  node["shop"="mall"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
  node["amenity"="school"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
  node["amenity"="hospital"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
  node["amenity"="university"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
);
out body;`;

  try {
    const resp = await axios.post(OVERPASS, q, {
      headers: { "Content-Type": "text/plain" },
      timeout: 30_000,
    });
    const elements = resp.data?.elements ?? [];
    return elements.map((e: any) => {
      const tags = e.tags ?? {};
      let kind = "other", icon = "•";
      if (tags.railway === "station" || tags.station === "subway" || tags.railway === "subway_entrance") { kind = "metro"; icon = "🚇"; }
      else if (tags.shop === "mall") { kind = "mall"; icon = "🏬"; }
      else if (tags.amenity === "school") { kind = "school"; icon = "🏫"; }
      else if (tags.amenity === "hospital") { kind = "hospital"; icon = "🏥"; }
      else if (tags.amenity === "university") { kind = "university"; icon = "🎓"; }
      return {
        id: String(e.id), name: tags.name ?? `(unnamed ${kind})`,
        lat: e.lat, lng: e.lon, tags, kind, icon,
      };
    }).slice(0, 60); // cap so we don't drown the map
  } catch {
    return [];
  }
}

// Coarse population proxy from OSM — count residential POIs, schools, hospitals
// in a bbox. Used when census data is unavailable for an area.
export async function osmDemandProxy(bbox: { south: number; west: number; north: number; east: number; }): Promise<number> {
  const q = `[out:json][timeout:15];(
    node["amenity"="school"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
    node["amenity"="hospital"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
    node["building"="residential"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
    node["amenity"="restaurant"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
  );out count;`;
  try {
    const resp = await axios.post(OVERPASS, q, {
      headers: { "Content-Type": "text/plain" },
      timeout: 20_000,
    });
    const n = resp.data?.elements?.[0]?.tags?.total;
    return n ? Number(n) : 0;
  } catch {
    return 0;
  }
}
