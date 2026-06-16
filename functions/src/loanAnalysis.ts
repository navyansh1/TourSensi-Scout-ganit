// Loan Assessor (collateral) — GEOGRAPHIC analysis only.
//
// IMPORTANT framing: this is explicitly ONE input to a lending decision, not a
// verdict. We do NOT touch title/encumbrance/KYC/credit — only what we can read
// from geography + the open web:
//   • where the collateral is (locality, urban/rural)
//   • water context for land (rivers/canals/lakes/ocean nearby; flood/drought)
//   • the commercial health around it — competitor Google ratings, live review
//     text, and how many nearby businesses have permanently shut down
//   • a rough property value band
// All of this is grounded with Google Search + live Google Places data.

import { VertexAI } from "@google-cloud/vertexai";
import { richPlacesNearby, type RichPlace } from "./places";
import { waterAt, floodNarrative } from "./flood";
import { getRainfall } from "./rainfall";

const PROJECT_ID = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "toursensi-ganit-71c77";
function vertex() { return new VertexAI({ project: PROJECT_ID, location: "us-central1" }); }

export type CollateralType = "commercial" | "residential" | "agricultural" | "land";

export interface LoanAnalysisInput {
  collateralType: CollateralType;
  lat: number;
  lng: number;
  address?: string;
}

export interface LoanAnalysis {
  locality: string;
  setting: string;                 // "urban" | "semi-urban" | "rural" + one line
  geographicSignal: "FAVOURABLE" | "MIXED" | "UNFAVOURABLE"; // geographic read only
  valueBand?: string;              // rough property value, e.g. "₹6,000–8,000/sqft"
  locationFactors: string[];       // short bullets — access, water, surroundings
  commercialHealth: string[];      // short bullets — ratings, reviews, closures
  waterAndRisk: string[];          // short bullets — rivers/ocean/flood/drought (esp. land/agri)
  rainfall?: {                     // historical rainfall (agricultural/land only)
    avgAnnualMm: number;
    avgRainyDays: number;
    band: "abundant" | "adequate" | "marginal" | "arid";
    note: string;
    years: { year: number; mm: number; rainyDays: number }[];
  };
  redFlags: string[];              // short bullets
  summary: string;                 // one-line geographic summary
  evidence: {
    nearby: { name: string; id?: string; lat?: number; lng?: number; rating?: number; reviews?: number; status?: string }[];
    closedShare: number;           // share of nearby businesses permanently closed
  };
  sources: { uri: string; title?: string }[];
}

function summarise(places: RichPlace[]): string {
  return places.slice(0, 8).map(p => {
    const bits = [`"${p.name}"`];
    if (typeof p.rating === "number") bits.push(`★${p.rating} (${p.userRatings ?? 0})`);
    if (p.businessStatus && p.businessStatus !== "OPERATIONAL") bits.push(p.businessStatus.replace(/_/g, " ").toLowerCase());
    const rev = (p.reviews ?? [])[0]?.text;
    return `• ${bits.join(" ")}${rev ? ` — “${rev.slice(0, 130)}”` : ""}`;
  }).join("\n");
}

