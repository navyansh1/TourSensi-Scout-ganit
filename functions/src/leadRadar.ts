// Lead Radar — turns freshly-registered RERA projects near a branch into ranked,
// rupee-tagged loan opportunities ("leads").
//
// Pipeline:
//   1. Geocode the branch/anchor location.
//   2. Pull RERA projects for the state (TN live; MH/KA/TG/RJ from cache).
//   3. Keep projects whose locality falls within the catchment radius.
//   4. For each, get ₹/sqft (our MagicBricks scraper) and estimate the home-loan
//      pool with transparent, editable assumptions.
//   5. Rank by opportunity size and return.
//
// The ₹ figure is an order-of-magnitude model with its assumptions shown — same
// honest framing as the rest of GeoScout IQ (it is decision-support, not a quote).

import { geocodeIndia } from "./geocode";
import { getRealEstateSignals } from "./realestate";
import { getReraProjects, getReraAsOf, ALL_STATES, type ReraProject } from "./rera";

export interface Lead {
  regNo: string;
  state: string;
  projectName: string;
  promoter: string;
  units: number | null;
  unitsEstimated?: boolean;       // true when units inferred from project size, not RERA-stated
  floors?: string;
  locality: string;
  lat: number;
  lng: number;
  distanceKm: number | null;
  pricePerSqft: number | null;
  priceSource: "magicbricks" | "ai" | "none";
  avgUnitCr: number | null;       // estimated avg unit value (₹ crore)
  loanPoolLoCr: number | null;    // low end of home-loan opportunity (₹ crore)
  loanPoolHiCr: number | null;    // high end
  completion?: string;
  status?: string;
  assumptions: string;            // human-readable "how we got the ₹"
}

export interface LeadRadarResult {
  anchor: { query: string; lat: number; lng: number; area: string; city: string };
  state: string;
  stateName: string;
  dataAsOf: number | null;        // cache timestamp for dynamic states; null = live
  radiusKm: number;
  leads: Lead[];
  totalPipelineCr: number;
}

// Loan-economics assumptions (editable — surfaced so the buyer can challenge them).
const LTV = 0.75;                 // loan-to-value ratio
const PENETRATION_LO = 0.55;      // share of buyers taking a home loan (conservative)
const PENETRATION_HI = 0.75;      // optimistic
// Typical built-up area per dwelling unit (sqft) → unit value = area × ₹/sqft.
const AVG_UNIT_SQFT = 1100;

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Pull a short locality token out of a RERA address blob for geocoding + ₹ lookup.
function localityToken(p: ReraProject, city: string): string {
  const raw = (p.locality || p.address || "").replace(/\s+/g, " ").trim();
  // Prefer an explicit "at <place>" or a comma-separated locality near the city.
  const at = raw.match(/\bat\s+([^,.]{3,40})/i);
  if (at) return at[1].trim();
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  // Choose the part just before the city mention, else the longest meaningful part.
  const cityIdx = parts.findIndex((x) => x.toLowerCase().includes(city.toLowerCase()));
  if (cityIdx > 0) return parts[cityIdx - 1];
  return parts.sort((a, b) => b.length - a.length)[0] || raw.slice(0, 40);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// Run async tasks with a concurrency cap (keeps Lead Radar fast without bursting
// the geocode/Places quotas).
async function runWithLimit<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (i < tasks.length) {
      const idx = i++;
      results[idx] = await tasks[idx]();
    }
  });
  await Promise.all(workers);
  return results;
}

// Estimate dwelling units when RERA's list page doesn't state them (KA/MH/RJ).
// Heuristic: units ≈ floors × ~4 flats/floor. "Stilt + 5 Floors" → ~20 units.
// Falls back to a modest default so a ₹ figure can still be shown (flagged
// as estimated in the UI). Conservative on purpose.
function estimateUnits(p: ReraProject): number | null {
  const floors = p.floors || p.address || "";
  const m = floors.match(/(\d+)\s*Floors?/i);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n > 0 && n < 100) return Math.max(4, n * 4);
  }
  // No floor info — assume a small mid-rise so the lead still carries a ₹ band.
  return 12;
}

