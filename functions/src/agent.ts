// Vertex AI grounding agent. Now runs:
//  - 8 grounded Google searches in parallel (was 6) — added news + competitor strategy
//  - 4 quadrant-level micro-runs to give each map sub-area a distinct growth score
//  - One MBA-grade synthesis producing structured drivers / risks / bottom line

import { VertexAI } from "@google-cloud/vertexai";

const PROJECT_ID = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "toursensi-ganit-71c77";
const LOCATION = "us-central1";

// Main grounded queries for the overall area summary. We keep all the HIGH-signal
// drivers (transit, real-estate launches, SEZ/industrial, road infra, govt
// incentives, recent news). We dropped only the two queries that are already
// covered by HARD data we collect anyway — "demographic/population trends"
// (we have WorldPop population) and "competitive landscape" (we have Google
// Places competitor counts). So 8 → 6 with zero loss of unique insight, and the
// higher concurrency below keeps it fast.
const SEARCH_TEMPLATES = [
  "upcoming metro rail or rapid transit projects near {area}, {city}, India",
  "new residential or commercial real estate project launches near {area}, {city}",
  "Special Economic Zone, IT park, or industrial park announcements in {area}, {city}",
  "highway, flyover, or road infrastructure projects in {area}, {city}",
  "government incentives, subsidies, or policy changes affecting business in {area}, {city}",
  "recent news in {area}, {city} in the last 30 days",
];

export interface AgentTrailItem {
  query: string;
  summary: string;
  sources: { uri: string; title?: string }[];
}

export interface ExecutiveDriver { headline: string; detail: string; }
export interface ExecutiveSummary {
  rating: number;            // 1..5 stars
  recommendation: "GO" | "CAUTION" | "AVOID";
  drivers: ExecutiveDriver[];
  risks: ExecutiveDriver[];
  bottomLine: string;
  marketState?: string;      // honest one-liner on saturation/competition in the searched area
  alternatives?: string[];   // suggested other localities when this area is weak/saturated
}

export interface AgentResult {
  area: string;
  city: string;
  growthScore: number;       // overall area growth score
  reasoning: string;         // 2-3 sentence summary (for backwards compat)
  executive: ExecutiveSummary;
  trail: AgentTrailItem[];
  quadrantScores: { quadrant: "NE" | "NW" | "SE" | "SW"; growthScore: number; headline: string }[];
}

function vertex() {
  return new VertexAI({ project: PROJECT_ID, location: LOCATION });
}

