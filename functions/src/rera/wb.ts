import axios from "axios";
import * as https from "https";
import * as crypto from "crypto";
import type { ReraAdapter, ReraProject } from "./types";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const legacyAgent = new https.Agent({
  secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT,
  rejectUnauthorized: false,
});

function parseWBDate(dStr: string): number | null {
  const m = dStr.match(/(\d{1,2})-(\d{1,2})-(\d{4})/);
  if (!m) return null;
  const d = new Date(+m[3], +m[2] - 1, +m[1]);
  return isNaN(d.getTime()) ? null : d.getTime();
}

export const wbAdapter: ReraAdapter = {
  state: "WB",
  name: "West Bengal",
  kind: "static",
  async fetchProjects() {
    const response = await axios.get("https://rera.wb.gov.in/district_project.php?dcode=0", {
      headers: { "User-Agent": UA },
      httpsAgent: legacyAgent,
      timeout: 30000,
    });
    if (response.status !== 200) return [];
    const html = response.data;
    const stripTags = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    
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
    
    const out: ReraProject[] = [];
    // Skip header row at rows[0]
    for (const r of rows.slice(1)) {
      // Column format: [0]S.No [1]Project ID [2]Project Name [3]Completion Date [4]Registration No [5]Registration Date
      if (r.length < 6) continue;
      const projectName = r[2] ?? "";
      const regNo = r[4] ?? "";
      if (!projectName || !regNo) continue;
      
      const regDateStr = r[5] ?? "";
      const registeredOn = parseWBDate(regDateStr) || undefined;
      
      out.push({
        state: "WB",
        regNo,
        projectName: projectName.slice(0, 90),
        promoter: projectName, // WB table does not have promoter field, use project name as placeholder
        units: null,
        address: `${projectName}, West Bengal`,
        locality: "",
        completion: r[3] ?? "",
        status: "Registered",
        registeredOn,
        fetchedAt: Date.now(),
      });
    }
    return out;
  },
};
