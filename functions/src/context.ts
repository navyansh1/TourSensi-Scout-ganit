// Nearby-context engine.
//
// Replaces the old (broken) OSM Overpass overlay with reliable Google Places
// "Nearby" lookups, and — crucially — wires the results into BOTH scoring and
// the AI narrative so the app can actually say "this ATM is 320 m from a metro
// station on a well-lit arterial road".
//
// The key idea: WHAT counts as good context is vertical-specific.
//  - An ATM wants footfall + safety + accessibility (metro, malls, well-lit
//    arterial roads, busy junctions).
//  - A bank branch wants affluence + office/commercial density + parking.
//  - A grocery / retail store wants residential demand, schools, transit footfall.
//  - A warehouse wants logistics arteries: ports, railheads, airports, highways,
//    wide roads — and does NOT want to sit in a dense residential core.
//
// So each vertical declares a list of amenity "factors", each with:
//  - the Places text query to find them
//  - a sign (+1 = being near it is good, -1 = being near it is bad)
//  - which sub-score it feeds (access | demand)
//  - a "good distance" in metres (proximity decays past this)
//  - a human label used in the proximity narrative

import axios from "axios";
import type { Vertical } from "./companies";

const PLACES_TEXT = "https://places.googleapis.com/v1/places:searchText";
const KEY = () => process.env.GOOGLE_MAPS_SERVER_KEY || "";

export type FactorScore = "access" | "demand";

export interface ContextFactor {
  key: string;                 // stable id, e.g. "metro"
  label: string;               // human label, e.g. "metro / transit station"
  query: string;               // Places text query
  feeds: FactorScore;          // which sub-score proximity boosts
  sign: 1 | -1;                // +1 good to be near, -1 bad to be near
  goodMeters: number;          // proximity considered "excellent" within this radius
  weight: number;              // relative importance of this factor for the vertical
  icon: string;                // map marker emoji
  kind: string;                // grouping label for the map legend
}

