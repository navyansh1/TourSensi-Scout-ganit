// Night-time lights — a fresh, free proxy for economic activity & growth.
//
// Source: NASA GIBS VIIRS DNB "Black Marble" monthly composites, served as
// public PNG/JPEG WMTS tiles (no auth, no key), the same shape as the JRC water
// tiles in flood.ts:
//   https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/
//     VIIRS_SNPP_DayNightBand_At_Sensor_Radiance/default/{TIME}/
//     GoogleMapsCompatible_Level8/{z}/{y}/{x}.png
//
// Why nightlights (and what it is / isn't):
//  - It is MONTHLY-FRESH (≈2-month publish lag), so unlike Census 2011 it sees
//    the new township, the new IT corridor, the dark-store belt. Its big value is
//    *recency* and *change-over-time*.
//  - It measures LIT ECONOMIC ACTIVITY, not household income. A market street and
//    a floodlit stadium both glow. So we use it as an area-level VITALITY signal
//    and a GROWTH TREND signal (this period vs. a few years ago) — NOT as an
//    income/affluence verdict.
//  - Native resolution is ~500 m, so it is honest only at neighbourhood/catchment
//    scale. We therefore read it AREA-WIDE for the whole bbox (like WorldPop),
//    never per-hex.
//  - Bright urban cores saturate ("blooming"), so we log-scale and cap.
//
// Fails open (returns null) on any hiccup — never blocks an analysis.

import axios from "axios";
import { PNG } from "pngjs";

const GIBS_BASE =
  "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/" +
  "VIIRS_SNPP_DayNightBand_At_Sensor_Radiance/default";
const MATRIX = "GoogleMapsCompatible_Level8";
const TILE_SIZE = 256;
const MAX_Z = 8; // Black Marble DNB is published to zoom level 8 on GIBS.

export interface NightlightResult {
  // 0..100 area vitality (log-scaled mean radiance over the bbox).
  vitality: number;
  // Signed change vs. the comparison period: +ve = brightening (growing),
  // -ve = dimming. Roughly -40..+40 in practice; null when the older
  // composite is unavailable.
  trendDelta: number | null;
  // Mean raw luminance 0..255 sampled from the recent composite (debug/aux).
  meanLuminance: number;
  recentPeriod: string;        // e.g. "2026-04-01"
  comparePeriod: string | null;
}

// VIIRS DNB monthly composites are dated the 1st of each month. We ask for a
// composite ~2 months back (publish lag) and compare against the same month
// three years earlier (removes seasonal/festival lighting bias).
function recentMonth(): string {
  const d = new Date();
  d.setMonth(d.getMonth() - 2);
  d.setDate(1);
  return d.toISOString().slice(0, 10);
}
function yearsBefore(dateStr: string, years: number): string {
  const d = new Date(dateStr);
  d.setFullYear(d.getFullYear() - years);
  return d.toISOString().slice(0, 10);
}