async function groundedQuery(query: string): Promise<AgentTrailItem> {
  const model = vertex().getGenerativeModel({
    model: "gemini-2.5-flash",
    tools: [{ googleSearch: {} } as any],
  });

  let lastErr: any;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: query }] }],
      });
      const candidate: any = resp.response?.candidates?.[0];
      const text = candidate?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "";
      const meta = candidate?.groundingMetadata ?? {};
      const sources: { uri: string; title?: string }[] = [];
      for (const c of meta.groundingChunks ?? []) {
        if (c.web?.uri) sources.push({ uri: c.web.uri, title: c.web.title });
      }
      return { query, summary: text.trim().slice(0, 900), sources };
    } catch (e) {
      lastErr = e;
      const msg = (e as Error).message;
      if (msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED")) {
        await new Promise(r => setTimeout(r, 1500 * Math.pow(2, attempt)));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

// AI fallback for property pricing when the 99acres scrape returns nothing.
// Grounded Google search → a rough ₹/sqft + typical configuration for the area.
// Marked clearly as an AI estimate so the UI can label it honestly.
export interface AiPropertyEstimate {
  medianPricePerSqft: number | null;
  avgBHK: number | null;
  note: string;                 // short human sentence, e.g. "Approx ₹7,500/sqft (AI estimate)"
  sources: { uri: string; title?: string }[];
}

export async function aiPropertyEstimate(area: string, city: string): Promise<AiPropertyEstimate | null> {
  const model = vertex().getGenerativeModel({
    model: "gemini-2.5-flash",
    tools: [{ googleSearch: {} } as any],
  });
  // Ask for low/high AND a single best-estimate midpoint. We want a TIGHT answer
  // for a specific locality, not a city-wide "₹5,000–15,000" band. We tell the
  // model to narrow to the named locality and, if it can only find a wide range,
  // to give the most-likely midpoint for THAT locality (not the whole city).
  const prompt = `Using Google Search, find the typical residential price per sqft in the SPECIFIC locality "${area}", ${city}, India (not the whole city — narrow to this neighbourhood).
Prefer a tight figure. If sources only give a wide range, return the most likely midpoint for THIS locality.
Reply with ONLY JSON, no prose:
{"medianPricePerSqft": <integer ₹/sqft best single estimate, or null>, "low": <integer ₹/sqft, or null>, "high": <integer ₹/sqft, or null>, "avgBHK": <decimal e.g. 2.5, or null>, "note": "<one short sentence on this locality's market>"}`;

  const callOnce = async (text: string) => {
    const resp = await model.generateContent({ contents: [{ role: "user", parts: [{ text }] }] });
    const candidate: any = resp.response?.candidates?.[0];
    const out = candidate?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "";
    const sources: { uri: string; title?: string }[] = [];
    for (const c of candidate?.groundingMetadata?.groundingChunks ?? []) {
      if (c.web?.uri) sources.push({ uri: c.web.uri, title: c.web.title });
    }
    const m = out.match(/\{[\s\S]*\}/);
    return { parsed: m ? JSON.parse(m[0]) : null, sources };
  };

  // A range is "too wide" if high/low differ by more than ~1.6x — then we retry
  // once with an even more specific prompt to narrow it.
  const tooWide = (p: any) =>
    typeof p?.low === "number" && typeof p?.high === "number" && p.low > 0 && p.high / p.low > 1.6;

  try {
    let { parsed, sources } = await callOnce(prompt);
    if (parsed && tooWide(parsed)) {
      const retry = `The range for "${area}", ${city} looks too wide (₹${parsed.low}–${parsed.high}/sqft). Using Google Search, narrow to the apartment ₹/sqft for THIS exact locality only and give the single most representative value.
Reply with ONLY JSON: {"medianPricePerSqft": <integer>, "low": <integer>, "high": <integer>, "avgBHK": <decimal or null>, "note": "<one sentence>"}`;
      const second = await callOnce(retry);
      if (second.parsed) { parsed = second.parsed; sources = second.sources.length ? second.sources : sources; }
    }
    if (!parsed) return null;

    // Best estimate: explicit midpoint, else mean of low/high, else null.
    let price: number | null =
      typeof parsed.medianPricePerSqft === "number" && parsed.medianPricePerSqft > 0
        ? Math.round(parsed.medianPricePerSqft)
        : typeof parsed.low === "number" && typeof parsed.high === "number"
          ? Math.round((parsed.low + parsed.high) / 2)
          : null;
    if (price == null) return null;

    const stillWide = tooWide(parsed);
    return {
      medianPricePerSqft: price,
      avgBHK: typeof parsed.avgBHK === "number" ? parsed.avgBHK : null,
      // Flag low-confidence when the band stayed wide, so the UI can show "approx".
      note: (stillWide ? "(approx) " : "") + String(parsed.note || "").slice(0, 200),
      sources: sources.slice(0, 3),
    };
  } catch {
    return null;
  }
}

// Last-resort slug resolver: when every deterministic MagicBricks URL variant
// 404s (~5% of locations — odd spellings like "HITEC City"), ask Gemini for the
// canonical URL slug. One tiny call, no grounding, cheap; the caller caches the
// result so an area never needs this twice. Returns just the slug body
// (e.g. "hitech-city-hyderabad") or null.
export async function aiResolveSlug(area: string, city: string): Promise<string | null> {
  try {
    const model = vertex().getGenerativeModel({ model: "gemini-2.5-flash" });
    const prompt = `MagicBricks.com property URLs look like "property-for-sale-in-<SLUG>-pppfs", where <SLUG> is "<locality>-<city>" in lowercase hyphenated form using the spelling MagicBricks uses (often older city names, e.g. "bangalore" not "bengaluru", "gurgaon" not "gurugram").
Give the most likely <SLUG> for locality "${area}" in city "${city}", India.
Reply with ONLY the slug, nothing else. Example: hitech-city-hyderabad`;
    const resp = await model.generateContent({ contents: [{ role: "user", parts: [{ text: prompt }] }] });
    const out: string =
      resp.response?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "";
    const slug = out.trim().toLowerCase().replace(/[^a-z0-9-]/g, "").replace(/^-+|-+$/g, "");
    // Sanity: must look like "<word>-...-<word>", not empty or a sentence.
    return slug.length >= 4 && slug.length <= 80 && slug.includes("-") ? slug : null;
  } catch {
    return null;
  }
}

// Best-effort grounded INCOME context for an area. Real household-income data
// (GeoIQ, telco) costs lakhs/yr and is a black box; instead we ASK Google Search
// per call for whatever income evidence exists. In practice this returns
// DISTRICT/CITY-level figures (Statista, govt, news) plus a qualitative locality
// affluence read — NOT precise neighbourhood income. We surface it as a clearly
// labelled "AI estimate · district-level" supplement to the deterministic
// Affluence Index, never as a hard number. Returns null when nothing usable is
// grounded (the common case for tier-3 areas) so we fail open to the free index.
export interface AiIncomeContext {
  // Coarse band the AI is willing to commit to, with its evidence.
  band: "Premium" | "Upper-mid" | "Mid" | "Value" | "Low" | null;
  // Optional district/city per-capita or household income figure it found,
  // already as a human string so we never imply false precision.
  incomeNote: string;        // e.g. "Bengaluru Urban per-capita ≈ ₹3.2L (2016, district-level)"
  affluenceSummary: string;  // one-line qualitative read of the locality
  scope: "locality" | "city" | "district" | "unknown"; // honesty about granularity
  sources: { uri: string; title?: string }[];
}

export async function aiIncomeContext(area: string, city: string): Promise<AiIncomeContext | null> {
  const model = vertex().getGenerativeModel({
    model: "gemini-2.5-flash",
    tools: [{ googleSearch: {} } as any],
  });
  const prompt = `Using Google Search, find evidence of household affluence / income for ${area}, ${city}, India.
Look for: per-capita or average household income (district or city is fine if locality isn't available), share of high-income households, and qualitative signals (premium housing, luxury retail, IT/corporate presence).
Be honest about granularity — most localities only have district/city figures. Do NOT invent a neighbourhood income number.

Reply with ONLY JSON, no prose:
{
  "band": "Premium|Upper-mid|Mid|Value|Low|null",
  "incomeNote": "<short factual income figure WITH its scope, e.g. 'Bengaluru Urban per-capita ≈ ₹3.2L (district-level)', or '' if none found>",
  "affluenceSummary": "<one short sentence reading the locality's affluence from evidence>",
  "scope": "locality|city|district|unknown"
}`;

  try {
    const resp = await model.generateContent({ contents: [{ role: "user", parts: [{ text: prompt }] }] });
    const candidate: any = resp.response?.candidates?.[0];
    const text = candidate?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "";
    const meta = candidate?.groundingMetadata ?? {};
    const sources: { uri: string; title?: string }[] = [];
    for (const c of meta.groundingChunks ?? []) {
      if (c.web?.uri) sources.push({ uri: c.web.uri, title: c.web.title });
    }
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]);
    const bands = ["Premium", "Upper-mid", "Mid", "Value", "Low"];
    const band = bands.includes(parsed.band) ? parsed.band : null;
    const incomeNote = String(parsed.incomeNote || "").slice(0, 200);
    const affluenceSummary = String(parsed.affluenceSummary || "").slice(0, 240);
    // Nothing usable — fail open to the deterministic index.
    if (!band && !incomeNote && !affluenceSummary) return null;
    const scopes = ["locality", "city", "district", "unknown"];
    return {
      band,
      incomeNote,
      affluenceSummary,
      scope: scopes.includes(parsed.scope) ? parsed.scope : "unknown",
      sources: sources.slice(0, 3),
    };
  } catch {
    return null;
  }
}

