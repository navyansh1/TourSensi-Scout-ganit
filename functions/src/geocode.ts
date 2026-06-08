// Geocoding via Google. Used to turn "Anna Nagar, Chennai" into lat/lng + bbox.

import axios from "axios";

export interface GeocodeResult {
  formattedAddress: string;
  lat: number;
  lng: number;
  bbox: { south: number; west: number; north: number; east: number };
  area: string;
  city: string;
  pin?: string;
  // True when the match is broad (a whole city / district / state) rather than a
  // specific neighbourhood. The UI uses this to nudge the user to be more precise.
  broad: boolean;
  matchLevel: string;
}

// Reverse-geocode a point to a human locality name (e.g. "Velachery, Chennai").
// Used to label expansion gaps so the user sees a place, not just coordinates.
export async function reverseGeocodeLocality(lat: number, lng: number): Promise<string | null> {
  const key = process.env.GOOGLE_MAPS_SERVER_KEY;
  if (!key) return null;
  try {
    const resp = await axios.get("https://maps.googleapis.com/maps/api/geocode/json", {
      params: { latlng: `${lat},${lng}`, region: "in", key,
        result_type: "sublocality|neighborhood|locality|administrative_area_level_2" },
      timeout: 8_000,
    });
    const results = resp.data?.results ?? [];
    let neighbourhood = "", locality = "";
    for (const r of results) {
      for (const c of r.address_components ?? []) {
        if (!neighbourhood && (c.types.includes("sublocality") || c.types.includes("neighborhood"))) neighbourhood = c.long_name;
        if (!locality && c.types.includes("locality")) locality = c.long_name;
      }
    }
    if (neighbourhood && locality && neighbourhood !== locality) return `${neighbourhood}, ${locality}`;
    return neighbourhood || locality || null;
  } catch {
    return null;
  }
}

export async function geocodeIndia(query: string): Promise<GeocodeResult | null> {
  const key = process.env.GOOGLE_MAPS_SERVER_KEY;
  if (!key) throw new Error("GOOGLE_MAPS_SERVER_KEY not set");

  const url = "https://maps.googleapis.com/maps/api/geocode/json";
  const resp = await axios.get(url, {
    params: { address: query, region: "in", components: "country:IN", key },
    timeout: 10_000,
  });

  const r = resp.data?.results?.[0];
  if (!r) return null;

  const loc = r.geometry.location;

  // Google's viewport varies wildly by place type (a whole sublocality can return
  // a 10km+ box). For a granular, neighborhood-level analysis we clamp the box to
  // a fixed ~2.5km half-width around the center. This keeps the heatmap zoomed in
  // and the hex count manageable instead of blanketing a huge area.
  const HALF_KM = 2.5;
  const dLat = HALF_KM / 111; // ~111 km per degree latitude
  const dLng = HALF_KM / (111 * Math.cos((loc.lat * Math.PI) / 180));
  const vp = {
    northeast: { lat: loc.lat + dLat, lng: loc.lng + dLng },
    southwest: { lat: loc.lat - dLat, lng: loc.lng - dLng },
  };

  let area = "";
  let city = "";
  let pin: string | undefined;
  for (const c of r.address_components ?? []) {
    if (c.types?.includes("sublocality_level_1") || c.types?.includes("sublocality")) area = c.long_name;
    if (c.types?.includes("locality")) city = c.long_name;
    if (!area && c.types?.includes("neighborhood")) area = c.long_name;
    if (c.types?.includes("postal_code")) pin = c.long_name;
  }
  if (!city) {
    for (const c of r.address_components ?? []) {
      if (c.types?.includes("administrative_area_level_2")) city = c.long_name;
    }
  }
  if (!area) area = city;

  // Decide how specific the match is. If the top result is a whole city /
  // district / state (and not a sublocality/neighborhood/premise), it's "broad".
  const types: string[] = r.types ?? [];
  const SPECIFIC = ["sublocality", "sublocality_level_1", "neighborhood", "premise", "route", "street_address", "point_of_interest", "establishment"];
  const BROAD = ["locality", "administrative_area_level_1", "administrative_area_level_2", "administrative_area_level_3", "country"];
  const hasSpecific = types.some(t => SPECIFIC.includes(t));
  const broad = !hasSpecific && types.some(t => BROAD.includes(t));
  const matchLevel = types[0] ?? "unknown";

  return {
    formattedAddress: r.formatted_address,
    lat: loc.lat,
    lng: loc.lng,
    bbox: {
      south: vp.southwest.lat,
      west: vp.southwest.lng,
      north: vp.northeast.lat,
      east: vp.northeast.lng,
    },
    area,
    city,
    pin: pin ?? await reversePin(loc.lat, loc.lng, key),
    broad,
    matchLevel,
  };
}

// Reverse-geocode lat/lng to find a PIN when the area name didn't include one.
async function reversePin(lat: number, lng: number, key: string): Promise<string | undefined> {
  try {
    const resp = await axios.get("https://maps.googleapis.com/maps/api/geocode/json", {
      params: { latlng: `${lat},${lng}`, key, result_type: "postal_code" },
      timeout: 8_000,
    });
    for (const r of resp.data?.results ?? []) {
      for (const c of r.address_components ?? []) {
        if (c.types?.includes("postal_code")) return c.long_name;
      }
    }
  } catch {}
  return undefined;
}
