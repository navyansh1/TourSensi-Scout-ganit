// Historical rainfall signal — used for AGRICULTURAL / LAND collateral, where
// repayment depends on whether the land is productive. A farmer's ability to
// service a loan is tied to crop yield, which is tied to water — so consistent
// rainfall is a positive collateral signal, and chronic drought is a red flag.
//
// Source: Open-Meteo Historical Weather API (ERA5 reanalysis). Free, no API key,
// global, queryable by lat/lng. We pull the last 3 full years of daily
// precipitation and summarise annual totals + rainy-day counts.

import axios from "axios";

export interface RainfallSignal {
  avgAnnualMm: number;        // mean annual precipitation over the sampled years
  avgRainyDays: number;       // mean days/yr with > 1 mm
  years: { year: number; mm: number; rainyDays: number }[];
  band: "abundant" | "adequate" | "marginal" | "arid";
  note: string;               // one-line read for the collateral report
}

// Rough rainfall bands for Indian agriculture (annual mm):
//  > 1100  abundant (assured cropping, often double-crop)
//  750–1100 adequate (rain-fed cropping viable)
//  450–750 marginal (needs irrigation / drought-prone)
//  < 450   arid (low productivity without irrigation)
function classify(mm: number): RainfallSignal["band"] {
  if (mm >= 1100) return "abundant";
  if (mm >= 750) return "adequate";
  if (mm >= 450) return "marginal";
  return "arid";
}

function bandNote(band: RainfallSignal["band"], mm: number): string {
  const m = Math.round(mm);
  switch (band) {
    case "abundant": return `Abundant rainfall (~${m} mm/yr) — assured cropping; supports repayment capacity.`;
    case "adequate": return `Adequate rainfall (~${m} mm/yr) — rain-fed cropping viable.`;
    case "marginal": return `Marginal rainfall (~${m} mm/yr) — drought-prone; repayment depends on irrigation.`;
    case "arid": return `Low rainfall (~${m} mm/yr) — arid; productivity weak without assured irrigation.`;
  }
}

export async function getRainfall(lat: number, lng: number): Promise<RainfallSignal | null> {
  // Use the three most recent complete calendar years.
  const now = new Date();
  const lastFull = now.getFullYear() - 1;
  const start = `${lastFull - 2}-01-01`;
  const end = `${lastFull}-12-31`;
  try {
    const resp = await axios.get("https://archive-api.open-meteo.com/v1/archive", {
      params: {
        latitude: lat, longitude: lng,
        start_date: start, end_date: end,
        daily: "precipitation_sum", timezone: "auto",
      },
      timeout: 15_000,
    });
    const dates: string[] = resp.data?.daily?.time ?? [];
    const precip: (number | null)[] = resp.data?.daily?.precipitation_sum ?? [];
    if (!dates.length) return null;

    const byYear = new Map<number, { mm: number; rainyDays: number }>();
    for (let i = 0; i < dates.length; i++) {
      const yr = Number(dates[i].slice(0, 4));
      const v = precip[i];
      if (v == null) continue;
      const acc = byYear.get(yr) ?? { mm: 0, rainyDays: 0 };
      acc.mm += v;
      if (v > 1) acc.rainyDays += 1;
      byYear.set(yr, acc);
    }
    const years = [...byYear.entries()]
      .map(([year, v]) => ({ year, mm: Math.round(v.mm), rainyDays: v.rainyDays }))
      .sort((a, b) => a.year - b.year);
    if (!years.length) return null;

    const avgAnnualMm = Math.round(years.reduce((s, y) => s + y.mm, 0) / years.length);
    const avgRainyDays = Math.round(years.reduce((s, y) => s + y.rainyDays, 0) / years.length);
    const band = classify(avgAnnualMm);
    return { avgAnnualMm, avgRainyDays, years, band, note: bandNote(band, avgAnnualMm) };
  } catch {
    return null;
  }
}