function lngLatToTile(lat: number, lng: number, z: number) {
  const n = 2 ** z;
  const x = ((lng + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const yf =
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  const tx = Math.floor(x);
  const ty = Math.floor(yf);
  return {
    x: tx,
    y: ty,
    px: Math.min(TILE_SIZE - 1, Math.floor((x - tx) * TILE_SIZE)),
    py: Math.min(TILE_SIZE - 1, Math.floor((yf - ty) * TILE_SIZE)),
  };
}

// Per-process tile cache — a bbox reuses the same 1–2 tiles, so this avoids
// re-downloading. Keyed by period + z/x/y.
const tileCache = new Map<string, PNG | null>();

async function fetchTile(time: string, z: number, x: number, y: number): Promise<PNG | null> {
  const key = `${time}/${z}/${x}/${y}`;
  if (tileCache.has(key)) return tileCache.get(key) ?? null;
  try {
    const url = `${GIBS_BASE}/${time}/${MATRIX}/${z}/${y}/${x}.png`;
    const resp = await axios.get(url, { responseType: "arraybuffer", timeout: 12_000 });
    const png = PNG.sync.read(Buffer.from(resp.data));
    tileCache.set(key, png);
    return png;
  } catch {
    tileCache.set(key, null);
    return null;
  }
}

// Mean luminance (0..255) of the bbox footprint inside a single composite.
// The DNB radiance tiles are greyscale-ish (dark = no light, bright = lit), so
// the green channel is a fine luminance proxy. We sample the pixels covering the
// bbox within the tile(s) it falls in.
async function meanLuminanceForBbox(
  time: string,
  bbox: { south: number; west: number; north: number; east: number },
): Promise<number | null> {
  const z = MAX_Z;
  // Corner tiles/pixels. At z8 a city-scale bbox lands in one or two tiles.
  const nw = lngLatToTile(bbox.north, bbox.west, z);
  const se = lngLatToTile(bbox.south, bbox.east, z);

  let sum = 0;
  let count = 0;
  for (let tx = nw.x; tx <= se.x; tx++) {
    for (let ty = nw.y; ty <= se.y; ty++) {
      const png = await fetchTile(time, z, tx, ty);
      if (!png) continue;
      const x0 = tx === nw.x ? nw.px : 0;
      const x1 = tx === se.x ? se.px : TILE_SIZE - 1;
      const y0 = ty === nw.y ? nw.py : 0;
      const y1 = ty === se.y ? se.py : TILE_SIZE - 1;
      for (let py = y0; py <= y1; py++) {
        for (let px = x0; px <= x1; px++) {
          const idx = (py * TILE_SIZE + px) * 4;
          const a = png.data[idx + 3];
          if (a < 20) continue; // transparent = no data, skip
          // Luminance from RGB (DNB ramp is near-greyscale; weight green).
          const lum = 0.3 * png.data[idx] + 0.5 * png.data[idx + 1] + 0.2 * png.data[idx + 2];
          sum += lum;
          count++;
        }
      }
    }
  }
  if (count === 0) return null;
  return sum / count;
}

// Map mean luminance (0..255) → 0..100 vitality. Log-scaled so dense, saturated
// cores don't dominate and dim-but-real activity still reads above zero.
function luminanceToVitality(lum: number): number {
  if (lum <= 1) return 0;
  // ~3 → ~0, ~40 → ~50, ~180 → ~90.
  const v = (Math.log10(lum) - 0.45) * 70;
  return Math.max(0, Math.min(100, Math.round(v)));
}

export async function bboxNightlights(
  bbox: { south: number; west: number; north: number; east: number },
): Promise<NightlightResult | null> {
  try {
    const recent = recentMonth();
    const compare = yearsBefore(recent, 3);

    const [recentLum, compareLum] = await Promise.all([
      meanLuminanceForBbox(recent, bbox),
      meanLuminanceForBbox(compare, bbox).catch(() => null),
    ]);
    if (recentLum == null) return null;

    const vitality = luminanceToVitality(recentLum);
    // Trend: change in vitality units between the two composites. Positive means
    // the area got brighter (more lit economic activity) over 3 years.
    let trendDelta: number | null = null;
    if (compareLum != null && compareLum > 1) {
      trendDelta = vitality - luminanceToVitality(compareLum);
    }

    return {
      vitality,
      trendDelta,
      meanLuminance: Math.round(recentLum * 10) / 10,
      recentPeriod: recent,
      comparePeriod: compareLum != null ? compare : null,
    };
  } catch (e) {
    console.error("nightlights failed:", (e as Error).message);
    return null;
  }
}

// Translate the 3-year brightening trend into a bounded growth nudge (in score
// points) to add to the AI growth prior. Capped to ±10 so a noisy satellite
// reading can never swamp the analyst-grade growth narrative — it only tilts it.
export function trendToGrowthNudge(trendDelta: number | null): number {
  if (trendDelta == null) return 0;
  return Math.max(-10, Math.min(10, Math.round(trendDelta * 0.5)));
}
