// WorldPop population — free, current (annual estimates), 100 m gridded
// population for India. Gives us a REAL population count for the analysed area
// instead of guessing demand from POI density alone.
//
// The API is asynchronous: POST-style GET returns a taskid, then we poll the
// task until it's finished. It's free and needs no key. We query ONCE per
// analysis for the whole bbox (not per-hex) to keep it fast and cheap.

import axios from "axios";

const STATS_URL = "https://api.worldpop.org/v1/services/stats";
const TASK_URL = "https://api.worldpop.org/v1/tasks/";
// 2020 is the latest fully-published WorldPop "Global" year on this endpoint.
const YEAR = 2020;
const DATASET = "wpgppop";

export interface PopulationResult {
  totalPopulation: number;   // people inside the bbox
  areaKm2: number;           // bbox area
  densityPerKm2: number;     // derived density
  year: number;
}

function bboxAreaKm2(b: { south: number; west: number; north: number; east: number }): number {
  const latKm = (b.north - b.south) * 111;
  const midLat = (b.north + b.south) / 2;
  const lngKm = (b.east - b.west) * 111 * Math.cos((midLat * Math.PI) / 180);
  return Math.abs(latKm * lngKm);
}

export async function bboxPopulation(
  bbox: { south: number; west: number; north: number; east: number },
): Promise<PopulationResult | null> {
  const geojson = JSON.stringify({
    type: "Polygon",
    coordinates: [[
      [bbox.west, bbox.south],
      [bbox.east, bbox.south],
      [bbox.east, bbox.north],
      [bbox.west, bbox.north],
      [bbox.west, bbox.south],
    ]],
  });

  try {
    // 1) Submit the job → taskid
    const submit = await axios.get(STATS_URL, {
      params: { dataset: DATASET, year: YEAR, geojson },
      timeout: 15_000,
    });
    const taskId = submit.data?.taskid;
    if (!taskId) return null;

    // 2) Poll until finished (typically ~2-4s). Cap at ~12s so we never block
    //    the whole analysis on a slow population lookup.
    for (let i = 0; i < 8; i++) {
      await new Promise(r => setTimeout(r, 1500));
      const poll = await axios.get(`${TASK_URL}${taskId}`, { timeout: 10_000 });
      const d = poll.data;
      if (d?.status === "finished") {
        if (d.error || !d.data?.total_population) return null;
        const totalPopulation = Math.round(d.data.total_population);
        const areaKm2 = bboxAreaKm2(bbox);
        return {
          totalPopulation,
          areaKm2: Math.round(areaKm2 * 10) / 10,
          densityPerKm2: areaKm2 > 0 ? Math.round(totalPopulation / areaKm2) : 0,
          year: YEAR,
        };
      }
    }
    return null;
  } catch (e) {
    console.error("worldpop failed:", (e as Error).message);
    return null;
  }
}

// Map population density to a 0..100 demand contribution. Indian urban density
// runs from ~2-3k/km² (sparse suburb) to 30k+/km² (dense core). Log-scaled so it
// doesn't saturate, centred so ~8k/km² reads as "average".
export function densityToDemand(densityPerKm2: number): number {
  if (densityPerKm2 <= 0) return 0;
  const v = (Math.log10(densityPerKm2) - 3.0) * 55; // ~1k→0, ~8k→~50, ~30k→~80
  return Math.max(0, Math.min(100, Math.round(v)));
}
