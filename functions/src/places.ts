// Google Places (New) integration — pull competitor & relevant POI locations.

import axios from "axios";
import * as h3 from "h3-js";

const PLACES_BASE = "https://places.googleapis.com/v1/places:searchText";

export interface Poi {
  id: string;
  name: string;
  lat: number;
  lng: number;
  brand?: string;
  rating?: number;
  userRatings?: number;
  priceLevel?: string;      // PRICE_LEVEL_INEXPENSIVE .. PRICE_LEVEL_VERY_EXPENSIVE
  businessStatus?: string;  // OPERATIONAL / CLOSED_TEMPORARILY / CLOSED_PERMANENTLY
  primaryType?: string;
}

const KEY = () => process.env.GOOGLE_MAPS_SERVER_KEY || "";

// Great-circle distance in metres. Used to HARD-filter Places results to the
// requested radius — `locationBias` is only a soft hint, so in sparse/rural
// areas Google happily returns the 20 nearest matches from the whole region
// (e.g. ATMs in the next town), which then inflate competitor / own-site counts
// even though they sit far outside the searched neighbourhood.
function metresBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export async function searchPlaces(opts: {
  query: string;
  centerLat: number;
  centerLng: number;
  radiusM?: number;
  maxResults?: number;
  // When true (default), drop results that fall outside radiusM of the centre.
  // Set false only for searches where you deliberately want the soft bias.
  hardFilter?: boolean;
}): Promise<Poi[]> {
  const radius = opts.radiusM ?? 3000;
  const max = opts.maxResults ?? 20;
  const hardFilter = opts.hardFilter !== false;

  if (!KEY()) throw new Error("GOOGLE_MAPS_SERVER_KEY not set");

  const resp = await axios.post(
    PLACES_BASE,
    {
      textQuery: opts.query,
      maxResultCount: max,
      locationBias: {
        circle: {
          center: { latitude: opts.centerLat, longitude: opts.centerLng },
          radius,
        },
      },
    },
    {
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": KEY(),
        "X-Goog-FieldMask":
          "places.id,places.displayName,places.location,places.rating,places.userRatingCount,places.types,places.priceLevel,places.businessStatus,places.primaryType",
      },
      timeout: 15_000,
    },
  );

  const places = resp.data?.places ?? [];
  return places.map((p: any) => ({
    id: p.id,
    name: p.displayName?.text ?? "Unknown",
    lat: p.location?.latitude,
    lng: p.location?.longitude,
    rating: p.rating,
    userRatings: p.userRatingCount,
    priceLevel: p.priceLevel,
    businessStatus: p.businessStatus,
    primaryType: p.primaryType,
  }))
    .filter((p: Poi) => p.lat && p.lng)
    // Hard radius filter: locationBias is soft, so this is what actually keeps
    // out-of-area places (next-town ATMs, region-wide brand hits) out of the
    // counts and off the map. A small 15% slack absorbs viewport rounding.
    .filter((p: Poi) =>
      !hardFilter || metresBetween(opts.centerLat, opts.centerLng, p.lat, p.lng) <= radius * 1.15,
    );
}

// Richer place data for the on-demand DEEP analysis: actual review snippets,
// editorial summary, opening hours and price level. Heavier field mask, so used
// only per-click (not in the fast batch path).
export interface RichPlace extends Poi {
  editorialSummary?: string;
  reviews?: { text: string; rating?: number }[];
  openNow?: boolean;
  address?: string;
}

export async function richPlacesNearby(opts: {
  query: string;
  centerLat: number;
  centerLng: number;
  radiusM?: number;
  maxResults?: number;
}): Promise<RichPlace[]> {
  const radius = opts.radiusM ?? 1500;
  const max = opts.maxResults ?? 8;
  if (!KEY()) throw new Error("GOOGLE_MAPS_SERVER_KEY not set");

  const resp = await axios.post(
    PLACES_BASE,
    {
      textQuery: opts.query,
      maxResultCount: max,
      locationBias: { circle: { center: { latitude: opts.centerLat, longitude: opts.centerLng }, radius } },
    },
    {
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": KEY(),
        // Review text + editorial summary + hours are the high-signal fields.
        "X-Goog-FieldMask": [
          "places.id", "places.displayName", "places.location", "places.rating",
          "places.userRatingCount", "places.priceLevel", "places.businessStatus",
          "places.primaryType", "places.formattedAddress", "places.editorialSummary",
          "places.regularOpeningHours.openNow", "places.reviews",
        ].join(","),
      },
      timeout: 18_000,
    },
  );

  const places = resp.data?.places ?? [];
  return places.map((p: any) => ({
    id: p.id,
    name: p.displayName?.text ?? "Unknown",
    lat: p.location?.latitude,
    lng: p.location?.longitude,
    rating: p.rating,
    userRatings: p.userRatingCount,
    priceLevel: p.priceLevel,
    businessStatus: p.businessStatus,
    primaryType: p.primaryType,
    address: p.formattedAddress,
    editorialSummary: p.editorialSummary?.text,
    openNow: p.regularOpeningHours?.openNow,
    reviews: (p.reviews ?? []).slice(0, 3).map((r: any) => ({
      text: r.text?.text ?? r.originalText?.text ?? "",
      rating: r.rating,
    })).filter((r: any) => r.text),
  })).filter((p: RichPlace) => p.lat && p.lng);
}

