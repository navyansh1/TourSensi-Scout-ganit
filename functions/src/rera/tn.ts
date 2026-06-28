// Tamil Nadu RERA adapter (STATIC — plain HTML .php tables, no anti-bot).
// Verified live: HTTP 200, one table per year with 8 columns; ~89% of rows carry
// a parseable dwelling-unit count, ~84% a project name. We pull recent years and
// parse the same columns confirmed in testing.

import type { ReraAdapter, ReraProject } from "./types";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// TN splits its building registrations into one page per year (2017–present).
// The current-year page may not exist yet (404) and the latest year can be thin,
// so we pull the last ~4 years to get a solid recent set. 404s are skipped.
function yearUrls(): string[] {
  const y = new Date().getFullYear();
  const years = [y, y - 1, y - 2, y - 3];
  return years.map(
    (yr) => `https://rera.tn.gov.in/cms/reg_projects_tamilnadu/Building/${yr}.php`,
  );
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#8211;|&ndash;/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function parseUnits(text: string): number | null {
  const m = text.match(/(\d+)\s*(?:dwelling\s*units?|units?|flats?)/i);
  return m ? parseInt(m[1], 10) : null;
}

function parseName(text: string): string {
  const m = text.match(/Project Name:\s*["“‘']?\s*([^"”’\-]+)/);
  return m ? m[1].replace(/["“”‘’']/g, "").trim() : "";
}

function parseFloors(text: string): string {
  const m = text.match(/(Stilt[^,;]*?\d+\s*Floors?)/i);
  return m ? m[1].trim() : "";
}

// Split the table into rows and cells without a DOM lib (matches the verified
// 8-column layout). Good enough for this fixed-shape government table.
function parseTable(html: string): string[][] {
  const tableMatch = html.match(/<table[\s\S]*?<\/table>/i);
  if (!tableMatch) return [];
  const rows: string[][] = [];
  for (const rowMatch of tableMatch[0].matchAll(/<tr[\s\S]*?<\/tr>/gi)) {
    const cells: string[] = [];
    for (const cellMatch of rowMatch[0].matchAll(/<t[dh][\s\S]*?<\/t[dh]>/gi)) {
      cells.push(stripTags(cellMatch[0]));
    }
    if (cells.length) rows.push(cells);
  }
  return rows;
}

async function fetchYear(url: string): Promise<ReraProject[]> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html,*/*;q=0.8" },
    signal: AbortSignal.timeout(45000),
  });
  if (res.status !== 200) return [];
  const rows = parseTable(await res.text());
  const out: ReraProject[] = [];
  for (const r of rows.slice(1)) {
    // Verified columns: [0]S.No [1]RegNo [2]Promoter+addr [3]ProjectDetails+addr
    // [4]Approval [5]Completion [6]Other [7]Status
    if (r.length < 6) continue;
    const promoterCell = r[2] ?? "";
    const detailsCell = r[3] ?? "";
    if (!/Project Name|units?|Floors/i.test(detailsCell)) continue;
    out.push({
      state: "TN",
      regNo: (r[1] ?? "").split(/ dated/i)[0].trim(),
      projectName: parseName(detailsCell),
      promoter: promoterCell.split(",")[0].trim(),
      units: parseUnits(detailsCell),
      floors: parseFloors(detailsCell),
      address: promoterCell,
      locality: promoterCell, // refined later by geocoding
      completion: r[5] ?? "",
      status: (r[7] || "Registered").trim(),
      fetchedAt: Date.now(),
    });
  }
  return out;
}

export const tnAdapter: ReraAdapter = {
  state: "TN",
  name: "Tamil Nadu",
  kind: "static",
  async fetchProjects() {
    const results = await Promise.all(
      yearUrls().map((u) => fetchYear(u).catch(() => [] as ReraProject[])),
    );
    return results.flat();
  },
};
