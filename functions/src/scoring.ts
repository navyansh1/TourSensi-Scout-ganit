// Scoring engine: turns raw signals into per-hex scores for the heatmap.
//
// Updated to fix the "every hex shows score 50" problem:
//  - Per-quadrant growth score (NE/NW/SE/SW) instead of one flat number
//  - Distance-from-center gradient (closer = slight bump, since centers usually
//    have higher footfall in Indian cities)
//  - Noise injected in saturation when competitor counts are all zero, so hexes
//    differentiate visually
//  - Each recommendation gets a TAG (BEST OVERALL, GROWTH PLAY, etc.)

import * as h3 from "h3-js";
import type { Poi } from "./places";
import type { OsmPoi } from "./osm";
import type { RealEstateSignals } from "./realestate";
import { VERTICAL_WEIGHTS, type Vertical } from "./companies";
import { hexContext, proximityPhrase, type ContextPoi, type NearestAmenity } from "./context";

export const HEX_RES = 8;

export type RecTag = "BEST_OVERALL" | "GROWTH_PLAY" | "SAFE_BET" | "UNDERSERVED" | "PREMIUM_PICK";

export interface HexScore {
  hex: string;
  lat: number;
  lng: number;
  demand: number;
  saturation: number;
  access: number;
  growth: number;
  final: number;
  signals: {
    competitorCount: number;
    ownBrandCount: number;
    pricePerSqft: number | null;
    underConstructionShare: number;
    distanceKm: number;
    nearest: NearestAmenity[];     // closest relevant amenities for this hex
    proximityPhrase: string;       // human phrase, e.g. "320 m from a metro · 540 m from a mall"
    noBuild?: boolean;             // true when the hex sits on no-build land (railway/airport/water/forest)
  };
  tag?: RecTag;
  tagReason?: string;
}

export interface QuadrantScore { quadrant: "NE" | "NW" | "SE" | "SW"; growthScore: number; headline: string }

export interface ScoreInputs {
  vertical: Vertical;
  bbox: { south: number; west: number; north: number; east: number };
  center: { lat: number; lng: number };
  competitors: Poi[];
  ownBrand: Poi[];
  osmBackdrop: OsmPoi[];
  contextPois: ContextPoi[];
  realEstate: RealEstateSignals | null;
  growthScore: number;
  quadrantScores: QuadrantScore[];
  // 0..100 demand contribution derived from real WorldPop population density
  // for the area (applied area-wide). null when unavailable.
  populationDemand?: number | null;
  // Hex ids to omit entirely (e.g. ocean/sea hexes detected via elevation).
  excludeHexes?: Set<string>;
  // Hex ids to floor to near-zero (kept on the map but never recommended) —
  // no-build land: railways, airports, rivers/lakes, large forests.
  penalizeHexes?: Set<string>;
}

export function hexesInBbox(bbox: { south: number; west: number; north: number; east: number }): string[] {
  const polygon: [number, number][] = [
    [bbox.south, bbox.west],
    [bbox.south, bbox.east],
    [bbox.north, bbox.east],
    [bbox.north, bbox.west],
  ];
  return h3.polygonToCells(polygon, HEX_RES);
}

// Centre lat/lng for each hex in the bbox — used to query elevation/water
// before scoring so we can drop ocean hexes.
export function hexCenters(bbox: { south: number; west: number; north: number; east: number }): { hex: string; lat: number; lng: number }[] {
  return hexesInBbox(bbox).map(hex => {
    const [lat, lng] = h3.cellToLatLng(hex);
    return { hex, lat, lng };
  });
}

function pointHex(lat: number, lng: number): string {
  return h3.latLngToCell(lat, lng, HEX_RES);
}

function countPerHex<T extends { lat: number; lng: number }>(items: T[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const it of items) {
    const h = pointHex(it.lat, it.lng);
    m.set(h, (m.get(h) ?? 0) + 1);
  }
  return m;
}