// On-demand grounded revenue/footfall estimate for ONE site (used by the
// Expansion Planner when the user clicks a specific existing site or gap). Kept
// out of the batch path on purpose — one Gemini call per click, not per site.
export interface AiSiteRevenue {
  monthlyRevenueRange: string;   // e.g. "₹8–14 lakh / month"
  footfallNote: string;          // short footfall sentence
  reasoning: string;             // WHY this figure — the hypothesis behind it
  assumptions: string[];         // the concrete assumptions the number rests on
  confidence: "low" | "medium" | "high";
  sources: { uri: string; title?: string }[];
  monthlyRevenueMidINR?: number; // parsed midpoint of the range, in ₹ (for payback math)
}

// Parse a ₹ range string ("₹8–14 lakh / month", "₹1.2–2 crore", "Rs 50,000")
// into a numeric midpoint in rupees. Returns null if we can't read it. Used to
// derive payback — kept tolerant because the AI free-texts the range.
export function parseRupeeRange(s: string): number | null {
  if (!s) return null;
  const lower = s.toLowerCase();
  const mult = lower.includes("crore") || /\bcr\b/.test(lower) ? 1e7
    : lower.includes("lakh") || lower.includes("lac") ? 1e5
    : 1;
  // Strip thousands separators so "50,000" reads as 50000, not 50. Then grab up
  // to two leading numbers (the low and high of the range).
  const cleaned = s.replace(/,/g, "");
  const nums = (cleaned.match(/\d+(?:\.\d+)?/g) || []).map(Number).filter(n => n > 0);
  if (!nums.length) return null;
  const lo = nums[0];
  const hi = nums.length > 1 ? nums[1] : nums[0];
  const mid = ((lo + hi) / 2) * mult;
  return mid > 0 ? Math.round(mid) : null;
}

