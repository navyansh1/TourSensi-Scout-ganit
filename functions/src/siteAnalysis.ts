// Deep, on-demand AI analysis for ONE clicked location (site or expansion gap)
// in the Expansion Planner. This is the "use more AI, be creative" path — it is
// NOT run in the fast batch; only when the user clicks a pin.
//
// What it fuses:
//   1. RICH Google Places data around the point — actual review text snippets,
//      editorial summaries, open/closed, price level for nearby competitors AND
//      footfall anchors (schools/malls/metro/offices…).
//   2. Multiple grounded Google searches via Gemini — locality identity &
//      growth, upcoming infrastructure, demographics/income, and competitor
//      sentiment read from the real reviews.
// → A structured verdict the frontend renders in the right-side panel.

import { VertexAI } from "@google-cloud/vertexai";
import { richPlacesNearby, type RichPlace } from "./places";
import { fetchContextPois, hexContext } from "./context";
import { VERTICAL_PLACES_TYPE, type Vertical } from "./companies";

const PROJECT_ID = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "toursensi-ganit-71c77";

function vertex() {
  return new VertexAI({ project: PROJECT_ID, location: "us-central1" });
}

export interface SiteAnalysisInput {
  vertical: Vertical;
  lat: number;
  lng: number;
  kind: "site" | "gap";          // existing site vs expansion candidate
  name?: string;                  // site name when kind === "site"
  footfallIndex?: number;
  score?: number;
  competitorCount?: number;
  nearestOwnKm?: number;
  populationDensity?: number | null;
}

export interface SiteAnalysis {
  locality: string;               // real neighbourhood name
  verdict: "OPEN" | "CONSIDER" | "AVOID";
  headline: string;
  demandDrivers: string[];        // short bullets
  competitiveBullets: string[];   // what the reviews/competitors say — bulleted
  demographicBullets: string[];   // who lives/works here — bulleted
  risks: string[];
  bottomLine: string;
  propertyCost: {                 // grounded property/rent estimate
    ratePerSqft?: string;         // e.g. "₹18,000–22,000/sqft"
    monthlyRent?: string;         // e.g. "₹1.2–1.8 lakh/month for ~800 sqft"
    buyPrice?: string;            // e.g. "₹1.4–1.8 cr for ~800 sqft"
    note?: string;
  };
  evidence: {                     // the raw Places metadata we surfaced
    competitors: { name: string; id?: string; lat?: number; lng?: number; rating?: number; reviews?: number; status?: string; sample?: string }[];
    anchors: { label: string; name: string; id?: string; lat?: number; lng?: number; meters: number }[];
  };
  sources: { uri: string; title?: string }[];
}

// Compact the rich Places data into a text block the model can reason over.
function summarisePlaces(places: RichPlace[], maxReviews = 2): string {
  return places.slice(0, 8).map(p => {
    const bits = [`"${p.name}"`];
    if (typeof p.rating === "number") bits.push(`★${p.rating} (${p.userRatings ?? 0} reviews)`);
    if (p.businessStatus && p.businessStatus !== "OPERATIONAL") bits.push(p.businessStatus.replace(/_/g, " ").toLowerCase());
    if (p.priceLevel) bits.push(p.priceLevel.replace("PRICE_LEVEL_", "").toLowerCase());
    if (p.editorialSummary) bits.push(`— ${p.editorialSummary}`);
    const revs = (p.reviews ?? []).slice(0, maxReviews).map(r => `“${r.text.slice(0, 160)}”`);
    return `• ${bits.join(" ")}${revs.length ? ` Reviews: ${revs.join(" ")}` : ""}`;
  }).join("\n");
}