function norm(x: number, mid: number): number {
  return Math.round(100 / (1 + Math.exp(-(x - mid) / (mid * 0.5 + 1))));
}

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function quadrantOf(lat: number, lng: number, center: { lat: number; lng: number }): "NE" | "NW" | "SE" | "SW" {
  const ns = lat >= center.lat ? "N" : "S";
  const ew = lng >= center.lng ? "E" : "W";
  return `${ns}${ew}` as any;
}

// Hash hex string to a stable [0,1) pseudo-random — used for tie-breaking noise
function hexHash(hex: string): number {
  let h = 0;
  for (let i = 0; i < hex.length; i++) h = (h * 31 + hex.charCodeAt(i)) >>> 0;
  return (h % 10000) / 10000;
}

export interface PlaceQuality {
  avgRating: number | null;
  totalReviews: number;
  closedShare: number;     // 0..1 share of permanently-closed nearby businesses
  demandDelta: number;     // signed modifier to apply to demand
}

// Aggregate Google Places quality fields across the competitor set.
export function placeQuality(competitors: Poi[]): PlaceQuality {
  if (!competitors.length) return { avgRating: null, totalReviews: 0, closedShare: 0, demandDelta: 0 };
  let ratingSum = 0, ratingN = 0, reviews = 0, closed = 0, withStatus = 0;
  for (const p of competitors) {
    if (typeof p.rating === "number") { ratingSum += p.rating; ratingN++; }
    if (typeof p.userRatings === "number") reviews += p.userRatings;
    if (p.businessStatus) {
      withStatus++;
      if (p.businessStatus === "CLOSED_PERMANENTLY") closed++;
    }
  }
  const avgRating = ratingN ? ratingSum / ratingN : null;
  const closedShare = withStatus ? closed / withStatus : 0;

  // Build the modifier:
  //  + up to ~6 for strong ratings (>4.0 good, 3.0 neutral)
  //  + up to ~6 for healthy review volume (proven footfall, log-scaled)
  //  - up to ~14 when a large share of nearby businesses are shuttered
  const ratingDelta = avgRating != null ? Math.max(-4, Math.min(6, (avgRating - 3.6) * 6)) : 0;
  const reviewDelta = Math.min(6, Math.log10(reviews + 1) * 2.2);
  const closedDelta = -closedShare * 14;
  const demandDelta = Math.round(ratingDelta + reviewDelta + closedDelta);

  return { avgRating, totalReviews: reviews, closedShare, demandDelta };
}

