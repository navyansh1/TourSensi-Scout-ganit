// Expansion Planner ("My Network") — fast, batched scoring of an uploaded
// portfolio of existing locations PLUS a gap-finder that recommends where to
// expand next.
//
// Speed strategy: this is the "Lite" scoring path. Unlike the single-site
// /analyze pipeline it deliberately SKIPS the slow parts (99acres Apify scrape,
// the 12-call Gemini growth agent, per-hex elevation/landuse passes). It keeps
// only the fast, parallelisable signals — Google Places (competitors + footfall
// anchors), WorldPop population density, and place-quality (ratings / reviews /
// permanently-closed share). That takes ~2-4s per site instead of ~30s, so a
// 50-site network finishes in well under a minute when run in batches.
//
// A precise rupee revenue figure is intentionally NOT produced here — the UI
// shows a fast heuristic footfall index + revenue band, and asks Gemini for a
// grounded ₹ estimate only on demand when the user clicks a specific site.

import * as h3 from "h3-js";
import { competitorsInArea } from "./places";
import { fetchContextPois, hexContext } from "./context";
import { bboxPopulation, densityToDemand } from "./worldpop";
import { placeQuality } from "./scoring";
import { VERTICAL_PLACES_TYPE, type Vertical } from "./companies";
import type { Poi } from "./places";
import type { ContextPoi } from "./context";

const HEX_RES = 8;
const SITE_RADIUS_M = 2500;       // footfall/competition catchment per existing site
const MAX_BATCH = 8;              // sites scored concurrently (Places rate-limit friendly)
const MAX_SITES = 120;            // hard cap so a giant upload can't run forever
const MAX_SPAN_KM = 30;           // regional bbox is capped to roughly city size

// Vertical-aware trade-area radius — a gap hex within this distance of one of
// the user's own sites is considered "already covered" and excluded.
const TRADE_AREA_KM: Record<Vertical, number> = {
  BFSI_ATM: 0.8,
  BFSI_BRANCH: 1.5,
  FMCG_RETAIL: 1.2,
  FMCG_WAREHOUSE: 3.0,
};

export interface PortfolioSite {
  name: string;
  lat: number;
  lng: number;
  branchId?: string;
  type?: string;
  health: number;            // 0..100 composite health of this existing site
  footfallIndex: number;     // 0..100 relative footfall signal
  revenueBand: "Low" | "Moderate" | "Strong" | "Premium";
  competitorCount: number;
  avgCompetitorRating: number | null;
  closedShare: number;       // share of nearby businesses permanently closed
  populationDensity: number | null;
  verdict: "STRONG" | "STABLE" | "WEAK";
  note: string;
}

// One transparent scoring factor — the building blocks of "why here".
export interface ScoreFactor {
  label: string;             // e.g. "Population density"
  value: string;             // e.g. "23,780 people/km² (dense urban)"
  impact: "positive" | "neutral" | "negative";
  weightNote?: string;       // how it moved the score, e.g. "+18 to demand"
}

export interface ExpansionGap {
  rank: number;
  lat: number;
  lng: number;
  hex: string;
  score: number;             // 0..100 expansion attractiveness
  footfallIndex: number;
  revenueBand: PortfolioSite["revenueBand"];
  competitorCount: number;   // competition already proving the market exists
  nearestOwnKm: number;      // distance to the closest existing site of yours
  reason: string;            // short one-liner (kept for compactness)
  factors: ScoreFactor[];    // transparent breakdown of every signal that moved the score
  nearbyAnchors: { label: string; name: string; meters: number; id?: string; lat?: number; lng?: number }[];  // schools/malls/metro/etc nearby
  populationDensity: number | null;
  rationale?: string;        // detailed AI-written narrative ("why this exact spot")
}

// A lightweight scored hex for the regional heatmap.
export interface HeatHex {
  hex: string;
  lat: number;
  lng: number;
  score: number;         // 0..100 (footfall+market based — the expansion-attractiveness surface)
  ownCovered: boolean;   // sits inside an existing site's trade area
}