// Per-vertical context profiles. Be generous but focused — each call to Places
// costs, so cap each profile at the factors that genuinely move the needle.
const PROFILES: Record<Vertical, ContextFactor[]> = {
  // ATMs: want maximum footfall + easy walk-up access + perceived safety.
  BFSI_ATM: [
    { key: "metro",      label: "metro / transit station", query: "metro station OR railway station", feeds: "access", sign: 1,  goodMeters: 400,  weight: 1.0, icon: "🚇", kind: "Transit" },
    { key: "bus",        label: "bus stop / terminal",     query: "bus stop OR bus terminal",          feeds: "access", sign: 1,  goodMeters: 250,  weight: 0.5, icon: "🚌", kind: "Transit" },
    { key: "mall",       label: "shopping mall / market",  query: "shopping mall OR market",           feeds: "demand", sign: 1,  goodMeters: 600,  weight: 0.8, icon: "🏬", kind: "Footfall" },
    { key: "hospital",   label: "hospital",                query: "hospital",                          feeds: "demand", sign: 1,  goodMeters: 700,  weight: 0.5, icon: "🏥", kind: "Footfall" },
    { key: "college",    label: "college / university",    query: "college OR university",             feeds: "demand", sign: 1,  goodMeters: 700,  weight: 0.5, icon: "🎓", kind: "Footfall" },
    { key: "fuel",       label: "petrol pump / busy road", query: "petrol pump",                       feeds: "access", sign: 1,  goodMeters: 400,  weight: 0.4, icon: "⛽", kind: "Access" },
    { key: "atm",        label: "ATM",                     query: "atm",                               feeds: "access", sign: 1,  goodMeters: 300,  weight: 0.3, icon: "🏧", kind: "Finance" },
    { key: "restaurant", label: "restaurant / cafe",       query: "restaurant OR cafe",                feeds: "demand", sign: 1,  goodMeters: 400,  weight: 0.4, icon: "🍔", kind: "Footfall" },
    { key: "office",     label: "office / business park",  query: "office complex OR corporate park",  feeds: "demand", sign: 1,  goodMeters: 600,  weight: 0.6, icon: "🏢", kind: "Commercial" },
  ],

  // Bank branches: affluence + commercial/office density + parking, less pure footfall.
  BFSI_BRANCH: [
    { key: "metro",      label: "metro / transit station", query: "metro station OR railway station", feeds: "access", sign: 1,  goodMeters: 600,  weight: 0.8, icon: "🚇", kind: "Transit" },
    { key: "office",     label: "office / business park",  query: "office complex OR corporate park",  feeds: "demand", sign: 1,  goodMeters: 800,  weight: 1.0, icon: "🏢", kind: "Commercial" },
    { key: "mall",       label: "shopping mall",           query: "shopping mall",                     feeds: "demand", sign: 1,  goodMeters: 800,  weight: 0.7, icon: "🏬", kind: "Commercial" },
    { key: "hospital",   label: "hospital",                query: "hospital",                          feeds: "demand", sign: 1,  goodMeters: 900,  weight: 0.4, icon: "🏥", kind: "Anchor" },
    { key: "parking",    label: "parking",                 query: "parking",                           feeds: "access", sign: 1,  goodMeters: 300,  weight: 0.5, icon: "🅿️", kind: "Access" },
    { key: "atm",        label: "ATM",                     query: "atm",                               feeds: "access", sign: 1,  goodMeters: 400,  weight: 0.3, icon: "🏧", kind: "Finance" },
    { key: "restaurant", label: "restaurant / cafe",       query: "restaurant OR cafe",                feeds: "demand", sign: 1,  goodMeters: 500,  weight: 0.4, icon: "🍔", kind: "Footfall" },
  ],

  // Grocery / retail: residential demand + family footfall (schools) + transit.
  FMCG_RETAIL: [
    { key: "school",     label: "school",                  query: "school",                            feeds: "demand", sign: 1,  goodMeters: 600,  weight: 1.0, icon: "🏫", kind: "Demand" },
    { key: "residential",label: "residential / apartments",query: "apartment OR residential complex",  feeds: "demand", sign: 1,  goodMeters: 700,  weight: 1.0, icon: "🏘️", kind: "Demand" },
    { key: "metro",      label: "metro / transit station", query: "metro station OR bus stop",         feeds: "access", sign: 1,  goodMeters: 500,  weight: 0.7, icon: "🚇", kind: "Transit" },
    { key: "mall",       label: "shopping mall / market",  query: "shopping mall OR market",           feeds: "demand", sign: 1,  goodMeters: 800,  weight: 0.6, icon: "🏬", kind: "Footfall" },
    { key: "college",    label: "college / university",    query: "college OR university",             feeds: "demand", sign: 1,  goodMeters: 700,  weight: 0.5, icon: "🎓", kind: "Demand" },
    { key: "atm",        label: "ATM",                     query: "atm",                               feeds: "access", sign: 1,  goodMeters: 400,  weight: 0.3, icon: "🏧", kind: "Finance" },
    { key: "restaurant", label: "restaurant / cafe",       query: "restaurant OR cafe",                feeds: "demand", sign: 1,  goodMeters: 500,  weight: 0.5, icon: "🍔", kind: "Footfall" },
  ],

  // Warehouse / dark store: logistics arteries. Near ports/railheads/airports/
  // highways is great; sitting inside a dense residential core is a negative
  // (last-mile dark stores are an exception, but heavy warehousing wants edges).
  FMCG_WAREHOUSE: [
    { key: "highway",    label: "highway / expressway access", query: "highway OR expressway entrance", feeds: "access", sign: 1,  goodMeters: 1500, weight: 1.0, icon: "🛣️", kind: "Logistics" },
    { key: "railway",    label: "railway freight / station",   query: "railway station OR goods yard",  feeds: "access", sign: 1,  goodMeters: 2500, weight: 0.8, icon: "🚉", kind: "Logistics" },
    { key: "airport",    label: "airport / air cargo",         query: "airport OR air cargo terminal",  feeds: "access", sign: 1,  goodMeters: 8000, weight: 0.6, icon: "✈️", kind: "Logistics" },
    { key: "port",       label: "port / harbour / ICD",        query: "port OR harbour OR inland container depot", feeds: "access", sign: 1, goodMeters: 10000, weight: 0.6, icon: "🚢", kind: "Logistics" },
    { key: "industrial", label: "industrial / logistics park", query: "industrial area OR logistics park OR warehouse", feeds: "access", sign: 1, goodMeters: 1500, weight: 0.8, icon: "🏭", kind: "Logistics" },
    { key: "fuel",       label: "fuel / truck stop",           query: "petrol pump OR truck stop",      feeds: "access", sign: 1,  goodMeters: 1200, weight: 0.3, icon: "⛽", kind: "Logistics" },
    { key: "supermarket",label: "supermarket / retail",        query: "supermarket OR grocery store",   feeds: "demand", sign: 1,  goodMeters: 2000, weight: 0.4, icon: "🛒", kind: "Retail" },
  ],
};