// Pull competitor POIs by category for a circular area.
export async function competitorsInArea(opts: {
  category: string;      // e.g. "ATM", "bank", "supermarket"
  centerLat: number;
  centerLng: number;
  radiusM?: number;
}): Promise<Poi[]> {
  return searchPlaces({
    query: opts.category,
    centerLat: opts.centerLat,
    centerLng: opts.centerLng,
    radiusM: opts.radiusM,
    maxResults: 20,
  });
}

// Generic category words that must NOT, on their own, qualify a place as "yours".
// Otherwise searching "More Supermarket" wrongly tags "Grace Supermarket".
const GENERIC_TOKENS = new Set([
  "bank", "atm", "supermarket", "market", "store", "stores", "retail", "fresh",
  "smart", "mart", "shop", "shopping", "hyper", "hypermarket", "grocery", "groceries",
  "the", "of", "and", "india", "ltd", "limited", "pvt", "co", "company", "centre", "center",
]);

// Distinctive brand tokens extracted from the keyword list — a returned place's
// name must contain at least one of these to be accepted as the user's own site.
function brandTokens(keywords: string[]): string[] {
  const toks = new Set<string>();
  for (const kw of keywords) {
    for (const raw of kw.toLowerCase().split(/[^a-z0-9]+/)) {
      if (raw.length >= 3 && !GENERIC_TOKENS.has(raw)) toks.add(raw);
    }
  }
  return Array.from(toks);
}

// Pull the user's own brand locations in an area, e.g. "HDFC Bank ATM Anna Nagar".
export async function brandLocationsInArea(opts: {
  brandKeywords: string[];
  centerLat: number;
  centerLng: number;
  radiusM?: number;
}): Promise<Poi[]> {
  const results = await Promise.all(
    opts.brandKeywords.map(kw =>
      searchPlaces({
        query: kw,
        centerLat: opts.centerLat,
        centerLng: opts.centerLng,
        radiusM: opts.radiusM,
      }),
    ),
  );

  // Verify each result's NAME actually contains a distinctive brand token —
  // Places text search is fuzzy and will return same-category competitors.
  const tokens = brandTokens(opts.brandKeywords);
  const matchesBrand = (name: string) => {
    if (!tokens.length) return true; // nothing distinctive to check against
    const n = name.toLowerCase();
    return tokens.some(t => new RegExp(`\\b${t}`, "i").test(n));
  };

  const map = new Map<string, Poi>();
  for (const list of results) {
    for (const p of list) {
      if (!matchesBrand(p.name)) continue; // drop false positives
      map.set(p.id, { ...p, brand: opts.brandKeywords[0] });
    }
  }
  return Array.from(map.values());
}

// --- No-build land from Google Places --------------------------------------
// OSM polygons are patchy (a forest or campus may be untagged). Google, which we
// already query for competitors, knows these big features well. We text-search a
// handful of land-feature categories and trust ONLY results whose Google
// `primaryType`/`types` mark them as genuinely unbuildable land. The matched
// places' hexes are returned so the scorer can floor them red — a second,
// independent vote alongside OSM and population density.
//
// We gate on Google's TYPE, not the search keyword, so a "city park cafe" (type
// restaurant) doesn't get treated as a park.
//
// IMPORTANT — only land that's unbuildable AND not a demand magnet belongs here.
// Deliberately EXCLUDED: university and hospital. You can't build a store INSIDE
// the campus, but the gate/perimeter is prime (captive student/patient footfall).
// Flagging them no-build would wrongly kill the best ATM/grocery sites in town.
// Those are handled as positive demand context elsewhere, not penalised here.
const NO_BUILD_GOOGLE_TYPES = new Set<string>([
  "airport", "international_airport",
  "national_park", "state_park",
  "natural_feature", "campground", "forest",
  "military_base",
]);

// Search phrases that tend to surface these land features near a centre.
const NO_BUILD_QUERIES = [
  "airport", "national park", "forest",
  "nature reserve", "military cantonment",
];

export async function noBuildPlacesHexes(opts: {
  centerLat: number;
  centerLng: number;
  radiusM?: number;
  hexRes?: number;
}): Promise<Set<string>> {
  const res = opts.hexRes ?? 8;
  const flagged = new Set<string>();
  if (!KEY()) return flagged;

  const lists = await Promise.all(
    NO_BUILD_QUERIES.map(q =>
      searchPlaces({
        query: q,
        centerLat: opts.centerLat,
        centerLng: opts.centerLng,
        radiusM: opts.radiusM ?? 8000,
        maxResults: 10,
        hardFilter: true,
      }).catch(() => [] as Poi[]),
    ),
  );

  // Large-footprint features span many hexes, but Places gives us only a single
  // centroid point. For these, flag the centroid's hex AND its surrounding ring
  // so a campus/airport doesn't leave its edges green. Point-like features (a
  // single hospital building) flag only their own hex.
  const LARGE_FOOTPRINT = new Set<string>([
    "airport", "international_airport", "national_park",
    "state_park", "military_base", "forest", "campground",
  ]);

  for (const list of lists) {
    for (const p of list) {
      const t = (p.primaryType ?? "").toLowerCase();
      // searchPlaces only returns primaryType in its mask; treat that as the
      // authoritative type signal here.
      if (!NO_BUILD_GOOGLE_TYPES.has(t)) continue;
      const center = h3.latLngToCell(p.lat, p.lng, res);
      if (LARGE_FOOTPRINT.has(t)) {
        for (const h of h3.gridDisk(center, 1)) flagged.add(h); // center + 6 neighbours
      } else {
        flagged.add(center);
      }
    }
  }
  return flagged;
}
