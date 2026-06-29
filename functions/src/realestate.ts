// Real-estate ₹/sqft signals. Primary source is our own direct MagicBricks
// scraper (free, no anti-bot — see magicbricks.ts); Apify's 99acres actor is an
// optional fallback only (99acres 403-blocks direct access, and the actor is
// paid/rate-limited, so we prefer the direct scrape). Results are cached in
// Firestore (collection: realestate) keyed by city+area so we don't re-scrape
// on every click.

import { ApifyClient } from "apify-client";
import * as admin from "firebase-admin";
import { fetchMagicBricksDirect } from "./magicbricks";
import { aiResolveSlug } from "./agent";

const ACRES99_ACTOR = "easyapi/99acres-com-scraper";

export interface PropertyListing {
  title: string;
  url?: string;
  price?: number;
  pricePerSqft?: number;
  bhk?: number;
  area?: string;
  status?: string;
}

export interface RealEstateSignals {
  area: string;
  city: string;
  source: "magicbricks" | "99acres" | "merged";
  sampleSize: number;
  medianPricePerSqft: number | null;
  medianPrice: number | null;
  avgBHK: number | null;
  underConstructionShare: number;   // 0..1
  listings: PropertyListing[];      // up to 10 sample listings to show in the UI
  fetchedAt: number;
  aiEstimated?: boolean;            // true when price came from the AI fallback, not a scrape
  aiNote?: string;                  // short AI note about the local property market
}

function client() {
  const token = process.env.APIFY_TOKEN;
  if (!token) throw new Error("APIFY_TOKEN not set");
  return new ApifyClient({ token });
}

function cacheKey(city: string, area: string) {
  return `${city.toLowerCase().trim()}__${area.toLowerCase().trim()}`.replace(/[^a-z0-9_]/g, "_");
}

export async function getRealEstateSignals(opts: { city: string; area: string; freshHours?: number }): Promise<RealEstateSignals> {
  const ref = admin.firestore().collection("realestate").doc(cacheKey(opts.city, opts.area));
  const fresh = (opts.freshHours ?? 24 * 7) * 3600 * 1000;
  const snap = await ref.get();
  if (snap.exists) {
    const data = snap.data() as RealEstateSignals;
    if (Date.now() - data.fetchedAt < fresh) return data;
  }

  // Primary: our own direct MagicBricks scraper (free, reliable, no Apify).
  // Pass the AI slug resolver as a last-resort fallback for odd-spelling
  // localities whose deterministic URL variants all 404 (~5% of cases).
  const sources: RealEstateSignals[] = [];
  const mb = await fetchMagicBricksDirect(opts, aiResolveSlug).catch(() => null);
  if (mb && mb.sampleSize > 0) sources.push(mb);

  // Fallback: Apify 99acres actor, only if the direct scrape returned nothing
  // and a token is configured. Skipped entirely on the happy path.
  if (!sources.length && process.env.APIFY_TOKEN) {
    const acres = await fetch99acres(opts).catch(() => null);
    if (acres) sources.push(acres);
  }

  const merged = mergeSignals(opts, sources);
  await ref.set(merged);
  return merged;
}

async function fetch99acres(opts: { city: string; area: string }): Promise<RealEstateSignals | null> {
  try {
    const run = await client().actor(ACRES99_ACTOR).call(
      { city: opts.city, locality: opts.area, maxItems: 30 },
      { timeout: 120 },
    );
    const { items } = await client().dataset(run.defaultDatasetId).listItems();
    if (items.length) console.log("99acres sample keys:", Object.keys(items[0] ?? {}).slice(0, 30).join(","));
    return computeSignals(opts, items, "99acres");
  } catch (e) {
    console.warn("99acres scrape failed:", (e as Error).message);
    return null;
  }
}

