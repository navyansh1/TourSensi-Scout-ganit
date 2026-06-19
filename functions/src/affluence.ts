// Affluence Index — a free, transparent, area-level proxy for local wealth.
//
// WHY THIS EXISTS
// BFSI/FMCG site decisions run on affluence (a branch needs wealth, a lender
// needs repayment capacity, premium retail needs spend). Real household-income
// datasets (GeoIQ, telco) cost lakhs/yr and are black boxes. Instead we COMPOSE
// an honest 0–100 index out of signals we ALREADY pull for free, so it ships at
// ₹0 and — crucially — we can show exactly how it was built.
//
// It is DELIBERATELY a proxy, not a household-income figure. We label it as such
// everywhere. It reliably separates Koramangala from a tier-3 outskirt; it does
// NOT claim "34% of households earn >₹10L" the way a licensed dataset would.
//
// INPUTS (all already in the pipeline — no new paid calls):
//  - Property ₹/sqft (99acres)            → strongest single affluence proxy in India
//  - Places priceLevel mix (competitors)  → density of expensive venues = wealth
//  - Night-lights mean luminance (VIIRS)  → lit economic activity
// Each sub-signal is normalised 0–100, blended by weight, and we keep the
// component breakdown so the UI can show "why".
//
// Fails open: any missing signal is simply dropped and the weights renormalise.

import type { Poi } from "./places";
import type { RealEstateSignals } from "./realestate";
import type { NightlightResult } from "./nightlights";

export type AffluenceBand = "Premium" | "Upper-mid" | "Mid" | "Value" | "Low";

export interface AffluenceComponent {
  key: "property" | "priceLevel" | "nightlights";
  label: string;
  score: number;        // 0..100 sub-score
  weight: number;       // applied (renormalised) weight 0..1
  detail: string;       // human explanation, e.g. "₹9,800/sqft"
}

export interface AffluenceResult {
  index: number;                  // 0..100 composite
  band: AffluenceBand;
  components: AffluenceComponent[];
  note: string;                   // one-line honest framing
}

const PRICE_LEVEL_SCORE: Record<string, number> = {
  PRICE_LEVEL_FREE: 0,
  PRICE_LEVEL_INEXPENSIVE: 25,
  PRICE_LEVEL_MODERATE: 55,
  PRICE_LEVEL_EXPENSIVE: 85,
  PRICE_LEVEL_VERY_EXPENSIVE: 100,
};

// ₹/sqft → 0..100. Calibrated to Indian metros: ~₹3k/sqft (value) → ~20,
// ~₹8k (upper-mid) → ~65, ~₹15k+ (premium) → ~95. Log-shaped so the very top
// doesn't run away and the low end still differentiates.
function pricePerSqftScore(p: number): number {
  if (p <= 0) return 0;
  const v = (Math.log10(p) - 3.0) * 80; // 1000→0, 10000→80, ~18000→~100
  return Math.max(0, Math.min(100, Math.round(v)));
}

// Density + tier of expensive venues nearby. We reward BOTH the *share* of
// upmarket venues and that there are enough of them to be meaningful.
function priceLevelScore(pois: Poi[]): { score: number; n: number } | null {
  const withLevel = pois.filter(p => p.priceLevel && PRICE_LEVEL_SCORE[p.priceLevel] != null);
  if (withLevel.length < 3) return null; // too few to be a signal
  const avg =
    withLevel.reduce((s, p) => s + PRICE_LEVEL_SCORE[p.priceLevel as string], 0) /
    withLevel.length;
  return { score: Math.round(avg), n: withLevel.length };
}

// VIIRS mean luminance (0..255) → 0..100 affluence-ish activity. Mirrors the
// vitality curve in nightlights.ts but kept local so the two stay decoupled.
function nightlightScore(meanLum: number): number {
  if (meanLum <= 1) return 0;
  const v = (Math.log10(meanLum) - 0.45) * 70;
  return Math.max(0, Math.min(100, Math.round(v)));
}

function bandFor(index: number): AffluenceBand {
  if (index >= 78) return "Premium";
  if (index >= 60) return "Upper-mid";
  if (index >= 42) return "Mid";
  if (index >= 25) return "Value";
  return "Low";
}

// Base weights when all three signals are present. Property price is the most
// trustworthy affluence proxy, so it leads; nightlights is the weakest (it's
// activity, not income) so it trails. Missing signals drop out and the rest
// renormalise to sum to 1.
const BASE_WEIGHTS = { property: 0.5, priceLevel: 0.3, nightlights: 0.2 };

export function computeAffluence(opts: {
  realEstate: RealEstateSignals | null;
  competitors: Poi[];
  nightlights: NightlightResult | null;
}): AffluenceResult | null {
  const raw: AffluenceComponent[] = [];

  const ppsf = opts.realEstate?.medianPricePerSqft ?? null;
  if (ppsf && ppsf > 0) {
    raw.push({
      key: "property",
      label: "Property price",
      score: pricePerSqftScore(ppsf),
      weight: BASE_WEIGHTS.property,
      detail: `≈₹${Math.round(ppsf).toLocaleString("en-IN")}/sqft${opts.realEstate?.aiEstimated ? " · AI estimate" : ""}`,
    });
  }

  const pl = priceLevelScore(opts.competitors);
  if (pl) {
    raw.push({
      key: "priceLevel",
      label: "Venue price tier",
      score: pl.score,
      weight: BASE_WEIGHTS.priceLevel,
      detail: `${pl.n} priced venues nearby`,
    });
  }

  const lum = opts.nightlights?.meanLuminance ?? null;
  if (lum != null && lum > 1) {
    raw.push({
      key: "nightlights",
      label: "Night-time activity",
      score: nightlightScore(lum),
      weight: BASE_WEIGHTS.nightlights,
      detail: `satellite luminance ${lum}`,
    });
  }

  if (raw.length === 0) return null;

  // Renormalise weights over the signals we actually have.
  const wSum = raw.reduce((s, c) => s + c.weight, 0);
  const components = raw.map(c => ({ ...c, weight: c.weight / wSum }));
  const index = Math.round(components.reduce((s, c) => s + c.score * c.weight, 0));

  return {
    index,
    band: bandFor(index),
    components,
    note:
      "Composite affluence proxy from property price, venue price tier and " +
      "satellite night-lights — directional, not a household-income figure.",
  };
}