export interface ContextPoi {
  id: string;
  name: string;
  lat: number;
  lng: number;
  factorKey: string;
  label: string;
  kind: string;
  icon: string;
}

// Pull all context POIs for a vertical around a center point, in parallel.
export async function fetchContextPois(opts: {
  vertical: Vertical;
  centerLat: number;
  centerLng: number;
  radiusM: number;
}): Promise<ContextPoi[]> {
  const factors = PROFILES[opts.vertical] ?? [];
  if (factors.length === 0 || !KEY()) return [];

  const lists = await Promise.all(
    factors.map(async (f) => {
      // Logistics factors (port/airport) can be far away; widen their search.
      const radius = Math.max(opts.radiusM, f.goodMeters);
      try {
        const resp = await axios.post(
          PLACES_TEXT,
          {
            textQuery: f.query,
            maxResultCount: 12,
            locationBias: {
              circle: {
                center: { latitude: opts.centerLat, longitude: opts.centerLng },
                radius: Math.min(radius, 50000),
              },
            },
          },
          {
            headers: {
              "Content-Type": "application/json",
              "X-Goog-Api-Key": KEY(),
              "X-Goog-FieldMask": "places.id,places.displayName,places.location",
            },
            timeout: 12_000,
          },
        );
        const places = resp.data?.places ?? [];
        return places
          .map((p: any) => ({
            id: p.id,
            name: p.displayName?.text ?? f.label,
            lat: p.location?.latitude,
            lng: p.location?.longitude,
            factorKey: f.key,
            label: f.label,
            kind: f.kind,
            icon: f.icon,
          }))
          .filter((p: ContextPoi) => p.lat && p.lng);
      } catch (e) {
        console.error(`context fetch failed (${f.query}): ${(e as Error).message}`);
        return [] as ContextPoi[];
      }
    }),
  );

  // Deduplicate by Places id (a place can match two queries).
  const seen = new Map<string, ContextPoi>();
  for (const list of lists) for (const p of list) if (!seen.has(p.id)) seen.set(p.id, p);
  return Array.from(seen.values());
}

export function factorsFor(vertical: Vertical): ContextFactor[] {
  return PROFILES[vertical] ?? [];
}

function haversineM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Per-hex proximity to the nearest POI of each factor.
export interface NearbyPlace { name: string; meters: number; id?: string; }
export interface NearestAmenity {
  factorKey: string;
  label: string;
  kind: string;
  icon: string;
  name: string;
  meters: number;
  sign: 1 | -1;
  id?: string;                 // Places id of the nearest, for a Google Maps link
  others?: NearbyPlace[];      // additional places of the same type (for "+N more")
}

export interface HexContext {
  // 0..100 contribution to be ADDED into the access sub-score
  accessBoost: number;
  // 0..100 contribution to be ADDED into the demand sub-score
  demandBoost: number;
  // sorted nearest amenities (closest first) for the narrative
  nearest: NearestAmenity[];
}

// Proximity falloff: 1.0 at distance 0, ~0.5 at goodMeters, → 0 far away.
function proximity(meters: number, goodMeters: number): number {
  return 1 / (1 + meters / goodMeters);
}