export async function aiSiteRevenue(opts: {
  vertical: string;
  lat: number;
  lng: number;
  area?: string;
  competitorCount: number;
  footfallIndex: number;
}): Promise<AiSiteRevenue | null> {
  const model = vertex().getGenerativeModel({
    model: "gemini-2.5-flash",
    tools: [{ googleSearch: {} } as any],
  });
  const kind: Record<string, string> = {
    BFSI_ATM: "a bank ATM", BFSI_BRANCH: "a bank branch",
    FMCG_RETAIL: "a grocery/retail store", FMCG_WAREHOUSE: "a dark store / warehouse",
  };
  const what = kind[opts.vertical] ?? "this type of outlet";
  const place = opts.area ? `${opts.area} (around ${opts.lat.toFixed(4)}, ${opts.lng.toFixed(4)})` : `${opts.lat.toFixed(4)}, ${opts.lng.toFixed(4)}`;
  const prompt = `Using Google Search, estimate a realistic MONTHLY revenue range for ${what} located at ${place}, India.
Context: about ${opts.competitorCount} similar businesses are nearby and the local footfall index is ${opts.footfallIndex}/100.

First identify the real locality. Then build the estimate bottom-up from explicit assumptions (e.g. for an ATM: daily transactions × interchange fee; for a store: daily customers × average basket size × days). State those assumptions and the hypothesis behind the figure so a business owner understands HOW you arrived at it.

Reply with ONLY JSON, no prose:
{
  "monthlyRevenueRange": "<short ₹ range, e.g. '₹8–14 lakh / month'>",
  "footfallNote": "<one short sentence on expected footfall>",
  "reasoning": "<2-3 sentences: the hypothesis and the math behind the number — why this range and not higher/lower>",
  "assumptions": ["<concrete assumption 1, with numbers>", "<assumption 2>", "<assumption 3>"],
  "confidence": "low|medium|high"
}`;

  try {
    const resp = await model.generateContent({ contents: [{ role: "user", parts: [{ text: prompt }] }] });
    const candidate: any = resp.response?.candidates?.[0];
    const text = candidate?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "";
    const meta = candidate?.groundingMetadata ?? {};
    const sources: { uri: string; title?: string }[] = [];
    for (const c of meta.groundingChunks ?? []) {
      if (c.web?.uri) sources.push({ uri: c.web.uri, title: c.web.title });
    }
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]);
    if (!parsed.monthlyRevenueRange) return null;
    return {
      monthlyRevenueRange: String(parsed.monthlyRevenueRange).slice(0, 60),
      footfallNote: String(parsed.footfallNote || "").slice(0, 200),
      reasoning: String(parsed.reasoning || "").slice(0, 600),
      assumptions: Array.isArray(parsed.assumptions)
        ? parsed.assumptions.map((a: any) => String(a).slice(0, 160)).slice(0, 5)
        : [],
      confidence: ["low", "medium", "high"].includes(parsed.confidence) ? parsed.confidence : "low",
      sources: sources.slice(0, 3),
      monthlyRevenueMidINR: parseRupeeRange(String(parsed.monthlyRevenueRange)) ?? undefined,
    };
  } catch {
    return null;
  }
}

