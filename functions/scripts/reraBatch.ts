/**
 * RERA batch scraper for DYNAMIC state portals (Maharashtra, Karnataka,
 * Telangana, Rajasthan). These portals are JavaScript single-page apps that
 * block plain HTTP, so we drive a real browser with Playwright, extract the
 * project rows, and write them into Firestore (rera_cache/<state>) for the
 * Lead Radar runtime to read instantly.
 *
 * This is a STANDALONE job — it is NOT bundled into the deployed Cloud Function
 * (Playwright/Chromium is too heavy for the function runtime). Run it on a
 * schedule (cron / Cloud Run job / GitHub Action), weekly is plenty since RERA
 * data changes slowly:
 *
 *     npm run rera:batch            # all dynamic states
 *     npm run rera:batch -- MH KA   # selected states
 *
 * Requires: `npm i -D playwright` and `npx playwright install chromium`, plus
 * GOOGLE_APPLICATION_CREDENTIALS pointing at a service-account key.
 *
 * NOTE: each state's selectors are encapsulated in its own scrape function so a
 * portal redesign only breaks (and is fixed in) one place. Selectors are written
 * defensively and the job fails-soft per state — one broken portal never aborts
 * the others.
 */

import * as admin from "firebase-admin";
import { chromium, type Page } from "playwright";
import type { ReraProject } from "../src/rera/types";
import { tnAdapter } from "../src/rera/tn";

if (!admin.apps.length) admin.initializeApp();
// RERA cards can lack coords/units → fields come through as undefined. Tell
// Firestore to drop undefined values instead of rejecting the whole write.
admin.firestore().settings({ ignoreUndefinedProperties: true });

function units(text: string): number | null {
  const m = text.match(/(\d+)\s*(?:dwelling\s*units?|units?|apartments?|flats?)/i);
  return m ? parseInt(m[1], 10) : null;
}

// Parse a DD/MM/YYYY (or DD.MM.YYYY) date string → ms epoch, for freshness sort.
function parseDMY(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const m = s.match(/(\d{1,2})[/.](\d{1,2})[/.](\d{4})/);
  if (!m) return undefined;
  const d = new Date(+m[3], +m[2] - 1, +m[1]);
  return isNaN(d.getTime()) ? undefined : d.getTime();
}