// For a single hex center, compute boosts + nearest amenities for the vertical.
export function hexContext(
  hexLat: number,
  hexLng: number,
  vertical: Vertical,
  pois: ContextPoi[],
): HexContext {
  const factors = PROFILES[vertical] ?? [];

  // All POIs per factor, sorted nearest-first (so we can show "+N more").
  const byFactor = new Map<string, { poi: ContextPoi; meters: number }[]>();
  for (const p of pois) {
    const m = haversineM({ lat: hexLat, lng: hexLng }, p);
    const list = byFactor.get(p.factorKey) ?? [];
    list.push({ poi: p, meters: m });
    byFactor.set(p.factorKey, list);
  }
  for (const list of byFactor.values()) list.sort((a, b) => a.meters - b.meters);

  let access = 0;
  let demand = 0;
  let accessW = 0;
  let demandW = 0;
  const nearest: NearestAmenity[] = [];

  for (const f of factors) {
    const list = byFactor.get(f.key);
    if (!list || !list.length) continue;
    const hit = list[0];
    const prox = proximity(hit.meters, f.goodMeters); // 0..1
    const contrib = prox * f.weight * f.sign;
    if (f.feeds === "access") {
      access += contrib;
      accessW += f.weight;
    } else {
      demand += contrib;
      demandW += f.weight;
    }
    nearest.push({
      factorKey: f.key,
      label: f.label,
      kind: f.kind,
      icon: f.icon,
      name: hit.poi.name,
      meters: Math.round(hit.meters),
      sign: f.sign,
      id: hit.poi.id,
      others: list.slice(1, 6).map(o => ({ name: o.poi.name, meters: Math.round(o.meters), id: o.poi.id })),
    });
  }

  nearest.sort((a, b) => a.meters - b.meters);

  // Normalize to a 0..100 scale relative to the vertical's total weight, so
  // verticals with more factors don't run hotter.
  const accessBoost = accessW > 0 ? Math.max(-40, Math.min(40, (access / accessW) * 60)) : 0;
  const demandBoost = demandW > 0 ? Math.max(-40, Math.min(40, (demand / demandW) * 60)) : 0;

  return { accessBoost, demandBoost, nearest };
}

// A short human phrase for the closest, most relevant amenities — used in the
// hex panel and recommendation cards. e.g. "320 m from a metro station · 540 m
// from a shopping mall".
export function proximityPhrase(nearest: NearestAmenity[], max = 3): string {
  const fmt = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m} m`);
  return nearest
    .filter((n) => n.sign > 0)
    .slice(0, max)
    .map((n) => `${fmt(n.meters)} from a ${n.label.split(" / ")[0]}`)
    .join(" · ");
}

// Area-level context summary fed to the AI agent so the executive narrative can
// reference what's actually nearby. Returns a compact, factual brief.
export function areaContextBrief(
  vertical: Vertical,
  pois: ContextPoi[],
  center?: { lat: number; lng: number },
): string {
  const factors = PROFILES[vertical] ?? [];

  // Nearest actual distance per factor from the searched centre.
  const nearestM = new Map<string, number>();
  if (center) {
    for (const p of pois) {
      const m = haversineM(center, p);
      const cur = nearestM.get(p.factorKey);
      if (cur == null || m < cur) nearestM.set(p.factorKey, m);
    }
  }

  const fmt = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);
  const present: string[] = [];
  const absent: string[] = [];

  for (const f of factors) {
    const m = nearestM.get(f.key);
    if (m == null) { absent.push(f.label); continue; }
    // "Close" = within ~2x the factor's good distance. Beyond that we report the
    // honest distance and explicitly flag it as NOT nearby, so the model won't
    // claim a 150-km-away port is "nearby" in a landlocked city.
    if (m <= f.goodMeters * 2) present.push(`- nearest ${f.label}: ${fmt(m)} (close)`);
    else present.push(`- nearest ${f.label}: ${fmt(m)} — far, treat as NOT available nearby`);
  }

  if (!present.length && !absent.length) return "";
  let brief = `Physical context for this use-case, measured from the searched location (from Google Maps). Only call something "nearby" if marked "close"; never invent infrastructure that isn't listed:\n${present.join("\n")}`;
  if (absent.length) brief += `\n- not found in this area at all: ${absent.join(", ")}`;
  return brief;
}