// Payback (months) from a monthly revenue, an operating margin and the one-time
// setup capex (optionally net of monthly rent). Pure arithmetic on numbers we
// already have — no API call. Returns null when revenue is unknown/zero.
export interface PaybackEstimate {
  months: number | null;
  monthlyProfitINR: number | null;
  assumptions: string[];          // editable, human-readable so the buyer can adjust
}

export function computePayback(opts: {
  monthlyRevenueINR: number | null;
  marginPct: number;
  setupCapex: number;
  monthlyRentINR?: number | null;  // if known (99acres), subtract from monthly profit
}): PaybackEstimate {
  const assumptions: string[] = [
    `Operating margin ≈ ${Math.round(opts.marginPct * 100)}%`,
    `One-time setup ≈ ₹${(opts.setupCapex / 1e5).toFixed(1)} lakh`,
  ];
  if (opts.monthlyRentINR && opts.monthlyRentINR > 0) {
    assumptions.push(`Monthly rent ≈ ₹${Math.round(opts.monthlyRentINR / 1000)}k (from listings)`);
  }
  if (!opts.monthlyRevenueINR || opts.monthlyRevenueINR <= 0) {
    return { months: null, monthlyProfitINR: null, assumptions };
  }
  const grossProfit = opts.monthlyRevenueINR * opts.marginPct;
  const monthlyProfit = grossProfit - (opts.monthlyRentINR ?? 0);
  if (monthlyProfit <= 0) {
    return { months: null, monthlyProfitINR: Math.round(monthlyProfit), assumptions };
  }
  return {
    months: Math.round(opts.setupCapex / monthlyProfit),
    monthlyProfitINR: Math.round(monthlyProfit),
    assumptions,
  };
}

