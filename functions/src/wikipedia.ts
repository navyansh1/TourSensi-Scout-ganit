// Free Wikipedia summary for an Indian area. Gives us a contextual paragraph
// (history, demographics, notable features) for the MBA panel.

import axios from "axios";

export interface WikiContext {
  title: string;
  summary: string;
  url?: string;
  population?: number;
}

export async function wikiContext(area: string, city: string): Promise<WikiContext | null> {
  const candidates = [`${area}, ${city}`, area, `${area} (${city})`, `${area} ${city}`];
  for (const q of candidates) {
    const r = await trySummary(q);
    if (r) return r;
  }
  return null;
}

async function trySummary(title: string): Promise<WikiContext | null> {
  try {
    // Wikipedia titles use underscores for spaces, not %20
    const slug = title.replace(/\s+/g, "_");
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(slug)}`;
    const resp = await axios.get(url, {
      timeout: 5_000,
      validateStatus: () => true,
      // Wikipedia REST API requires a non-default User-Agent
      headers: { "User-Agent": "GeoScoutIQ/1.0 (contact: navyvibrance@gmail.com)" },
    });
    if (resp.status !== 200) return null;
    const d = resp.data;
    if (d.type === "disambiguation") return null;
    return {
      title: d.title,
      summary: d.extract ?? "",
      url: d.content_urls?.desktop?.page,
      population: extractPopulation(d.extract ?? ""),
    };
  } catch {
    return null;
  }
}

function extractPopulation(text: string): number | undefined {
  // Try to find "population of N" or "N people"
  const m = text.match(/population (?:of )?(?:about |around |approximately )?([\d,]+)/i);
  if (m) {
    const n = Number(m[1].replace(/,/g, ""));
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}
