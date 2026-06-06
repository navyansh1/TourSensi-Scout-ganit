// On-demand, per-zone AI insight.
//
// When the user clicks a hex on the map, the frontend posts that hex's facts
// here. We run ONE grounded Gemini call that returns a decisive, fact-backed
// verdict: should you open here or not, WHY, with the concrete facts laid out.
//
// Cheap because it only fires for zones the user actually opens, and we cache
// each result in Firestore keyed by the hex id + vertical so re-clicks are free.

import { VertexAI } from "@google-cloud/vertexai";
import * as admin from "firebase-admin";

const PROJECT_ID = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "toursensi-ganit-71c77";
const LOCATION = "us-central1";

const VERTICAL_LABEL: Record<string, string> = {
  BFSI_ATM: "a new ATM",
  BFSI_BRANCH: "a new bank branch",
  FMCG_RETAIL: "a new retail / grocery store",
  FMCG_WAREHOUSE: "a new warehouse / dark store",
};

export interface ZoneFacts {
  vertical: string;
  area: string;
  city: string;
  lat: number;
  lng: number;
  final: number;
  demand: number;
  saturation: number;     // higher = less competition / more free space
  access: number;
  growth: number;
  competitorCount: number;
  ownBrandCount: number;
  pricePerSqft?: number | null;
  distanceKm?: number;
  nearest?: { label: string; meters: number; sign: number }[];
}

export interface ZoneInsight {
  verdict: "OPEN" | "CONSIDER" | "AVOID";
  headline: string;                       // one punchy sentence
  facts: string[];                        // the concrete facts that drove the call
  reasoning: string[];                    // 3-4 logical bullets (why open / why not)
  bottomLine: string;
  sources: { uri: string; title?: string }[];
}

function vertex() {
  return new VertexAI({ project: PROJECT_ID, location: LOCATION });
}

function deriveVerdict(f: ZoneFacts): "OPEN" | "CONSIDER" | "AVOID" {
  if (f.final >= 64) return "OPEN";
  if (f.final >= 45) return "CONSIDER";
  return "AVOID";
}

// Build the deterministic fact list from the numbers we already have, so the
// UI always shows facts even if the AI call fails.
function baseFacts(f: ZoneFacts): string[] {
  const facts: string[] = [];
  facts.push(`Composite suitability score: ${f.final}/100 (demand ${f.demand}, free-space ${f.saturation}, access ${f.access}, growth ${f.growth}).`);
  facts.push(`${f.competitorCount} competitor site(s) and ${f.ownBrandCount} of your own site(s) inside this ~460 m hex.`);
  if (f.pricePerSqft) facts.push(`Local real-estate ~₹${Math.round(f.pricePerSqft).toLocaleString("en-IN")}/sqft (affluence proxy).`);
  if (typeof f.distanceKm === "number") facts.push(`~${f.distanceKm} km from the searched centre.`);
  for (const n of (f.nearest ?? []).slice(0, 4)) {
    const dist = n.meters >= 1000 ? `${(n.meters / 1000).toFixed(1)} km` : `${n.meters} m`;
    facts.push(`${dist} from the nearest ${n.label.split(" / ")[0]}.`);
  }
  return facts;
}

function extractJson(text: string): any {
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let json = m[0].replace(/[""]/g, '"').replace(/['']/g, "'").replace(/,(\s*[}\]])/g, "$1");
  try { return JSON.parse(json); } catch { return null; }
}