// The actors return slightly different schemas, so we normalize liberally.
function computeSignals(
  opts: { city: string; area: string },
  items: any[],
  source: "magicbricks" | "99acres",
): RealEstateSignals {
  if (!items?.length) {
    return { area: opts.area, city: opts.city, source, sampleSize: 0, medianPricePerSqft: null, medianPrice: null, avgBHK: null, underConstructionShare: 0, listings: [], fetchedAt: Date.now() };
  }

  const pricesPerSqft: number[] = [];
  const prices: number[] = [];
  const bhks: number[] = [];
  let underConstruction = 0;

  // The actors return varied schemas — we look across many common field name spellings.
  for (const it of items) {
    const pps = num(it.pricePerSqft ?? it.rate ?? it.psf ?? it.price_per_sqft ?? it.pricePerSqFt ?? it.sqft_rate ?? it.ratePerSqft);
    if (pps) pricesPerSqft.push(pps);
    const price = num(it.price ?? it.totalPrice ?? it.total_price ?? it.priceValue ?? it.cost);
    if (price) prices.push(price);
    const bhk = num(it.bhk ?? it.bedrooms ?? it.bhkValue ?? it.beds ?? it.configuration);
    if (bhk) bhks.push(bhk);
    const statusStr = [it.status, it.possession, it.possessionStatus, it.construction_status, it.constructionStatus, it.availability, it.title, it.propertyTitle].filter(Boolean).join(" ").toLowerCase();
    if (statusStr.includes("under construction") || statusStr.includes("possession") || statusStr.includes("2026") || statusStr.includes("2027") || statusStr.includes("ready to move")) underConstruction++;
  }

  const listings: PropertyListing[] = items.slice(0, 10).map((it: any): PropertyListing => ({
    title: String(it.title ?? it.propertyTitle ?? it.name ?? `${it.bhk ?? ""} BHK in ${opts.area}`).trim().slice(0, 120),
    url: it.url ?? it.detailUrl ?? it.link ?? undefined,
    price: num(it.price ?? it.totalPrice ?? it.priceValue) ?? undefined,
    pricePerSqft: num(it.pricePerSqft ?? it.rate ?? it.psf ?? it.ratePerSqft) ?? undefined,
    bhk: num(it.bhk ?? it.bedrooms) ?? undefined,
    area: it.locality ?? it.area ?? opts.area,
    status: String(it.status ?? it.possession ?? it.availability ?? "").slice(0, 80),
  }));

  return {
    area: opts.area,
    city: opts.city,
    source,
    sampleSize: items.length,
    medianPricePerSqft: median(pricesPerSqft),
    medianPrice: median(prices),
    avgBHK: bhks.length ? bhks.reduce((a, b) => a + b, 0) / bhks.length : null,
    underConstructionShare: items.length ? underConstruction / items.length : 0,
    listings,
    fetchedAt: Date.now(),
  };
}

function mergeSignals(opts: { city: string; area: string }, sources: RealEstateSignals[]): RealEstateSignals {
  if (!sources.length) {
    return { area: opts.area, city: opts.city, source: "merged", sampleSize: 0, medianPricePerSqft: null, medianPrice: null, avgBHK: null, underConstructionShare: 0, listings: [], fetchedAt: Date.now() };
  }
  if (sources.length === 1) return sources[0];

  const total = sources.reduce((s, x) => s + x.sampleSize, 0);
  const w = (x: RealEstateSignals) => x.sampleSize / total;

  return {
    area: opts.area,
    city: opts.city,
    source: "merged",
    sampleSize: total,
    medianPricePerSqft: weightedAvg(sources.map(s => [s.medianPricePerSqft, w(s)])),
    medianPrice: weightedAvg(sources.map(s => [s.medianPrice, w(s)])),
    avgBHK: weightedAvg(sources.map(s => [s.avgBHK, w(s)])),
    underConstructionShare: sources.reduce((s, x) => s + (x.underConstructionShare * w(x)), 0),
    listings: sources.flatMap(s => s.listings).slice(0, 10),
    fetchedAt: Date.now(),
  };
}

function num(x: any): number | null {
  if (x == null) return null;
  if (typeof x === "number") return Number.isFinite(x) ? x : null;
  const cleaned = String(x).replace(/[^0-9.]/g, "");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function median(arr: number[]): number | null {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function weightedAvg(pairs: [number | null, number][]): number | null {
  let n = 0, w = 0;
  for (const [v, weight] of pairs) {
    if (v != null) { n += v * weight; w += weight; }
  }
  return w > 0 ? n / w : null;
}