// Detailed, grounded "why this exact spot" narrative for an expansion gap.
// Takes the already-computed signals so the model explains a real decision
// rather than inventing one. Returns a few sentences of plain reasoning.
export async function aiGapRationale(opts: {
  vertical: string;
  gap: {
    lat: number; lng: number; score: number; footfallIndex: number;
    competitorCount: number; nearestOwnKm: number;
    revenueBand: string;
    populationDensity: number | null;
    nearbyAnchors: { label: string; name: string; meters: number }[];
  };
}): Promise<string | null> {
  const model = vertex().getGenerativeModel({
    model: "gemini-2.5-flash",
    tools: [{ googleSearch: {} } as any],
  });
  const kind: Record<string, string> = {
    BFSI_ATM: "a new ATM", BFSI_BRANCH: "a new bank branch",
    FMCG_RETAIL: "a new grocery/retail store", FMCG_WAREHOUSE: "a new dark store / warehouse",
  };
  const g = opts.gap;
  const what = kind[opts.vertical] ?? "a new outlet";
  const anchors = g.nearbyAnchors.length
    ? g.nearbyAnchors.map(a => `${a.label} "${a.name}" ${a.meters >= 1000 ? (a.meters / 1000).toFixed(1) + "km" : a.meters + "m"} away`).join(", ")
    : "no major anchors detected nearby";
  const prompt = `You are a location strategist explaining to a business why we recommend opening ${what} at coordinates ${g.lat.toFixed(4)}, ${g.lng.toFixed(4)} in India.

Our model's signals for this spot:
- Expansion score: ${g.score}/100
- Footfall index: ${g.footfallIndex}/100
- Population density: ${g.populationDensity != null ? g.populationDensity.toLocaleString("en-IN") + " people/km²" : "unknown"}
- Competing sites within 1.2 km: ${g.competitorCount} (competition validates the market; too much would split share)
- Distance from the client's nearest existing site: ${g.nearestOwnKm} km (so no cannibalisation)
- Nearby demand anchors: ${anchors}
- Revenue potential band: ${g.revenueBand}

Use Google Search to identify the actual neighbourhood/locality at these coordinates and any real local context (metro, IT parks, residential growth, malls, recent development). Then write 3-5 SHORT sentences a business owner can act on, explaining WHY this exact spot is a good expansion target: the demand drivers, the competitive logic, the network fit, and one risk to watch. Name the real locality. Be specific and concrete, not generic. Do not use markdown headings or bullet symbols — plain sentences only.`;

  try {
    const resp = await model.generateContent({ contents: [{ role: "user", parts: [{ text: prompt }] }] });
    const candidate: any = resp.response?.candidates?.[0];
    const text = candidate?.content?.parts?.map((p: any) => p.text ?? "").join("").trim() ?? "";
    return text || null;
  } catch {
    return null;
  }
}

// One mini-query per quadrant — gives spatial variation in the growth score.
async function quadrantScore(area: string, city: string, label: string): Promise<{ growthScore: number; headline: string }> {
  const model = vertex().getGenerativeModel({
    model: "gemini-2.5-flash",
    tools: [{ googleSearch: {} } as any],
  });
  const prompt = `Rate the future commercial growth potential of the ${label} part of ${area}, ${city}, India.
Consider: new construction, metro lines, recent announcements specific to that side. Use Google Search.
Reply with ONLY JSON: {"growthScore": <0-100 integer>, "headline": "<one sentence reason>"}`;

  try {
    const resp = await model.generateContent({ contents: [{ role: "user", parts: [{ text: prompt }] }] });
    const text: string = resp.response?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "{}";
    const parsed = extractJson(text);
    if (!parsed) return { growthScore: 50, headline: "Insufficient signal." };
    return {
      growthScore: Math.max(0, Math.min(100, Number(parsed.growthScore) || 50)),
      headline: String(parsed.headline || ""),
    };
  } catch {
    return { growthScore: 50, headline: "Quadrant analysis unavailable." };
  }
}

// Limit concurrent Vertex calls to avoid 429 rate-limit spikes.
async function runWithLimit<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let i = 0;
  async function worker() {
    while (i < tasks.length) {
      const idx = i++;
      results[idx] = await tasks[idx]();
    }
  }
  await Promise.all(Array(Math.min(limit, tasks.length)).fill(0).map(() => worker()));
  return results;
}

export interface AreaStats {
  vertical?: string;
  competitorCount: number;     // total competitor sites in the searched area
  ownCount: number;            // your own sites already in the area
  avgFinal?: number;           // mean hex suitability across the area
  bestFinal?: number;          // best hex suitability in the area
}