export function scoreHexes(inputs: ScoreInputs): HexScore[] {
  // Drop excluded (e.g. ocean/sea) hexes up front so they never get scored or drawn.
  const exclude = inputs.excludeHexes;
  const hexes = hexesInBbox(inputs.bbox).filter(h => !exclude || !exclude.has(h));
  const competitorByHex = countPerHex(inputs.competitors);
  const ownByHex = countPerHex(inputs.ownBrand);
  const osmDemandByHex = countPerHex(inputs.osmBackdrop);

  const weights = VERTICAL_WEIGHTS[inputs.vertical];
  const maxDist = Math.max(
    haversineKm({ lat: inputs.bbox.north, lng: inputs.bbox.east }, inputs.center),
    0.01,
  );

  // Quadrant lookup
  const qLookup: Record<string, number> = {};
  for (const q of inputs.quadrantScores) qLookup[q.quadrant] = q.growthScore;

  // --- Area-level "place quality" signal from Google Places fields ---------
  // These come free in the competitor search. They tell us whether the
  // surrounding commerce is *thriving* (lots of reviews, high ratings = proven
  // footfall) or *dying* (many permanently-closed businesses). Applied as a
  // gentle area-wide demand modifier so a busy, well-reviewed high street reads
  // better than an equally-dense but stagnant or shuttered one.
  const quality = placeQuality(inputs.competitors);

  return hexes.map(hex => {
    const [lat, lng] = h3.cellToLatLng(hex);

    const competitorCount = competitorByHex.get(hex) ?? 0;
    const ownBrandCount = ownByHex.get(hex) ?? 0;
    const osmAround = osmDemandByHex.get(hex) ?? 0;
    const noise = hexHash(hex);  // 0..1

    // Wealth proxy from real-estate prices. Neutral midpoint is 40 (not 50) and
    // we only treat it as a real signal when we actually have price data —
    // otherwise it's a weak, slightly-below-average prior, not a free +50.
    const wealth = inputs.realEstate?.medianPricePerSqft
      ? Math.max(0, Math.min(100, (Math.log10(inputs.realEstate.medianPricePerSqft) - 3.4) * 70))
      : 38;

    // Distance bump: modest centrality nudge, fades to 0 at the bbox edge.
    const distKm = haversineKm({ lat, lng }, inputs.center);
    const distBump = Math.max(0, 8 * (1 - distKm / maxDist));

    // Real, vertical-specific nearby context (metro/mall/highway/port/etc.).
    const ctx = hexContext(lat, lng, inputs.vertical, inputs.contextPois);

    // --- DEMAND ---------------------------------------------------------
    // Real demand must come from something concrete nearby (POI density,
    // demand-amenities like schools/malls/offices, or local affluence). An
    // empty hex with no signals should score LOW, not float at 50.
    const osmDemand = norm(osmAround, 6);             // 0..100, needs ~6 POIs to read "average"
    const hasAnyDemandSignal = osmAround > 0 || ctx.demandBoost > 2;
    // Real population density (WorldPop) is the strongest available demand signal.
    // When present it carries the most weight; otherwise we lean on POI fabric.
    const pop = inputs.populationDemand;
    const hasPop = typeof pop === "number" && pop > 0;
    let demand = Math.round(
      Math.max(0, Math.min(100,
        (hasPop
          ? 0.42 * (pop as number) + 0.20 * osmDemand
          : 0.40 * osmDemand) +
        0.18 * wealth +
        0.25 * (50 + ctx.demandBoost) +   // amenity boost centered on 50, +/- up to 40
        distBump * 0.4 +
        (noise * 4)
      )),
    );
    // Hard reality check: nothing nearby = genuinely weak demand. (Skipped when we
    // have a real population reading, which is more reliable than POI presence.)
    if (!hasAnyDemandSignal && !hasPop) demand = Math.round(demand * 0.45);
    // Place-quality modifier: thriving, well-reviewed commerce lifts demand;
    // a high closed-business share drags it down. Capped to a gentle ±12.
    demand = Math.round(Math.max(0, Math.min(100, demand + quality.demandDelta)));

    // --- SATURATION (shown as "free space"; higher = less competition) --
    // An empty area is only an *opportunity* if there's demand to capture.
    // Pure emptiness with no demand is a barren field, not a white-space win,
    // so we cap the free-space score by how much demand exists.
    const saturationLoad = competitorCount + ownBrandCount * 1.5;
    const rawFreeSpace = saturationLoad === 0
      ? 78 + noise * 12                       // empty: high, but not an automatic 95
      : 100 - norm(saturationLoad, 2.5);      // each competitor bites harder now
    const demandCeiling = 40 + demand * 0.6;  // can't be "great white space" with no demand
    const saturation = Math.round(Math.max(0, Math.min(rawFreeSpace, saturationLoad === 0 ? demandCeiling : rawFreeSpace)));

    // --- ACCESS ---------------------------------------------------------
    // Needs a real access signal (transit/road amenities or POI fabric).
    // Bare centrality alone no longer carries a hex to a good access score.
    const accessAmenity = 45 + ctx.accessBoost;   // centered 45, +/- up to 40
    let access = Math.round(
      Math.max(0, Math.min(100,
        0.55 * accessAmenity +
        0.30 * norm(osmAround, 4) +
        distBump * 0.6
      )),
    );
    if (ctx.accessBoost <= 0 && osmAround === 0) access = Math.round(access * 0.6);

    // --- GROWTH (per-quadrant, from the AI agent) -----------------------
    const q = quadrantOf(lat, lng, inputs.center);
    const growth = qLookup[q] ?? inputs.growthScore;

    // --- FINAL ----------------------------------------------------------
    let final = Math.round(
      demand * weights.demand +
      saturation * weights.saturation +
      access * weights.access +
      growth * weights.growth +
      (noise - 0.5) * 4
    );
    // Viability gate: a site can't be genuinely good where there's almost no
    // demand and no access, regardless of low competition. Pull such hexes down.
    if (demand < 30 && access < 35) final = Math.round(final * 0.7);
    final = Math.max(0, Math.min(100, final));

    // No-build land (railway / airport / river-lake / forest): floor the score so
    // the hex reads red and can never be recommended. We keep it on the map (not
    // deleted) because OSM polygons can be imperfect — flooring is the safe call.
    const noBuild = inputs.penalizeHexes?.has(hex) ?? false;
    if (noBuild) final = Math.min(final, 8);

    return {
      hex, lat, lng,
      demand, saturation, access, growth, final,
      signals: {
        competitorCount,
        ownBrandCount,
        pricePerSqft: inputs.realEstate?.medianPricePerSqft ?? null,
        underConstructionShare: inputs.realEstate?.underConstructionShare ?? 0,
        distanceKm: Number(distKm.toFixed(2)),
        nearest: ctx.nearest.slice(0, 6),
        proximityPhrase: proximityPhrase(ctx.nearest),
        ...(noBuild ? { noBuild: true } : {}),
      },
    };
  });
}

