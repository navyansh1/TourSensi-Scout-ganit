// Vertex AI grounding agent. Now runs:
//  - 8 grounded Google searches in parallel (was 6) — added news + competitor strategy
//  - 4 quadrant-level micro-runs to give each map sub-area a distinct growth score
//  - One MBA-grade synthesis producing structured drivers / risks / bottom line

import { VertexAI } from "@google-cloud/vertexai";

const PROJECT_ID = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "toursensi-ganit-71c77";
const LOCATION = "us-central1";

// Main grounded queries used for the overall area summary.
const SEARCH_TEMPLATES = [
  "upcoming metro rail or rapid transit projects near {area}, {city}, India",
  "new residential or commercial real estate project launches near {area}, {city}",
  "Special Economic Zone, IT park, or industrial park announcements in {area}, {city}",
  "highway, flyover, or road infrastructure projects in {area}, {city}",
  "government incentives, subsidies, or policy changes affecting business in {area}, {city}",
  "demographic and population growth trends {area}, {city}",
  "recent news in {area}, {city} in the last 30 days",
  "competitive landscape and major brand expansion strategy in {area}, {city}",
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

export async function runGrowthAgent(opts: { area: string; city: string; extraContext?: string; contextBrief?: string }): Promise<AgentResult> {
  const queries = SEARCH_TEMPLATES.map(t => t.replace("{area}", opts.area).replace("{city}", opts.city));

  // 8 grounded queries — capped at 4 concurrent so we don't hit Vertex 429s
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

  // Run grounded queries first, then quadrants (sequential phases — avoids 12-way parallel burst)
  // Cap at 3 concurrent so we leave headroom for the final synthesis call.
  const trail = await runWithLimit(groundedTasks, 3);
  const quadScores = await runWithLimit(quadTasks, 3);
  const [q1, q2, q3, q4] = quadScores;

  const quadrantScores = [
    { quadrant: "NE" as const, ...q1 },
    { quadrant: "NW" as const, ...q2 },
    { quadrant: "SE" as const, ...q3 },
    { quadrant: "SW" as const, ...q4 },
  ];
  const overallGrowth = Math.round(quadrantScores.reduce((s, q) => s + q.growthScore, 0) / 4);

  const executive = await synthesize(opts, trail, overallGrowth, opts.contextBrief);

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
): Promise<ExecutiveSummary> {
  const model = vertex().getGenerativeModel({ model: "gemini-2.5-flash" });
  const prompt = `You are a top-tier MBA consultant writing a one-page site-selection brief for an executive.
Location: ${opts.area}, ${opts.city}, India
Overall growth score (0-100): ${growthScore}
${opts.extraContext ? `Additional context:\n${opts.extraContext}\n` : ""}
${contextBrief ? `${contextBrief}\nUse this physical context: reference specific nearby amenities (e.g. "300 m from a metro station", "adjacent to a major highway") where they support or undermine the site.\n` : ""}

Research findings (from grounded Google searches):
${trail.map((t, i) => `### Finding ${i + 1}: ${t.query}\n${t.summary}`).join("\n\n")}

Write the brief. Respond ONLY with strict JSON of this exact shape:
{
  "rating": <integer 1-5 stars>,
  "recommendation": "GO" | "CAUTION" | "AVOID",
  "drivers": [
    {"headline": "<short headline with a concrete fact>", "detail": "<1 sentence quantified implication>"},
    ... 3 to 4 items
  ],
  "risks": [
    {"headline": "<short headline with a concrete risk>", "detail": "<1 sentence quantified implication>"},
    ... 2 to 3 items
  ],
  "bottomLine": "<2 sentences: what should the executive do? Be decisive, mention a specific action.>"
}

Style rules:
- Headlines must contain SPECIFIC facts (year, name, $/₹ amount, or count) not generalities.
- BAD: "Metro is expanding". GOOD: "Chennai Metro Phase 2 opens Q4 2027 within 800m"
- Details should QUANTIFY the impact when possible ("adds ~40K daily commuter footfall").
- Bottom line must be ACTIONABLE ("Open 1 premium-segment branch, defer ATM rollout").`;

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