export interface PortfolioResult {
  vertical: Vertical;
  sites: PortfolioSite[];
  gaps: ExpansionGap[];
  heat: HeatHex[];         // full regional grid for the heatmap
  regional: {
    bbox: { south: number; west: number; north: number; east: number };
    center: { lat: number; lng: number };
    siteCount: number;
    avgHealth: number;
    weakCount: number;
    populationDensity: number | null;
  };
}

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Build a bbox tight around all sites, padded a little, then clamped so its
// span never exceeds MAX_SPAN_KM (keeps the WorldPop + hex grid bounded).
function regionalBbox(sites: { lat: number; lng: number }[]): {
  bbox: { south: number; west: number; north: number; east: number };
  center: { lat: number; lng: number };
} {
  let south = 90, north = -90, west = 180, east = -180;
  for (const s of sites) {
    south = Math.min(south, s.lat); north = Math.max(north, s.lat);
    west = Math.min(west, s.lng); east = Math.max(east, s.lng);
  }
  const center = { lat: (south + north) / 2, lng: (west + east) / 2 };
  // Pad ~2.5 km so single-point uploads still get a region around them.
  const padLat = 2.5 / 111;
  const padLng = 2.5 / (111 * Math.cos((center.lat * Math.PI) / 180) || 1);
  south -= padLat; north += padLat; west -= padLng; east += padLng;

  // Clamp span to MAX_SPAN_KM around the center.
  const halfLat = MAX_SPAN_KM / 2 / 111;
  const halfLng = MAX_SPAN_KM / 2 / (111 * Math.cos((center.lat * Math.PI) / 180) || 1);
  south = Math.max(south, center.lat - halfLat);
  north = Math.min(north, center.lat + halfLat);
  west = Math.max(west, center.lng - halfLng);
  east = Math.min(east, center.lng + halfLng);

  return { bbox: { south, west, north, east }, center };
}

function bandFromIndex(index: number): PortfolioSite["revenueBand"] {
  if (index >= 78) return "Premium";
  if (index >= 60) return "Strong";
  if (index >= 40) return "Moderate";
  return "Low";
}

// Run an async mapper over items in fixed-size concurrent batches.
async function inBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    const slice = items.slice(i, i + size);
    out.push(...(await Promise.all(slice.map(fn))));
  }
  return out;
}

// Lite per-site signal fetch: competitors + footfall anchors within the
// catchment. Cheap (a couple of Places calls), fully parallelisable.
async function siteSignals(
  site: { lat: number; lng: number },
  vertical: Vertical,
): Promise<{ competitors: Poi[]; context: ContextPoi[] }> {
  const placeType = VERTICAL_PLACES_TYPE[vertical];
  const [competitors, context] = await Promise.all([
    competitorsInArea({ category: placeType, centerLat: site.lat, centerLng: site.lng, radiusM: SITE_RADIUS_M }).catch(() => [] as Poi[]),
    fetchContextPois({ vertical, centerLat: site.lat, centerLng: site.lng, radiusM: SITE_RADIUS_M }).catch(() => [] as ContextPoi[]),
  ]);
  return { competitors, context };
}

// Turn raw signals into a 0..100 footfall index for a point.
function footfallFor(
  point: { lat: number; lng: number },
  vertical: Vertical,
  context: ContextPoi[],
  competitors: Poi[],
  populationDemand: number | null,
): number {
  const ctx = hexContext(point.lat, point.lng, vertical, context);
  const q = placeQuality(competitors);
  // Review volume across nearby commerce is a strong real-world footfall proxy.
  const reviewSignal = Math.min(40, Math.log10((q.totalReviews || 0) + 1) * 12);
  const popSignal = populationDemand != null ? populationDemand * 0.35 : 0;
  const amenitySignal = Math.max(0, ctx.demandBoost) * 0.6; // schools/malls/offices nearby
  const base = populationDemand != null ? 18 : 28; // small floor so empty isn't 0
  return Math.max(0, Math.min(100, Math.round(base + popSignal + reviewSignal + amenitySignal)));
}