export async function analyzeLoanCollateral(input: LoanAnalysisInput): Promise<LoanAnalysis> {
  // Pull nearby businesses (with review text + open/closed) to read commercial
  // health and the "how many shut down" signal. Useful for all types as a
  // proxy for area vitality.
  const nearby = await richPlacesNearby({
    query: input.collateralType === "agricultural" || input.collateralType === "land"
      ? "shops and businesses"
      : "businesses",
    centerLat: input.lat, centerLng: input.lng, radiusM: 1500, maxResults: 10,
  }).catch(() => [] as RichPlace[]);

  let withStatus = 0, closed = 0;
  for (const p of nearby) {
    if (p.businessStatus) { withStatus++; if (p.businessStatus === "CLOSED_PERMANENTLY") closed++; }
  }
  const closedShare = withStatus ? closed / withStatus : 0;
  const nearbyText = summarise(nearby) || "No notable businesses found nearby.";

  // Satellite-confirmed surface-water / flood exposure at the exact parcel
  // (JRC Global Surface Water, 30-yr occurrence). This is ground-truth — it
  // doesn't depend on anyone having mapped the river in OSM.
  const isLandLike = input.collateralType === "agricultural" || input.collateralType === "land";
  const [water, rainfall] = await Promise.all([
    waterAt(input.lat, input.lng, 14).catch(() => null),
    // Rainfall only matters for land/agri repayment capacity — skip for built property.
    isLandLike ? getRainfall(input.lat, input.lng).catch(() => null) : Promise.resolve(null),
  ]);
  const flood = water ? floodNarrative(water) : null;
  const floodFact = flood
    ? `SATELLITE FLOOD READING (JRC Global Surface Water, authoritative): ${flood.level} — ${flood.note}`
    : "";
  const rainFact = rainfall
    ? `HISTORICAL RAINFALL (ERA5, last 3 yrs, authoritative): ~${rainfall.avgAnnualMm} mm/yr over ~${rainfall.avgRainyDays} rainy days — ${rainfall.band}. ${rainfall.note} For agricultural collateral, consistent rainfall supports crop yield and the borrower's repayment capacity.`
    : "";

  const typeLabel: Record<CollateralType, string> = {
    commercial: "a commercial property (shop/office/restaurant)",
    residential: "a residential property (home/flat)",
    agricultural: "agricultural land / farmland",
    land: "a vacant plot of land",
  };
  const what = typeLabel[input.collateralType];

  // Agricultural/land lean heavily on water + risk; commercial/residential lean
  // on surroundings + value. We ask for all, but the prompt steers emphasis.
  const waterEmphasis = input.collateralType === "agricultural" || input.collateralType === "land"
    ? "This is land — water access is critical: search for the nearest river, canal, lake, reservoir or sea/coast, groundwater situation, irrigation, and any flood OR drought history. Judge whether the land can support crops/use."
    : "Note any relevant water bodies and flood risk for the property.";

  const model = vertex().getGenerativeModel({ model: "gemini-2.5-flash", tools: [{ googleSearch: {} } as any] });

  const prompt = `You are providing a GEOGRAPHIC collateral assessment (ONE input to a bank's lending decision — NOT a final verdict, and NOT a title/legal/credit check) for ${what} at ${input.address ? `"${input.address}" (` : ""}${input.lat.toFixed(5)}, ${input.lng.toFixed(5)}${input.address ? ")" : ""}, India.

Live Google Places data on nearby businesses (ratings, review snippets, open/closed):
${nearbyText}
About ${Math.round(closedShare * 100)}% of nearby businesses with a known status are permanently closed.
${floodFact}
${rainFact}

Use Google Search to identify the exact locality and whether it is urban/semi-urban/rural, the surroundings & connectivity, a rough property value band, and ${waterEmphasis}

Be PUNCHY: every bullet ONE short line (≤ 12 words), concrete, number where possible. Reply with ONLY JSON:
{
  "locality": "<real locality>",
  "setting": "<urban|semi-urban|rural — one short line>",
  "geographicSignal": "FAVOURABLE | MIXED | UNFAVOURABLE",
  "valueBand": "<rough value, e.g. '₹6,000–8,000/sqft' or '₹15–25 L/acre'>",
  "locationFactors": ["<access/connectivity bullet>", "..."],
  "commercialHealth": ["<bullet on local ratings/reviews/closures>", "..."],
  "waterAndRisk": ["<water/flood/drought bullet>", "..."],
  "redFlags": ["<geographic red flag, if any>"],
  "summary": "<one line: the geographic read>"
}`;

  let parsed: any = {};
  const sources: { uri: string; title?: string }[] = [];
  try {
    const resp = await model.generateContent({ contents: [{ role: "user", parts: [{ text: prompt }] }] });
    const candidate: any = resp.response?.candidates?.[0];
    const text = candidate?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "";
    for (const c of candidate?.groundingMetadata?.groundingChunks ?? []) {
      if (c.web?.uri) sources.push({ uri: c.web.uri, title: c.web.title });
    }
    const m = text.match(/\{[\s\S]*\}/);
    if (m) parsed = JSON.parse(m[0]);
  } catch (e) {
    console.error("analyzeLoanCollateral AI failed:", (e as Error).message);
  }

  const arr = (x: any, n: number) => Array.isArray(x) ? x.map((s: any) => String(s)).slice(0, n) : [];
  // Lead the water/risk section with the satellite-confirmed flood fact (it's
  // ground-truth, so it outranks the AI's web-sourced guesses), then the AI's.
  const waterAndRisk = arr(parsed.waterAndRisk, 4);
  if (rainfall) waterAndRisk.unshift(`🌧️ ${rainfall.note}`);
  if (flood) waterAndRisk.unshift(`🛰️ ${flood.level} flood signal — ${flood.note}`);
  return {
    locality: String(parsed.locality || "this locality"),
    setting: String(parsed.setting || ""),
    geographicSignal: ["FAVOURABLE", "MIXED", "UNFAVOURABLE"].includes(parsed.geographicSignal) ? parsed.geographicSignal : "MIXED",
    valueBand: parsed.valueBand ? String(parsed.valueBand).slice(0, 60) : undefined,
    locationFactors: arr(parsed.locationFactors, 5),
    commercialHealth: arr(parsed.commercialHealth, 4),
    waterAndRisk: waterAndRisk.slice(0, 6),
    rainfall: rainfall ? {
      avgAnnualMm: rainfall.avgAnnualMm, avgRainyDays: rainfall.avgRainyDays,
      band: rainfall.band, note: rainfall.note, years: rainfall.years,
    } : undefined,
    redFlags: arr(parsed.redFlags, 4),
    summary: String(parsed.summary || ""),
    evidence: {
      nearby: nearby.slice(0, 6).map(p => ({
        name: p.name, id: p.id, lat: p.lat, lng: p.lng,
        rating: p.rating, reviews: p.userRatings, status: p.businessStatus,
      })),
      closedShare,
    },
    sources: sources.slice(0, 4),
  };
}