export async function getLeadRadar(opts: {
  query: string;        // branch / anchor location, e.g. "Anna Nagar East, Chennai"
  state: string;        // RERA state code, e.g. "TN"
  radiusKm?: number;
}): Promise<LeadRadarResult> {
  const radiusKm = opts.radiusKm ?? 5;
  const stateCode = opts.state.toUpperCase();
  const stateName = ALL_STATES[stateCode] ?? stateCode;

  const anchor = await geocodeIndia(opts.query);
  if (!anchor) throw new Error(`Could not geocode "${opts.query}"`);

  const [projects, dataAsOf] = await Promise.all([
    getReraProjects(stateCode),
    getReraAsOf(stateCode),
  ]);

  // Geocode candidate localities and keep those inside the radius. We cap how many
  // we geocode (cost control) by first keeping projects that even mention the city.
  const cityLc = anchor.city.toLowerCase();
  const candidates = projects
    .filter((p) => (p.address || p.locality || "").toLowerCase().includes(cityLc))
    .slice(0, 60);

  // Resolve each candidate (geocode + ₹/sqft + ₹ pool) CONCURRENTLY with a small
  // limit — the old serial await-in-loop made dense areas take 30-60s.
  const resolveOne = async (p: ReraProject): Promise<Lead | null> => {
    const token = localityToken(p, anchor.city);
    let lat = p.lat;
    let lng = p.lng;
    if (lat == null || lng == null) {
      // Geocode the PROJECT NAME first (gives a distinct location per project when
      // Google knows it); fall back to the locality token so we still get a point.
      const byName = p.projectName
        ? await geocodeIndia(`${p.projectName}, ${anchor.city}`).catch(() => null)
        : null;
      const g = byName || await geocodeIndia(`${token}, ${anchor.city}`).catch(() => null);
      if (!g) return null;
      lat = g.lat;
      lng = g.lng;
    }
    const distanceKm = haversineKm(anchor, { lat, lng });
    if (distanceKm > radiusKm) return null;

    // ₹/sqft via our MagicBricks-first signal (falls back to AI inside that module).
    const re = await getRealEstateSignals({ city: anchor.city, area: token }).catch(() => null);
    const psf = re?.medianPricePerSqft ?? null;
    const priceSource: Lead["priceSource"] = re?.medianPricePerSqft
      ? re.aiEstimated ? "ai" : "magicbricks"
      : "none";

    // Unit count: use the real RERA figure where we have it (TN), else estimate
    // from floors (units ≈ floors × ~4 flats/floor) so KA/MH/RJ leads still get a
    // ₹ figure. Estimated counts are flagged so the UI can show "~".
    const realUnits = p.units;
    const estUnits = realUnits ?? estimateUnits(p);
    const unitsEstimated = realUnits == null && estUnits != null;

    let avgUnitCr: number | null = null;
    let loCr: number | null = null;
    let hiCr: number | null = null;
    if (psf) {
      avgUnitCr = round1((psf * AVG_UNIT_SQFT) / 1e7); // ₹ → crore
      if (estUnits) {
        loCr = round1(estUnits * avgUnitCr * LTV * PENETRATION_LO);
        hiCr = round1(estUnits * avgUnitCr * LTV * PENETRATION_HI);
      }
    }

    const unitsLabel = realUnits != null ? `${realUnits}` : estUnits != null ? `~${estUnits}` : "?";
    return {
      regNo: p.regNo,
      state: stateCode,
      projectName: p.projectName || "(unnamed RERA project)",
      promoter: p.promoter,
      units: estUnits,
      unitsEstimated,
      floors: p.floors,
      locality: token,
      lat,
      lng,
      distanceKm: round1(distanceKm),
      pricePerSqft: psf,
      priceSource,
      avgUnitCr,
      loanPoolLoCr: loCr,
      loanPoolHiCr: hiCr,
      completion: p.completion,
      status: p.status,
      assumptions:
        psf && estUnits
          ? `${unitsLabel} units × ~₹${avgUnitCr} Cr/unit (${AVG_UNIT_SQFT} sqft × ₹${psf}/sqft) × ${Math.round(LTV * 100)}% LTV × ${Math.round(PENETRATION_LO * 100)}–${Math.round(PENETRATION_HI * 100)}% loan penetration${unitsEstimated ? " · unit count estimated from project size" : ""}`
          : "₹/sqft unavailable for this locality — pool not estimated",
    };
  };

  const settled = await runWithLimit(candidates.map((p) => () => resolveOne(p)), 6);
  const leads: Lead[] = settled.filter((l): l is Lead => l !== null);

  // Rank by ₹ opportunity first; leads without a unit count (no ₹ estimate) fall
  // back to nearest-first so they're still ordered usefully, not randomly.
  leads.sort((a, b) => {
    const d = (b.loanPoolHiCr ?? 0) - (a.loanPoolHiCr ?? 0);
    if (d !== 0) return d;
    return (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9);
  });
  const totalPipelineCr = round1(leads.reduce((s, l) => s + (l.loanPoolHiCr ?? 0), 0));

  return {
    anchor: { query: opts.query, lat: anchor.lat, lng: anchor.lng, area: anchor.area, city: anchor.city },
    state: stateCode,
    stateName,
    dataAsOf,
    radiusKm,
    leads,
    totalPipelineCr,
  };
}