// Tag each top-5 recommendation with a distinct angle so the user can tell them apart.
export function topRecommendations(scored: HexScore[], n: number = 5): HexScore[] {
  const candidates = [...scored]
    .filter(h => h.signals.competitorCount + h.signals.ownBrandCount <= 1)
    .sort((a, b) => b.final - a.final)
    .slice(0, 20); // take top 20, then diversify

  const picks: HexScore[] = [];

  // 1. BEST OVERALL: highest final
  if (candidates[0]) picks.push({ ...candidates[0], tag: "BEST_OVERALL", tagReason: "Top composite score across all dimensions" });

  // 2. GROWTH PLAY: highest growth sub-score
  const growth = [...candidates].sort((a, b) => b.growth - a.growth).find(c => !picks.some(p => p.hex === c.hex));
  if (growth) picks.push({ ...growth, tag: "GROWTH_PLAY", tagReason: "Highest future-growth signal in the area" });

  // 3. SAFE BET: highest access + highest demand combined
  const safe = [...candidates].sort((a, b) => (b.demand + b.access) - (a.demand + a.access)).find(c => !picks.some(p => p.hex === c.hex));
  if (safe) picks.push({ ...safe, tag: "SAFE_BET", tagReason: "Strong existing demand and accessibility" });

  // 4. UNDERSERVED: highest saturation (= least competition)
  const under = [...candidates].sort((a, b) => b.saturation - a.saturation).find(c => !picks.some(p => p.hex === c.hex));
  if (under) picks.push({ ...under, tag: "UNDERSERVED", tagReason: "Zero or near-zero competition nearby" });

  // 5. PREMIUM PICK: highest pricePerSqft proxy → wealthier sub-area
  const premium = [...candidates].sort((a, b) => (b.signals.pricePerSqft ?? 0) - (a.signals.pricePerSqft ?? 0)).find(c => !picks.some(p => p.hex === c.hex));
  if (premium) picks.push({ ...premium, tag: "PREMIUM_PICK", tagReason: "Wealthiest segment based on real-estate prices" });

  // Fill remaining slots if any
  while (picks.length < n) {
    const next = candidates.find(c => !picks.some(p => p.hex === c.hex));
    if (!next) break;
    picks.push(next);
  }
  return picks.slice(0, n);
}