export async function getZoneInsight(f: ZoneFacts): Promise<ZoneInsight> {
  const verdict = deriveVerdict(f);
  const facts = baseFacts(f);
  const what = VERTICAL_LABEL[f.vertical] ?? "a new site";

  const cacheKey = `${f.vertical}__${f.lat.toFixed(4)}_${f.lng.toFixed(4)}`;
  try {
    const cached = await admin.firestore().collection("zone_insights").doc(cacheKey).get();
    if (cached.exists) return cached.data() as ZoneInsight;
  } catch { /* cache read best-effort */ }

  const proximityLine = (f.nearest ?? [])
    .slice(0, 5)
    .map(n => `${n.label} at ${n.meters} m`)
    .join("; ") || "no notable amenities mapped nearby";

  const prompt = `You are a site-selection analyst. Decide whether the company should open ${what} at this exact spot, and explain WHY with logic and current facts. Use Google Search to ground recent, location-specific facts (new infrastructure, demographics, commercial activity) for ${f.area}, ${f.city}, India.

This specific zone (a ~460 m hex at ${f.lat.toFixed(4)}, ${f.lng.toFixed(4)} in ${f.area}, ${f.city}):
- Composite suitability: ${f.final}/100 (our model leans toward "${verdict}")
- Demand sub-score: ${f.demand}/100
- Free-space (low competition) sub-score: ${f.saturation}/100
- Accessibility sub-score: ${f.access}/100
- Future-growth sub-score: ${f.growth}/100
- Competitors in this hex: ${f.competitorCount}; own sites: ${f.ownBrandCount}
- Real estate: ${f.pricePerSqft ? `₹${Math.round(f.pricePerSqft)}/sqft` : "unknown"}
- Nearby physical context: ${proximityLine}

Be DECISIVE and HONEST. If it's a weak zone, say clearly why NOT to open here. If strong, justify it. Tie every point to a concrete fact or number — no generic filler.

Respond ONLY with strict JSON:
{
  "verdict": "OPEN" | "CONSIDER" | "AVOID",
  "headline": "<one punchy sentence verdict>",
  "facts": ["<concrete current fact 1 (with number/name/year)>", "... 2 to 4 grounded facts you found>"],
  "reasoning": ["<logical reason tied to a fact>", "... 3 to 4 bullets, mixing for/against honestly>"],
  "bottomLine": "<2 sentences: decisive action for THIS zone>"
}`;

  const model = vertex().getGenerativeModel({
    model: "gemini-2.5-flash",
    tools: [{ googleSearch: {} } as any],
  });

  let lastErr: any;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await model.generateContent({ contents: [{ role: "user", parts: [{ text: prompt }] }] });
      const candidate: any = resp.response?.candidates?.[0];
      const text = candidate?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "";
      const meta = candidate?.groundingMetadata ?? {};
      const sources: { uri: string; title?: string }[] = [];
      for (const c of meta.groundingChunks ?? []) if (c.web?.uri) sources.push({ uri: c.web.uri, title: c.web.title });

      const parsed = extractJson(text);
      const insight: ZoneInsight = {
        verdict: ["OPEN", "CONSIDER", "AVOID"].includes(parsed?.verdict) ? parsed.verdict : verdict,
        headline: String(parsed?.headline || defaultHeadline(verdict, f)),
        // Merge AI-found facts on top of our deterministic ones (AI first, dedup-ish).
        facts: [...(Array.isArray(parsed?.facts) ? parsed.facts.map(String) : []), ...facts].slice(0, 7),
        reasoning: Array.isArray(parsed?.reasoning) ? parsed.reasoning.map(String).slice(0, 5) : defaultReasoning(verdict, f),
        bottomLine: String(parsed?.bottomLine || ""),
        sources: sources.slice(0, 5),
      };

      admin.firestore().collection("zone_insights").doc(cacheKey).set(insight).catch(() => {});
      return insight;
    } catch (e) {
      lastErr = e;
      const msg = (e as Error).message;
      if (msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED")) {
        await new Promise(r => setTimeout(r, 1200 * Math.pow(2, attempt)));
        continue;
      }
      break;
    }
  }

  // Graceful fallback: deterministic insight, no AI.
  console.error("zone insight AI failed:", (lastErr as Error)?.message);
  return {
    verdict,
    headline: defaultHeadline(verdict, f),
    facts,
    reasoning: defaultReasoning(verdict, f),
    bottomLine: verdict === "AVOID"
      ? "Weak fundamentals here — look at higher-scoring zones in this area before committing."
      : verdict === "OPEN"
        ? "Strong fundamentals — shortlist this zone for a site visit."
        : "Mixed signals — worth a closer look but not a clear win.",
    sources: [],
  };
}

function defaultHeadline(v: string, f: ZoneFacts): string {
  if (v === "AVOID") return `Weak spot for a new site (${f.final}/100).`;
  if (v === "OPEN") return `Strong candidate location (${f.final}/100).`;
  return `Moderate potential — proceed with caution (${f.final}/100).`;
}

function defaultReasoning(v: string, f: ZoneFacts): string[] {
  const out: string[] = [];
  if (f.demand < 35) out.push("Low demand: little population/commercial activity detected nearby to support footfall.");
  else if (f.demand >= 60) out.push("Healthy demand: meaningful population and commercial activity around this hex.");
  if (f.competitorCount >= 3) out.push(`Crowded: ${f.competitorCount} competitors already sit inside this small hex.`);
  else if (f.competitorCount === 0) out.push("White space: no direct competitors mapped in this hex.");
  if (f.access < 35) out.push("Poor accessibility: few transit/road anchors nearby.");
  else if (f.access >= 60) out.push("Well-connected: good transit/road access nearby.");
  if (f.growth >= 60) out.push("Positive growth trajectory flagged by the area's forward-looking signals.");
  return out.length ? out : ["Scores are middling across the board — no single strong driver either way."];
}
