import axios from "axios";
import * as https from "https";
import * as crypto from "crypto";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const legacyAgent = new https.Agent({
  secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT,
  rejectUnauthorized: false,
});

async function testWB() {
  console.log("=== Testing West Bengal RERA (https://rera.wb.gov.in/district_project.php?dcode=0) ===");
  try {
    const response = await axios.get("https://rera.wb.gov.in/district_project.php?dcode=0", {
      headers: { "User-Agent": UA },
      httpsAgent: legacyAgent,
      timeout: 25000,
    });
    console.log(`Status: ${response.status}`);
    const html = response.data;
    console.log(`HTML Length: ${html.length} characters`);
    
    // Check for tables in the HTML
    const stripTags = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    
    const tableMatch = html.match(/<table[\s\S]*?<\/table>/i);
    if (!tableMatch) {
      console.log("No table found in the HTML.");
      return;
    }
    
    const rows: string[][] = [];
    for (const rowMatch of tableMatch[0].matchAll(/<tr[\s\S]*?<\/tr>/gi)) {
      const cells: string[] = [];
      for (const cellMatch of rowMatch[0].matchAll(/<t[dh][\s\S]*?<\/t[dh]>/gi)) {
        cells.push(stripTags(cellMatch[0]));
      }
      if (cells.length) rows.push(cells);
    }
    
    console.log(`Total table rows found: ${rows.length}`);
    if (rows.length > 1) {
      const header = rows[0];
      const dataRows = rows.slice(1);
      
      const twoYearsAgoMs = new Date(2024, 5, 28).getTime(); // June 28, 2024
      let countLast2Years = 0;
      
      const parseWBDate = (dStr: string): number | null => {
        const m = dStr.match(/(\d{1,2})-(\d{1,2})-(\d{4})/);
        if (!m) return null;
        const d = new Date(+m[3], +m[2] - 1, +m[1]);
        return isNaN(d.getTime()) ? null : d.getTime();
      };

      const last2YearsProjects: any[] = [];

      dataRows.forEach((row) => {
        const regDateStr = row[5] || "";
        const regDateMs = parseWBDate(regDateStr);
        if (regDateMs && regDateMs >= twoYearsAgoMs) {
          countLast2Years++;
          last2YearsProjects.push({
            id: row[1],
            name: row[2],
            completion: row[3],
            regNo: row[4],
            date: regDateStr
          });
        }
      });
      
      console.log(`\n=== West Bengal Last 2 Years Count ===`);
      console.log(`Projects registered since 28-06-2024: ${countLast2Years} out of ${dataRows.length}`);
      console.log("Sample recent projects (First 5):");
      console.log(last2YearsProjects.slice(0, 5));
    }
  } catch (error) {
    console.error("WB Test failed:", (error as Error).message);
  }
}

async function testBihar() {
  console.log("\n=== Testing Bihar RERA (https://rera.bihar.gov.in/RegisteredPP.aspx) ===");
  try {
    const response = await axios.get("https://rera.bihar.gov.in/RegisteredPP.aspx", {
      headers: { "User-Agent": UA },
      httpsAgent: legacyAgent,
      timeout: 25000,
    });
    console.log(`Status: ${response.status}`);
    const html = response.data;
    console.log(`HTML Length: ${html.length} characters`);

    // Log the pagination part to see how pages are structured
    console.log("\nInspecting Bihar pagination tags:");
    const paginatorMatches = html.match(/class=["']pagination["'][\s\S]*?<\/div>/i) || 
                             html.match(/GridView1[\s\S]*?<\/table>/i) ||
                             html.match(/__doPostBack[\s\S]*?/gi);
    
    // Search specifically for __doPostBack or gridview page links
    const pageLinks: string[] = [];
    const re = /href=["']javascript:__doPostBack\('([^']+)','([^']+)'\)["']/g;
    let match;
    while ((match = re.exec(html)) !== null) {
      pageLinks.push(`Target: ${match[1]}, Arg: ${match[2]}`);
      if (pageLinks.length >= 5) break;
    }
    console.log("Found pagination links:", pageLinks);

    const stripTags = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    
    const rows: string[][] = [];
    for (const rowMatch of html.matchAll(/<tr[\s\S]*?<\/tr>/gi)) {
      const cells: string[] = [];
      for (const cellMatch of rowMatch[0].matchAll(/<t[dh][\s\S]*?<\/t[dh]>/gi)) {
        cells.push(stripTags(cellMatch[0]));
      }
      if (cells.length >= 4) rows.push(cells);
    }
    
    console.log(`Total rows with >= 4 cells on Page 1: ${rows.length}`);
    if (rows.length > 0) {
      const twoYearsAgoMs = new Date(2024, 5, 28).getTime(); // June 28, 2024
      let countLast2Years = 0;
      
      const dataRows = rows.slice(1);
      dataRows.forEach(row => {
        const dateStr = row[4] || "";
        const dateMs = Date.parse(dateStr);
        if (!isNaN(dateMs) && dateMs >= twoYearsAgoMs) {
          countLast2Years++;
        }
      });
      console.log(`Page 1 recent projects (since 28-06-2024): ${countLast2Years} out of ${dataRows.length}`);
    }
  } catch (error) {
    console.error("Bihar Test failed:", (error as Error).message);
  }
}

async function main() {
  await testWB();
  await testBihar();
}

main().catch(console.error);