export async function analyzeSite(input: SiteAnalysisInput): Promise<SiteAnalysis> {
  const placeType = VERTICAL_PLACES_TYPE[input.vertical];

  // 1) Pull rich nearby data in parallel: same-category competitors (with review
  //    text) + vertical-specific footfall anchors.
  const [competitors, contextPois] = await Promise.all([
    richPlacesNearby({ query: placeType, centerLat: input.lat, centerLng: input.lng, radiusM: 1500, maxResults: 8 }).catch(() => [] as RichPlace[]),
    fetchContextPois({ vertical: input.vertical, centerLat: input.lat, centerLng: input.lng, radiusM: 2500 }).catch(() => []),
  ]);

  const ctx = hexContext(input.lat, input.lng, input.vertical, contextPois);
  // Look up each amenity's coordinates from the context POIs (by id) so the
  // frontend can build a Google Maps link.
  const poiById = new Map(contextPois.map(p => [p.id, p] as const));
  const anchors = ctx.nearest.filter(n => n.sign > 0 && n.meters <= 2500).slice(0, 6)
    .map(n => {
      const poi = n.id ? poiById.get(n.id) : undefined;
      return { label: n.label, name: n.name, id: n.id, lat: poi?.lat, lng: poi?.lng, meters: n.meters };
    });

  const compText = summarisePlaces(competitors) || "No directly-comparable businesses found nearby.";
  const anchorText = anchors.length
    ? anchors.map(a => `${a.label}: "${a.name}" (${a.meters >= 1000 ? (a.meters / 1000).toFixed(1) + "km" : a.meters + "m"})`).join("; ")
    : "no major anchors detected";

  const kindLabel: Record<string, string> = {
    BFSI_ATM: "an ATM", BFSI_BRANCH: "a bank branch",
    FMCG_RETAIL: "a grocery/retail store", FMCG_WAREHOUSE: "a dark store / warehouse",
  };
  const what = kindLabel[input.vertical] ?? "an outlet";
  const intent = input.kind === "site"
    ? `The client ALREADY operates ${what} here ("${input.name ?? "this site"}"). Assess how healthy this location is and whether it's worth keeping/investing in.`
    : `The client is considering opening a NEW ${what} here. Assess whether to expand to this exact spot.`;

  // 2) One grounded Gemini call that runs its own Google searches and reasons
  //    over the real review/metadata block we hand it.
  const model = vertex().getGenerativeModel({
    model: "gemini-2.5-flash",
    tools: [{ googleSearch: {} } as any],
  });

  const prompt = `You are a senior location strategist for ${what} in India. ${intent}

Coordinates: ${input.lat.toFixed(5)}, ${input.lng.toFixed(5)}.
Our model's signals: footfall index ${input.footfallIndex ?? "?"}/100, score ${input.score ?? "?"}/100, ${input.competitorCount ?? "?"} competitors within ~1.2km, ${input.nearestOwnKm != null ? input.nearestOwnKm + "km from the client's nearest own site, " : ""}population density ${input.populationDensity != null ? input.populationDensity.toLocaleString("en-IN") + "/km²" : "unknown"}.

REAL nearby competitor data (Google Places, incl. actual review snippets):
${compText}

Nearby footfall anchors: ${anchorText}

Use Google Search to: (a) identify the exact neighbourhood/locality, (b) find its growth trajectory & recent development, (c) any upcoming infrastructure (metro, IT parks, highways, malls), (d) the demographic/income profile, and (e) the local COMMERCIAL real-estate cost — typical ₹/sqft rate, monthly rent and buy price for a ~800 sqft unit. Read the competitor reviews above to judge whether local commerce of this type is thriving or struggling, and why.

IMPORTANT: be punchy and scannable. Every bullet must be ONE short line (max ~12 words), concrete, with a number where possible. No long sentences, no fluff.

Reply with ONLY JSON, no prose:
{
  "locality": "<real neighbourhood, e.g. 'HSR Layout, Bangalore'>",
  "verdict": "OPEN | CONSIDER | AVOID",
  "headline": "<one punchy line, max 14 words>",
  "demandDrivers": ["<short bullet w/ a number>", "..."],
  "competitiveBullets": ["<short bullet on a competitor gap/strength from the reviews>", "..."],
  "demographicBullets": ["<short bullet on who's here / income>", "..."],
  "risks": ["<short risk bullet>", "..."],
  "propertyCost": {
    "ratePerSqft": "<e.g. '₹18,000–22,000/sqft'>",
    "monthlyRent": "<e.g. '₹1.2–1.8 L/mo for ~800 sqft'>",
    "buyPrice": "<e.g. '₹1.4–1.8 cr for ~800 sqft'>",
    "note": "<optional one-line caveat>"
  },
  "bottomLine": "<decisive 1 line>"
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
    console.error("analyzeSite AI failed:", (e as Error).message);
  }

  const arr = (x: any, n: number) => Array.isArray(x) ? x.map((s: any) => String(s)).slice(0, n) : [];
  return {
    locality: String(parsed.locality || "this locality"),
    verdict: ["OPEN", "CONSIDER", "AVOID"].includes(parsed.verdict) ? parsed.verdict : "CONSIDER",
    headline: String(parsed.headline || ""),
    demandDrivers: arr(parsed.demandDrivers, 5),
    competitiveBullets: arr(parsed.competitiveBullets, 4),
    demographicBullets: arr(parsed.demographicBullets, 4),
    risks: arr(parsed.risks, 4),
    bottomLine: String(parsed.bottomLine || ""),
    propertyCost: parsed.propertyCost && typeof parsed.propertyCost === "object" ? {
      ratePerSqft: parsed.propertyCost.ratePerSqft ? String(parsed.propertyCost.ratePerSqft).slice(0, 50) : undefined,
      monthlyRent: parsed.propertyCost.monthlyRent ? String(parsed.propertyCost.monthlyRent).slice(0, 60) : undefined,
      buyPrice: parsed.propertyCost.buyPrice ? String(parsed.propertyCost.buyPrice).slice(0, 60) : undefined,
      note: parsed.propertyCost.note ? String(parsed.propertyCost.note).slice(0, 140) : undefined,
    } : {},
    evidence: {
      competitors: competitors.slice(0, 6).map(c => ({
        name: c.name, id: c.id, lat: c.lat, lng: c.lng,
        rating: c.rating, reviews: c.userRatings, status: c.businessStatus,
        sample: c.reviews?.[0]?.text?.slice(0, 140),
      })),
      anchors,
    },
    sources: sources.slice(0, 4),
  };
}