export async function runGrowthAgent(opts: { area: string; city: string; extraContext?: string; contextBrief?: string; areaStats?: AreaStats }): Promise<AgentResult> {
  const queries = SEARCH_TEMPLATES.map(t => t.replace("{area}", opts.area).replace("{city}", opts.city));

  // 6 grounded queries, run at high concurrency (see below)
  const groundedTasks = queries.map(q => async () => {
    try { return await groundedQuery(q); }
    catch (e) {
      console.error(`agent grounded query failed: ${q} → ${(e as Error).message}`);
      return { query: q, summary: `(error: ${(e as Error).message})`, sources: [] as { uri: string; title?: string }[] };
    }
  });

  // 4 quadrant micro-runs — also capped at 4 concurrent
  const quadTasks = (["northeast", "northwest", "southeast", "southwest"] as const).map(label =>
    () => quadrantScore(opts.area, opts.city, label),
  );

  // Run grounded queries and quadrant micro-runs TOGETHER (not sequential phases)
  // at higher concurrency. Gemini Flash tolerates this; the occasional 429 is
  // retried inside groundedQuery. This roughly halves wall-clock vs. the old
  // 3-concurrent two-phase approach (~25s → ~10-12s).
  const [trail, quadScores] = await Promise.all([
    runWithLimit(groundedTasks, 8),
    runWithLimit(quadTasks, 4),
  ]);
  const [q1, q2, q3, q4] = quadScores;

  const quadrantScores = [
    { quadrant: "NE" as const, ...q1 },
    { quadrant: "NW" as const, ...q2 },
    { quadrant: "SE" as const, ...q3 },
    { quadrant: "SW" as const, ...q4 },
  ];
  const overallGrowth = Math.round(quadrantScores.reduce((s, q) => s + q.growthScore, 0) / 4);

  const executive = reconcileVerdict(
    await synthesize(opts, trail, overallGrowth, opts.contextBrief, opts.areaStats),
    opts.areaStats,
  );

  return {
    area: opts.area,
    city: opts.city,
    growthScore: overallGrowth,
    reasoning: executive.bottomLine,
    executive,
    trail,
    quadrantScores,
  };
}