export async function planExpansion(opts: {
  vertical: Vertical;
  locations: { name: string; lat: number; lng: number; branchId?: string; type?: string }[];
}): Promise<PortfolioResult> {
  const vertical = opts.vertical;
  const sites = opts.locations
    .filter(l => Number.isFinite(l.lat) && Number.isFinite(l.lng))
    .slice(0, MAX_SITES);

  const { bbox, center } = regionalBbox(sites);

  // One regional population read (not per-site) → shared demand signal.
  const popData = await bboxPopulation(bbox).catch(() => null);
  const populationDemand = popData ? densityToDemand(popData.densityPerKm2) : null;

  // Score every existing site in concurrent batches.
  const scoredSites: PortfolioSite[] = await inBatches(sites, MAX_BATCH, async (site) => {
    const { competitors, context } = await siteSignals(site, vertical);
    const q = placeQuality(competitors);
    const footfallIndex = footfallFor(site, vertical, context, competitors, populationDemand);

    // Health blends footfall (demand it captures) with market-health signals:
    // a high closed-business share or very thin footfall drags a site down.
    const closedPenalty = q.closedShare * 30;
    const thinPenalty = footfallIndex < 35 ? (35 - footfallIndex) * 0.6 : 0;
    const health = Math.max(0, Math.min(100, Math.round(footfallIndex - closedPenalty - thinPenalty)));

    const verdict: PortfolioSite["verdict"] = health >= 60 ? "STRONG" : health >= 42 ? "STABLE" : "WEAK";
    const noteParts: string[] = [];
    if (q.closedShare > 0.25) noteParts.push(`${Math.round(q.closedShare * 100)}% of nearby businesses are shut`);
    if (footfallIndex < 35) noteParts.push("low local footfall");
    if (competitors.length === 0) noteParts.push("no competing presence detected");
    if (q.avgRating != null && q.avgRating >= 4.2) noteParts.push("thriving, well-rated commerce around it");
    const note = noteParts.length ? noteParts.join("; ") : "stable catchment";

    return {
      name: site.name, lat: site.lat, lng: site.lng,
      branchId: site.branchId, type: site.type,
      health, footfallIndex, revenueBand: bandFromIndex(footfallIndex),
      competitorCount: competitors.length,
      avgCompetitorRating: q.avgRating,
      closedShare: q.closedShare,
      populationDensity: popData?.densityPerKm2 ?? null,
      verdict, note,
    };
  });

  // --- Gap finder -----------------------------------------------------------
  // Probe a coarse grid across the region for demand. To keep it FAST we don't
  // call Places for every hex; instead we sample the region with a handful of
  // wide competitor+context scans, then score the grid against those samples.
  const { gaps, heat } = await findGaps({
    vertical, bbox, center, sites, populationDemand,
    populationDensity: popData?.densityPerKm2 ?? null,
  });

  // (The per-gap deep rationale is now produced on-demand by /site-analysis when
  // the user taps a card — richer than the old batch call and avoids spending
  // AI tokens on gaps the user never opens.)

  const weakCount = scoredSites.filter(s => s.verdict === "WEAK").length;
  const avgHealth = scoredSites.length
    ? Math.round(scoredSites.reduce((a, s) => a + s.health, 0) / scoredSites.length)
    : 0;

  return {
    vertical, sites: scoredSites, gaps, heat,
    regional: {
      bbox, center,
      siteCount: scoredSites.length,
      avgHealth, weakCount,
      populationDensity: popData?.densityPerKm2 ?? null,
    },
  };
}

// Human label for population density buckets.
function densityLabel(d: number | null): string {
  if (d == null || d <= 0) return "unknown";
  if (d >= 20000) return "very dense urban";
  if (d >= 10000) return "dense urban";
  if (d >= 5000) return "moderately dense";
  if (d >= 2000) return "suburban";
  return "sparse";
}

