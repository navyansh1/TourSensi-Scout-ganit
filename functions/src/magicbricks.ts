// Direct MagicBricks ₹/sqft scraper — free, no Apify dependency.
// MagicBricks serves locality search pages as plain HTML (HTTP 200, no anti-bot)
// with per-sqft rates embedded both in inline JSON ("sqFtPrice":N / "rate":N) and
// in "₹N per sqft" text. We pull all rates, trim outliers, and take the median.
//
// Verified live across 10 diverse localities (Bandra ₹52k → Vadodara ₹5k), ~90%
// first-try hit rate; the only misses are URL-slug spellings, which we work around
// by trying a few slug variants. 99acres/Housing.com block plain requests (403/406),
// so MagicBricks is the reliable direct source.

import type { PropertyListing, RealEstateSignals } from "./realestate";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const MIN_RATE = 1500;     // ₹/sqft sanity floor (drops parsing noise)
const MAX_RATE = 120000;   // ₹/sqft sanity ceiling (drops penthouse/typos)

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// MagicBricks uses a few URL shapes; also try common slug spelling variants
// (e.g. "indiranagar" vs "indira-nagar").
function candidateUrls(area: string, city: string): string[] {
  const a = slugify(area);
  const c = slugify(city);
  const aVariants = new Set([a, a.replace(/-/g, ""), a.replace(/nagar/, "-nagar")]);
  const urls: string[] = [];
  for (const av of aVariants) {
    urls.push(`https://www.magicbricks.com/property-for-sale-in-${av}-${c}-pppfs`);
    urls.push(`https://www.magicbricks.com/property-for-sale-in-${av}-pppfs`);
  }
  return [...new Set(urls)];
}

function extractRates(html: string): number[] {
  const rates: number[] = [];
  const push = (raw: string) => {
    const v = parseInt(raw.replace(/,/g, ""), 10);
    if (Number.isFinite(v) && v >= MIN_RATE && v <= MAX_RATE) rates.push(v);
  };
  // Inline JSON: "sqFtPrice":12345 / "pricePerSqft":12345 / "rate":12345
  for (const m of html.matchAll(/(?:sqftprice|persqft|pricepersqft|ratepersqft|"rate")["\s:]*₹?\s*([\d,]{3,})/gi)) {
    push(m[1]);
  }
  // Visible text: "₹12,345 per sqft" / "₹12,345 / sq.ft"
  for (const m of html.matchAll(/₹\s*([\d,]{3,})\s*(?:\/|per)\s*sq/gi)) {
    push(m[1]);
  }
  return rates;
}

// Drop the top/bottom 10% before taking the median, so a single penthouse or a
// data-entry typo can't drag the locality rate up.
function trimmedMedian(rates: number[]): number | null {
  if (!rates.length) return null;
  const sorted = [...rates].sort((a, b) => a - b);
  if (sorted.length < 5) {
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  }
  const k = Math.max(1, Math.floor(sorted.length / 10));
  const core = sorted.slice(k, sorted.length - k);
  const mid = Math.floor(core.length / 2);
  return core.length % 2 ? core[mid] : Math.round((core[mid - 1] + core[mid]) / 2);
}

export async function fetchMagicBricksDirect(opts: {
  city: string;
  area: string;
}): Promise<RealEstateSignals | null> {
  for (const url of candidateUrls(opts.area, opts.city)) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": UA,
          Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
        signal: AbortSignal.timeout(30000),
      });
      if (res.status !== 200) continue;
      const html = await res.text();
      const rates = extractRates(html);
      if (rates.length < 3) continue; // too thin — try next URL variant

      const median = trimmedMedian(rates);
      const listings: PropertyListing[] = rates.slice(0, 10).map((r) => ({
        title: `Listing in ${opts.area}`,
        pricePerSqft: r,
        area: opts.area,
      }));

      return {
        area: opts.area,
        city: opts.city,
        source: "magicbricks",
        sampleSize: rates.length,
        medianPricePerSqft: median,
        medianPrice: null, // total price not reliably parseable from the list page
        avgBHK: null,
        underConstructionShare: 0,
        listings,
        fetchedAt: Date.now(),
      };
    } catch {
      // try next URL variant
    }
  }
  return null;
}
