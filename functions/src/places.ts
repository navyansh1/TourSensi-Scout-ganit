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
  // Deduplicate by Places id
  const map = new Map<string, Poi>();
  for (const list of results) for (const p of list) map.set(p.id, { ...p, brand: opts.brandKeywords[0] });
  return Array.from(map.values());
}