// Sample the region with a small set of wide scans, then rank candidate hexes
// by demand-with-no-own-presence. Cheap: a fixed number of Places calls
// regardless of how many hexes the region contains.
async function findGaps(opts: {
  vertical: Vertical;
  bbox: { south: number; west: number; north: number; east: number };
  center: { lat: number; lng: number };
  sites: { lat: number; lng: number }[];
  populationDemand: number | null;
  populationDensity: number | null;
}): Promise<{ gaps: ExpansionGap[]; heat: HeatHex[] }> {
  const { vertical, bbox, center, sites, populationDemand, populationDensity } = opts;

  // A 3x3 set of sample anchors across the region, each covering ~3 km.
  const latStep = (bbox.north - bbox.south) / 4;
  const lngStep = (bbox.east - bbox.west) / 4;
  const anchors: { lat: number; lng: number }[] = [];
  for (let i = 1; i <= 3; i++) {
    for (let j = 1; j <= 3; j++) {
      anchors.push({ lat: bbox.south + latStep * i, lng: bbox.west + lngStep * j });
    }
  }

  const sampleSets = await inBatches(anchors, MAX_BATCH, a => siteSignals(a, vertical));
  // Union of all competitors + context POIs found across samples (deduped).
  const compMap = new Map<string, Poi>();
  const ctxMap = new Map<string, ContextPoi>();
  for (const s of sampleSets) {
    for (const c of s.competitors) compMap.set(c.id, c);
    for (const c of s.context) ctxMap.set(c.id, c);
  }
  const allCompetitors = Array.from(compMap.values());
  const allContext = Array.from(ctxMap.values());

  const tradeKm = TRADE_AREA_KM[vertical];

  // Score candidate hexes across the region.
  const polygon: [number, number][] = [
    [bbox.south, bbox.west], [bbox.south, bbox.east],
    [bbox.north, bbox.east], [bbox.north, bbox.west],
  ];
  const cells = h3.polygonToCells(polygon, HEX_RES);

  const candidates: ExpansionGap[] = [];
  const heat: HeatHex[] = [];
  for (const hex of cells) {
    const [lat, lng] = h3.cellToLatLng(hex);
    const point = { lat, lng };

    // Distance to the nearest existing own site.
    let nearestOwnKm = Infinity;
    for (const s of sites) nearestOwnKm = Math.min(nearestOwnKm, haversineKm(point, s));
    const ownCovered = nearestOwnKm < tradeKm;

    // Competition within ~1.2 km proves a live market without us crowding it.
    let competitorCount = 0;
    for (const c of allCompetitors) if (haversineKm(point, c) <= 1.2) competitorCount++;

    const footfallIndex = footfallFor(point, vertical, allContext, allCompetitors, populationDemand);
    const marketProof = Math.min(20, competitorCount * 6);
    const whitespaceBonus = competitorCount <= 3 ? 10 : 0;
    const score = Math.max(0, Math.min(100, Math.round(footfallIndex * 0.7 + marketProof + whitespaceBonus)));

    // Every hex (covered or not) feeds the heatmap surface.
    heat.push({ hex, lat, lng, score, ownCovered });

    // A gap is only a *candidate* if it's beyond our trade area AND has real
    // footfall. Pure empty land with no footfall is not a gap worth flagging.
    if (ownCovered || footfallIndex < 38) continue;

    // --- Transparent factor breakdown (the "why", in plain signals) ---------
    const ctx = hexContext(lat, lng, vertical, allContext);
    const ctxById = new Map(allContext.map(p => [p.id, p] as const));
    const anchors = ctx.nearest
      .filter(n => n.sign > 0 && n.meters <= 2500)
      .slice(0, 5)
      .map(n => {
        const poi = n.id ? ctxById.get(n.id) : undefined;
        return { label: n.label, name: n.name, meters: n.meters, id: n.id, lat: poi?.lat, lng: poi?.lng };
      });

    const factors: ScoreFactor[] = [];
    factors.push({
      label: "Population density",
      value: populationDensity != null ? `${populationDensity.toLocaleString("en-IN")} people/km² (${densityLabel(populationDensity)})` : "unknown",
      impact: populationDensity != null && populationDensity >= 8000 ? "positive" : populationDensity != null && populationDensity >= 3000 ? "neutral" : "negative",
      weightNote: populationDemand != null ? `population drives demand` : undefined,
    });
    factors.push({
      label: "Footfall index",
      value: `${footfallIndex}/100 (review volume + anchors + density)`,
      impact: footfallIndex >= 60 ? "positive" : footfallIndex >= 40 ? "neutral" : "negative",
      weightNote: `70% of the gap score`,
    });
    factors.push({
      label: "Market validation",
      value: competitorCount > 0 ? `${competitorCount} competing site(s) within 1.2 km` : "no direct competitor nearby",
      impact: competitorCount >= 1 && competitorCount <= 6 ? "positive" : competitorCount > 6 ? "negative" : "neutral",
      weightNote: competitorCount > 0 ? "competitors prove the market exists" : "unproven — first-mover risk",
    });
    factors.push({
      label: "White space",
      value: competitorCount <= 3 ? "low competition — room to capture share" : "competitive — share would be split",
      impact: competitorCount <= 3 ? "positive" : "negative",
      weightNote: competitorCount <= 3 ? "+10 white-space bonus" : "no bonus",
    });
    factors.push({
      label: "Network fit",
      value: `${nearestOwnKm.toFixed(1)} km from your nearest existing site`,
      impact: nearestOwnKm >= tradeKm * 2 ? "positive" : "neutral",
      weightNote: `clears your ${tradeKm} km trade-area (no cannibalisation)`,
    });
    if (anchors.length) {
      factors.push({
        label: "Demand anchors nearby",
        value: anchors.map(a => `${a.label} (${a.meters >= 1000 ? (a.meters / 1000).toFixed(1) + " km" : a.meters + " m"})`).join(", "),
        impact: "positive",
        weightNote: "footfall generators",
      });
    }

    const reasonParts: string[] = [];
    if (competitorCount > 0) reasonParts.push(`${competitorCount} competing site(s) nearby — validated demand`);
    else reasonParts.push("footfall signals present, no competitor yet");
    reasonParts.push(`${nearestOwnKm.toFixed(1)} km from your closest site`);

    candidates.push({
      rank: 0, lat, lng, hex, score, footfallIndex,
      revenueBand: bandFromIndex(footfallIndex),
      competitorCount,
      nearestOwnKm: Number(nearestOwnKm.toFixed(2)),
      reason: reasonParts.join(" · "),
      factors,
      nearbyAnchors: anchors,
      populationDensity,
    });
  }

  // Diversify: sort by score, then greedily pick spread-out winners so the top
  // gaps aren't all clustered in one neighbourhood.
  candidates.sort((a, b) => b.score - a.score);
  const picks: ExpansionGap[] = [];
  for (const c of candidates) {
    if (picks.length >= 6) break;
    if (picks.some(p => haversineKm(p, c) < 1.5)) continue;
    picks.push(c);
  }
  picks.forEach((p, i) => (p.rank = i + 1));
  return { gaps: picks, heat };
}