// KA encodes the registration date in the reg number: …/PR/DDMMYY/NNNNNN.
function parseKADate(reg: string): number | undefined {
  const m = reg.match(/\/PR\/(\d{2})(\d{2})(\d{2})\//);
  if (!m) return undefined;
  const d = new Date(2000 + +m[3], +m[2] - 1, +m[1]);
  return isNaN(d.getTime()) ? undefined : d.getTime();
}

// Most dynamic RERA portals show NOTHING until a search is submitted (verified on
// MahaRERA — the grid is empty/placeholder until you click "Search"). This helper
// clicks the first visible Search/Go/Submit button it finds and waits for rows to
// appear. Fails soft (returns false) so the caller can still try to read the page.
async function submitSearch(page: Page): Promise<boolean> {
  const selectors = [
    "button:has-text('Search')",
    "input[value='Search']",
    "button:has-text('Go')",
    "button[type='submit']",
    "input[type='submit']",
    "#search",
    ".search-btn",
  ];
  for (const sel of selectors) {
    const btn = page.locator(sel).first();
    try {
      if (await btn.isVisible({ timeout: 2000 })) {
        await btn.click({ timeout: 8000 });
        // Wait for the result grid to populate after the AJAX call.
        await page
          .waitForSelector("table tbody tr, .search-result .card, .project-card", { timeout: 30000 })
          .catch(() => {});
        await page.waitForTimeout(2000);
        return true;
      }
    } catch {
      // try the next selector
    }
  }
  return false;
}

// Click through "Next" pagination up to `maxPages`, collecting rows each time via
// the provided reader. Stops when there's no enabled Next button.
async function paginate(
  page: Page,
  readRows: () => Promise<string[][]>,
  maxPages = 10,
): Promise<string[][]> {
  const all: string[][] = [];
  for (let i = 0; i < maxPages; i++) {
    all.push(...(await readRows().catch(() => [])));
    const next = page.locator("a:has-text('Next'), button:has-text('Next'), .pagination .next a").first();
    try {
      if (!(await next.isVisible({ timeout: 1500 }))) break;
      const disabled = await next.getAttribute("class");
      if (disabled && /disabled/.test(disabled)) break;
      await next.click({ timeout: 6000 });
      await page.waitForTimeout(2500);
    } catch {
      break;
    }
  }
  return all;
}

// Firestore caps a document at 1 MB, but a state can have thousands of projects
// (KA ≈ 6k ≈ 2 MB). So we shard: a meta doc rera_cache/<STATE> records the shard
// count + timestamp, and the projects live in rera_cache/<STATE>__shard_<n>
// (SHARD_SIZE each). The reader stitches them back together.
const SHARD_SIZE = 500;

async function writeCache(state: string, projects: ReraProject[]) {
  const db = admin.firestore();
  const col = db.collection("rera_cache");

  // Clear any stale shards from a previous run before rewriting.
  const old = await col.where("__state", "==", state).get();
  const wipe = db.batch();
  old.docs.forEach((d) => wipe.delete(d.ref));
  await wipe.commit().catch(() => {});

  const shardCount = Math.max(1, Math.ceil(projects.length / SHARD_SIZE));
  for (let i = 0; i < shardCount; i++) {
    const slice = projects.slice(i * SHARD_SIZE, (i + 1) * SHARD_SIZE);
    await col.doc(`${state}__shard_${i}`).set({ __state: state, projects: slice });
  }
  await col.doc(state).set({
    state,
    shardCount,
    total: projects.length,
    refreshedAt: Date.now(),
  });
  console.log(`  [${state}] wrote ${projects.length} projects across ${shardCount} shard(s)`);
}

// Read the projects already cached for a state (stitched from its shards). Used by
// incremental scrapes so we only fetch + append genuinely new projects.
async function readExisting(state: string): Promise<ReraProject[]> {
  const col = admin.firestore().collection("rera_cache");
  const meta = await col.doc(state).get();
  if (!meta.exists) return [];
  const shardCount = (meta.data() as { shardCount?: number }).shardCount ?? 0;
  const shards = await Promise.all(
    Array.from({ length: shardCount }, (_, i) => col.doc(`${state}__shard_${i}`).get()),
  );
  return shards.flatMap((s) => (s.exists ? ((s.data() as { projects: ReraProject[] }).projects ?? []) : []));
}

// Merge new scrape results into existing cache, de-duped by reg number, newest
// kept. Returns the combined list (existing + genuinely new).
function mergeByReg(existing: ReraProject[], fresh: ReraProject[]): ReraProject[] {
  const byReg = new Map<string, ReraProject>();
  for (const p of existing) if (p.regNo) byReg.set(p.regNo, p);
  let added = 0;
  for (const p of fresh) {
    if (p.regNo && !byReg.has(p.regNo)) { byReg.set(p.regNo, p); added++; }
  }
  console.log(`    merged: ${added} new, ${byReg.size} total`);
  return [...byReg.values()];
}

/* ---------------------------- Maharashtra ---------------------------------- */
// MahaRERA: search page lists projects with a "View" link to a detail page that
// carries promoter, units, location (and the map view exposes lat/lng). We page
// through the result grid and read each row; detail enrichment is best-effort.
// MahaRERA lists newest-first and is India's largest RERA (Mumbai + Pune + Thane),
// so we pull generously — up to ~10,000 recent projects (1,000 pages × 10/page).
// The early-stop guard ends the loop once the portal runs out, so this is an
// upper bound, not a fixed cost.
// `known` = reg numbers already cached. In incremental mode we stop as soon as a
// full page is entirely known (newest-first means new projects are always at the
// top), so a weekly run scrapes only the 2-3 pages of genuinely new projects.
async function scrapeMH(page: Page, maxPages = 1000, known: Set<string> = new Set()): Promise<ReraProject[]> {
  const out: ReraProject[] = [];
  const seen = new Set<string>();
  const incremental = known.size > 0;
  // MahaRERA serves results inline in the document (no form-click needed): the
  // results URL takes project_state=27 (Maharashtra) and &page=N (0-based, 10
  // projects/page). Each project renders as a `.col-xl-4` card (verified: 10
  // cards + 10 P-reg numbers per page). We page until a page yields no new regs.
  const base =
    "https://maharera.maharashtra.gov.in/projects-search-result" +
    "?project_name=&project_location=&project_completion_date=" +
    "&project_state=27&project_district=0&carpetAreas=&completionPercentages=&project_division=&op=";

  // Quirk: &page=0 and &page=1 both return the first 10; real pages start at 1
  // and advance from there. We start at 1 and dedup by reg number, stopping when
  // a page yields no new projects.
  let consecutiveErrors = 0;
  for (let p = 1; p <= maxPages; p++) {
    // Wrap each page so a single slow/dead page can't hang the whole run. After a
    // few consecutive failures we bail (browser likely crashed) — but we KEEP and
    // return everything scraped so far, so a long run is never lost.
    let cards: { reg: string; name: string; promoter: string; district: string; mapsHref: string }[] = [];
    try {
      await page.goto(`${base}&page=${p}`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForSelector(".col-xl-4 h4.title4", { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(800);

      // Each real result card has: "# P5170…" (reg), an <h4.title4> (project name),
      // a <p.darkBlue.bold> (promoter), a district line, and a Google-Maps link
      // whose `query=lat,lng` gives coordinates for free (no geocoding for MH).
      cards = await page.$$eval(".col-xl-4", (els) =>
        els
          .map((el) => {
            const reg = ((el.textContent || "").match(/P\d{8,}/) || [""])[0];
            const name = (el.querySelector("h4.title4")?.textContent || "").replace(/\s+/g, " ").trim();
            const promoter = (el.querySelector("p.darkBlue")?.textContent || "").replace(/\s+/g, " ").trim();
            const district = (el.querySelector(".listingList a")?.textContent || "").replace(/\s+/g, " ").trim();
            const mapsHref = el.querySelector("a[href*='maps']")?.getAttribute("href") || "";
            return { reg, name, promoter, district, mapsHref };
          })
          .filter((c) => c.reg && c.name),
      );
      consecutiveErrors = 0;
    } catch (e) {
      consecutiveErrors++;
      console.log(`    [MH] page ${p} error (${consecutiveErrors}): ${(e as Error).message.slice(0, 50)}`);
      if (consecutiveErrors >= 3) {
        console.log(`    [MH] too many errors — stopping early with ${out.length} projects kept`);
        break;
      }
      continue; // skip this page, try the next
    }
    if (!cards.length) break;

    let added = 0;
    let newOnPage = 0; // projects on this page not already in the cache
    for (const c of cards) {
      if (!known.has(c.reg)) newOnPage++;
      if (seen.has(c.reg)) continue;
      seen.add(c.reg);
      added++;
      const geo = c.mapsHref.match(/query=([\d.]+),([\d.]+)/);
      out.push({
        state: "MH",
        regNo: c.reg,
        projectName: c.name.slice(0, 90),
        promoter: c.promoter,
        units: null, // not on the card; enriched from detail page later if needed
        district: c.district,
        address: `${c.name}, ${c.district}`,
        locality: c.district,
        lat: geo ? parseFloat(geo[1]) : undefined,
        lng: geo ? parseFloat(geo[2]) : undefined,
        fetchedAt: Date.now(),
      });
    }
    if (added === 0) break; // no new projects → reached the end of the portal list
    // Incremental: once a whole page is already cached, everything below is older
    // and known — stop. This makes weekly runs cheap (a few pages, not thousands).
    if (incremental && newOnPage === 0) {
      console.log(`    [MH] reached cached projects at page ${p} — stopping (incremental)`);
      break;
    }
  }
  return out;
}

/* ----------------------------- Karnataka ---------------------------------- */
// Karnataka RERA: viewAllProjects renders rows after an AJAX search. We trigger
// the listing and read the rendered grid.
async function scrapeKA(page: Page): Promise<ReraProject[]> {
  const out: ReraProject[] = [];
  // Karnataka's viewAllProjects page embeds the ENTIRE project list as JavaScript
  // arrays built with .push(): applicationNameList (ack no), …List2 (reg no),
  // …List3 (project name), …List4 (promoter). Index i across the arrays = one
  // project. We read the raw HTML and parse those pushes directly — no clicking,
  // no pagination, ~6k projects in one shot.
  await page.goto("https://rera.karnataka.gov.in/viewAllProjects", {
    waitUntil: "domcontentloaded",
    timeout: 120000,
  });
  await page.waitForTimeout(5000);
  const html = await page.content();

  const pull = (listName: string): string[] => {
    const re = new RegExp(`${listName}\\s*\\.push\\('((?:[^'\\\\]|\\\\.)*)'\\)`, "g");
    const vals: string[] = [];
    for (const m of html.matchAll(re)) vals.push(m[1].replace(/\\'/g, "'").trim());
    return vals;
  };

  const ack = pull("applicationNameList");
  const reg = pull("applicationNameList2");
  const name = pull("applicationNameList3");
  const promoter = pull("applicationNameList4");
  const count = Math.max(ack.length, reg.length, name.length);

  for (let i = 0; i < count; i++) {
    if (!name[i] && !reg[i]) continue;
    out.push({
      state: "KA",
      regNo: reg[i] || ack[i] || "",
      projectName: name[i] || "",
      promoter: promoter[i] || name[i] || "",
      units: null, // not in the list arrays; enrich from detail page if needed
      // The reg number encodes the district code (…/1248/469/…); locality is
      // resolved later by geocoding the project name + "Karnataka".
      address: `${name[i] || ""}, Karnataka`,
      locality: name[i] || "",
      registeredOn: parseKADate(reg[i] || ""),
      fetchedAt: Date.now(),
    });
  }
  return out;
}

/* ----------------------------- Telangana ---------------------------------- */
// TG backend (rerait.telangana.gov.in) requires picking a District (#District,
// 33 options) before #btnSearch returns anything; results render into #gridview.
// To cover the whole state we loop every district, search, and read the grid.
async function scrapeTG(page: Page): Promise<ReraProject[]> {
  const out: ReraProject[] = [];
  await page.goto("https://rerait.telangana.gov.in/SearchList/Search", {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });
  await page.waitForTimeout(4000);

  // The #District <select> sits inside #divDistrict which is display:none until
  // "Advanced Search" is opened — reveal it so the dropdown is interactable.
  await page.click("#btnAdvance", { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1000);

  // District option values (skip the placeholder at index 0).
  const districts = await page.$$eval("#District option", (els) =>
    els.map((o) => ({ value: (o as HTMLOptionElement).value, label: (o.textContent || "").trim() }))
      .filter((o) => o.value && !/select/i.test(o.label)),
  );

  for (const d of districts) {
    try {
      // Reload a clean form per district (avoids the previous result modal/overlay
      // covering #btnSearch, which caused click timeouts after the first search).
      await page.goto("https://rerait.telangana.gov.in/SearchList/Search", {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      await page.waitForTimeout(1500);
      await page.click("#btnAdvance", { timeout: 5000 }).catch(() => {});

      // Set the district + fire onchange, then submit via JS (bypasses overlay /
      // visibility issues that block a normal click).
      await page.evaluate((val) => {
        const sel = document.getElementById("District") as HTMLSelectElement;
        sel.value = val;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      }, d.value);
      await page.waitForTimeout(800);
      await page.evaluate(() => {
        const btn = document.getElementById("btnSearch") as HTMLElement | null;
        btn?.click();
      });
      await page.waitForSelector("#gridview tr, #gridview .row", { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(1500);

      const rows = await page.$$eval("#gridview tr", (els) =>
        els.map((el) =>
          Array.from(el.querySelectorAll("td")).map((c) => (c.textContent || "").replace(/\s+/g, " ").trim()),
        ).filter((c) => c.length >= 2),
      ).catch(() => [] as string[][]);

      for (const cells of rows) {
        const joined = cells.join(" ");
        const reg = cells.find((c) => /[A-Z]\d{4,}|\/\d{4}|P0\d{6,}/.test(c)) || cells[0] || "";
        out.push({
          state: "TG",
          regNo: reg,
          projectName: cells[1] || cells[0] || "",
          promoter: cells[2] || "",
          units: units(joined),
          district: d.label,
          address: `${cells[1] || ""}, ${d.label}, Telangana`,
          locality: d.label,
          fetchedAt: Date.now(),
        });
      }
      console.log(`    [TG] ${d.label}: ${rows.length} rows`);
    } catch (e) {
      console.log(`    [TG] ${d.label} failed:`, (e as Error).message.slice(0, 40));
    }
  }
  return out;
}

/* ----------------------------- Rajasthan ---------------------------------- */
// RJ ("RERA 2.0") project list: /ProjectList?status=3 renders a results table
// after clicking Search. Verified columns: District | Project Name | Project Type
// | Promoter Name | Application No | Registration No (with date) | Action.
// Reg dates are current (daily), so this is a live, valuable source.
async function scrapeRJ(page: Page): Promise<ReraProject[]> {
  const out: ReraProject[] = [];
  await page.goto("https://rera.rajasthan.gov.in/ProjectList?status=3", {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });
  await page.waitForTimeout(4000);
  // The grid populates after Search; click it then wait for data rows.
  await page.click("button:has-text('Search'), input[value='Search'], #btnSearch", { timeout: 8000 }).catch(() => {});
  await page.waitForFunction(() => document.querySelectorAll("table tbody tr").length > 1, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1500);

  const readRows = () =>
    page.$$eval("table tbody tr", (els) =>
      els.map((el) =>
        Array.from(el.querySelectorAll("td")).map((c) => (c.textContent || "").replace(/\s+/g, " ").trim()),
      ).filter((c) => c.length >= 5 && /RAJ\/P\//.test(c.join(" "))),
    );

  const rows = await paginate(page, readRows, 200).catch(() => [] as string[][]);
  const seen = new Set<string>();
  for (const cells of rows) {
    // [0]District [1]ProjectName [2]Type [3]Promoter [4]AppNo [5]RegNo(+date)
    const regCell = cells[5] || "";
    const reg = (regCell.match(/RAJ\/P\/[\w/]+/) || [regCell])[0];
    if (!reg || seen.has(reg)) continue;
    seen.add(reg);
    out.push({
      state: "RJ",
      regNo: reg,
      projectName: cells[1] || "",
      promoter: cells[3] || "",
      units: null,
      district: cells[0] || "",
      address: `${cells[1] || ""}, ${cells[0] || ""}, Rajasthan`,
      locality: cells[0] || "",
      completion: (regCell.match(/\d{2}\/\d{2}\/\d{4}/) || [""])[0],
      registeredOn: parseDMY(regCell),
      fetchedAt: Date.now(),
    });
  }
  return out;
}

/* ----------------------------- Haryana (GGM) ------------------------------ */
// hareraggm.gov.in/en/Project_Certificate.php renders its project list via a
// DataTables AJAX grid (not in raw HTML), so it needs a browser. Columns:
// # | Old TempID | New TempID | Certificate No | Project Name | Address | …
// Small dataset (~100 all-time) — Gurugram authority only.
async function scrapeHR(page: Page): Promise<ReraProject[]> {
  const out: ReraProject[] = [];
  await page.goto("https://hareraggm.gov.in/en/Project_Certificate.php", {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });
  // Wait for the DataTable to populate, then show all rows if a length selector exists.
  await page.waitForSelector("table tbody tr", { timeout: 40000 }).catch(() => {});
  await page.waitForTimeout(2000);
  await page.selectOption("select[name$='_length']", "100").catch(() => {});
  await page.waitForTimeout(1500);

  const readRows = () =>
    page.$$eval("table tbody tr", (els) =>
      els.map((el) =>
        Array.from(el.querySelectorAll("td")).map((c) => (c.textContent || "").replace(/\s+/g, " ").trim()),
      ).filter((c) => c.length >= 6),
    );
  const rows = await paginate(page, readRows, 20);
  const seen = new Set<string>();
  for (const cells of rows) {
    const projectName = cells[4] || "";
    if (!projectName || /project name/i.test(projectName)) continue;
    const reg = cells[3] || cells[2] || "";
    if (seen.has(reg + projectName)) continue;
    seen.add(reg + projectName);
    out.push({
      state: "HR",
      regNo: reg,
      projectName: projectName.slice(0, 90),
      promoter: "",
      units: null,
      district: "Gurugram",
      address: `${cells[5] || ""}, Gurugram, Haryana`,
      locality: cells[5] || "Gurugram",
      fetchedAt: Date.now(),
    });
  }
  return out;
}

// Scrapers accept the set of already-known reg numbers. Those that support
// incremental scraping (MH) stop early once they reach cached projects; the rest
// ignore the arg and do a full pull (then we merge, so nothing is lost).
type Scraper = (p: Page, known: Set<string>) => Promise<ReraProject[]>;
const SCRAPERS: Record<string, Scraper> = {
  // MH capped at 200 pages (~2,000 newest projects) — covers recent leads and
  // avoids the long-run browser hangs. Raise for a deeper historical pull.
  MH: (p, known) => scrapeMH(p, 200, known),
  KA: (p) => scrapeKA(p),
  TG: (p) => scrapeTG(p),
  RJ: (p) => scrapeRJ(p),
  HR: (p) => scrapeHR(p),
  // TN is a plain fetch (no browser) — reuse its adapter logic, ignore the page.
  TN: () => tnAdapter.fetchProjects(),
};

async function main() {
  const args = process.argv.slice(2);
  // `--full` forces a complete re-pull (ignores cache); default is incremental.
  const full = args.includes("--full");
  const requested = args.filter((a) => !a.startsWith("--")).map((s) => s.toUpperCase());
  const states = requested.length ? requested : Object.keys(SCRAPERS);

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  });
  for (const state of states) {
    const scraper = SCRAPERS[state];
    if (!scraper) {
      console.warn(`No scraper for state "${state}" — skipping`);
      continue;
    }
    const page = await ctx.newPage();
    try {
      const existing = full ? [] : await readExisting(state);
      const known = new Set(existing.map((p) => p.regNo).filter(Boolean));
      console.log(`[${state}] scraping… (${full ? "full" : `incremental, ${known.size} cached`})`);
      const fresh = (await scraper(page, known)).filter((p) => p.projectName || p.regNo);
      // Merge new with existing (de-duped) so weekly runs append rather than replace.
      const merged = full ? fresh : mergeByReg(existing, fresh);
      await writeCache(state, merged);
    } catch (e) {
      console.error(`[${state}] FAILED (cache left as-is):`, (e as Error).message);
    } finally {
      await page.close();
    }
  }
  await browser.close();
  console.log("RERA batch done.");
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
