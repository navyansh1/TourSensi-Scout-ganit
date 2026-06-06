// Google Places (New) integration — pull competitor & relevant POI locations.

import axios from "axios";

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

export async function searchPlaces(opts: {
  query: string;
  centerLat: number;
  centerLng: number;
  radiusM?: number;
  maxResults?: number;
}): Promise<Poi[]> {
  const radius = opts.radiusM ?? 3000;
  const max = opts.maxResults ?? 20;

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
  })).filter((p: Poi) => p.lat && p.lng);
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