async function synthesize(
  opts: { area: string; city: string; extraContext?: string },
  trail: AgentTrailItem[],
  growthScore: number,
  contextBrief?: string,
  areaStats?: AreaStats,
): Promise<ExecutiveSummary> {
  const model = vertex().getGenerativeModel({ model: "gemini-2.5-flash" });

  const statsLine = areaStats
    ? `Market reality in ${opts.area} for this use-case: ${areaStats.competitorCount} competitor site(s) already operating here, and the company already has ${areaStats.ownCount} of its own site(s) in this area. Best zone scores only ${areaStats.bestFinal ?? "?"}/100; area average ${areaStats.avgFinal ?? "?"}/100.`
    : "";

  const prompt = `You are a top-tier, BRUTALLY HONEST MBA consultant writing a one-page site-selection brief. Do NOT be a cheerleader — if this area is a bad bet, say so plainly.
Location: ${opts.area}, ${opts.city}, India
Overall growth score (0-100): ${growthScore}
${statsLine ? statsLine + "\n" : ""}${opts.extraContext ? `Additional context:\n${opts.extraContext}\n` : ""}
${contextBrief ? `${contextBrief}\nReference specific nearby amenities where they support or undermine the site. Never call something nearby unless the context says it is "close".\n` : ""}

Research findings (from grounded Google searches):
${trail.map((t, i) => `### Finding ${i + 1}: ${t.query}\n${t.summary}`).join("\n\n")}

HONESTY RULES (critical):
- If the area is already SATURATED (many competitors / the company already has sites here) or the best zone score is low (<50), recommend "CAUTION" or "AVOID" — do NOT force a "GO".
- State the market reality plainly in "marketState" (e.g. "Already saturated — 18 competing ATMs and you run 6 here; little headroom.").
- When the area is weak or saturated, populate "alternatives" with 2-3 specific nearby localities/micro-markets that are likely better, with a one-line reason each. If the area IS a good bet, "alternatives" can be an empty array.
- Do not invent infrastructure that doesn't exist in this city.

Respond ONLY with strict JSON of this exact shape:
{
  "rating": <integer 1-5 stars>,
  "recommendation": "GO" | "CAUTION" | "AVOID",
  "marketState": "<one honest sentence on competition/saturation here>",
  "drivers": [ {"headline": "<short headline with a concrete fact>", "detail": "<1 sentence quantified implication>"}, ... 2 to 4 ],
  "risks": [ {"headline": "<short headline with a concrete risk>", "detail": "<1 sentence quantified implication>"}, ... 2 to 3 ],
  "alternatives": ["<other locality — one-line reason>", "... 0 to 3 (only when this area is weak)"],
  "bottomLine": "<2 sentences: decisive action. If AVOID, say so and point elsewhere.>"
}

Style rules:
- Headlines must contain SPECIFIC facts (year, name, ₹ amount, or count), not generalities.
- BAD: "Metro is expanding". GOOD: "Chennai Metro Phase 2 opens Q4 2027 within 800m".
- Quantify impact where possible ("adds ~40K daily commuter footfall").`;

  // Retry synthesis up to 3 times with exponential backoff on 429s
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await model.generateContent(prompt);
      const text: string = resp.response?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "{}";
      const parsed = extractJson(text);
      if (!parsed) return defaultExec(growthScore);
      return {
        rating: clamp(parsed.rating, 1, 5),
        recommendation: ["GO", "CAUTION", "AVOID"].includes(parsed.recommendation) ? parsed.recommendation : "CAUTION",
        drivers: Array.isArray(parsed.drivers) ? parsed.drivers.slice(0, 4) : [],
        risks: Array.isArray(parsed.risks) ? parsed.risks.slice(0, 3) : [],
        marketState: parsed.marketState ? String(parsed.marketState) : undefined,
        alternatives: Array.isArray(parsed.alternatives) ? parsed.alternatives.map(String).slice(0, 3) : [],
        bottomLine: String(parsed.bottomLine || ""),
      };
    } catch (e) {
      const msg = (e as Error).message;
      console.error(`synthesis attempt ${attempt + 1} failed:`, msg);
      if (msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED")) {
        await new Promise(r => setTimeout(r, 2000 * Math.pow(2, attempt))); // 2s, 4s, 8s
        continue;
      }
      return defaultExec(growthScore);
    }
  }
  return defaultExec(growthScore);
}

// Bind the AI's headline verdict to the actual best site score so the banner
// can't say "Highly Recommended / 4★" over a mediocre top score. The agent is
// already told not to force a GO on a weak area, but nothing caps its UPSIDE —
// so a best-zone of 71 still produced GO + 4 stars. We clamp (never inflate):
//  best >=75 → GO ok, up to 5★ | 60-74 → max CAUTION, 3★ | 50-59 → CAUTION, 2-3★
//  <50 → AVOID, max 2★. When bestFinal is unknown we leave the AI's call alone.
export function reconcileVerdict(ex: ExecutiveSummary, areaStats?: AreaStats): ExecutiveSummary {
  const best = areaStats?.bestFinal;
  if (typeof best !== "number") return ex;

  let recommendation = ex.recommendation;
  let starCap = 5;
  if (best < 50) { recommendation = "AVOID"; starCap = 2; }
  else if (best < 60) { if (recommendation === "GO") recommendation = "CAUTION"; starCap = 3; }
  else if (best < 75) { if (recommendation === "GO") recommendation = "CAUTION"; starCap = 3; }
  // best >= 75: GO is allowed; no cap beyond the natural 5.

  const rating = Math.max(1, Math.min(ex.rating, starCap));
  return { ...ex, recommendation, rating };
}

// Extract the first JSON object from a string, handling ```json fences
// and the occasional trailing-comma / smart-quote that Gemini produces.
function extractJson(text: string): any {
  let s = text.trim();
  // Strip ```json ... ``` or ``` ... ``` fences
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let json = m[0];
  // Cleanup common LLM JSON sins
  json = json.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  json = json.replace(/,(\s*[}\]])/g, "$1"); // trailing commas
  try { return JSON.parse(json); } catch {}
  // Last resort: try line-by-line repair (drop comments etc.)
  try { return JSON.parse(json.replace(/\/\/.*$/gm, "")); } catch (e) {
    console.error("extractJson failed:", (e as Error).message, "→", json.slice(0, 200));
    return null;
  }
}

function clamp(v: any, lo: number, hi: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return Math.round((lo + hi) / 2);
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

function defaultExec(growth: number): ExecutiveSummary {
  return {
    rating: Math.round(growth / 20) || 3,
    recommendation: growth > 70 ? "GO" : growth > 40 ? "CAUTION" : "AVOID",
    drivers: [], risks: [],
    bottomLine: "Insufficient data for a confident recommendation.",
  };
}
