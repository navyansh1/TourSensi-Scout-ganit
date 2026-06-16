// Satellite-derived surface-water & flood-occurrence signal.
//
// Source: JRC Global Surface Water (occurrence), published as public PNG tiles:
//   https://storage.googleapis.com/global-surface-water/tiles2021/occurrence/{z}/{x}/{y}.png
//
// Why this and not OSM: OSM water is crowd-sourced and patchy in rural India —
// it misses seasonal rivers (e.g. the Cheyyar is tagged only as a centerline,
// not a polygon, so our Overpass check never saw it). JRC is derived from 30+
// years of actual satellite imagery, so it knows where water has *ever* been,
// regardless of whether a human mapped it. That makes it ground-truth for both
// (a) excluding water hexes from the heatmap and (b) a real flood-exposure
// signal for the Collateral Check.
//
// Tile encoding: occurrence is rendered on a red→blue ramp. ANY non-transparent
// pixel means water was observed there at least once (occurrence > 0); a
// blue-dominant pixel means near-permanent water, red means occasional/seasonal
// (flood-prone). Fully transparent = never water (dry land). No auth required.

import axios from "axios";
import { PNG } from "pngjs";

const TILE_BASE = "https://storage.googleapis.com/global-surface-water/tiles2021/occurrence";
const TILE_SIZE = 256;

export interface WaterPoint {
  isWater: boolean;        // occurrence > 0 (water observed at least once)
  occurrence: number;      // 0..100 rough estimate of how often it's wet
  permanence: "permanent" | "seasonal" | "occasional" | "dry";
}

const DRY: WaterPoint = { isWater: false, occurrence: 0, permanence: "dry" };

function lngLatToTile(lat: number, lng: number, z: number) {
  const n = 2 ** z;
  const x = Math.floor(((lng + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  );
  // Sub-tile pixel offset.
  const fx = ((lng + 180) / 360) * n - x;
  const fy = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n - y;
  return { x, y, px: Math.min(TILE_SIZE - 1, Math.floor(fx * TILE_SIZE)), py: Math.min(TILE_SIZE - 1, Math.floor(fy * TILE_SIZE)) };
}

// Simple per-process tile cache (a single bbox reuses the same few tiles for all
// its hexes, so this avoids re-downloading the same PNG dozens of times).
const tileCache = new Map<string, PNG | null>();

async function fetchTile(z: number, x: number, y: number): Promise<PNG | null> {
  const key = `${z}/${x}/${y}`;
  if (tileCache.has(key)) return tileCache.get(key) ?? null;
  try {
    const resp = await axios.get(`${TILE_BASE}/${z}/${x}/${y}.png`, {
      responseType: "arraybuffer", timeout: 12_000,
    });
    const png = PNG.sync.read(Buffer.from(resp.data));
    tileCache.set(key, png);
    return png;
  } catch {
    tileCache.set(key, null);  // 404 = no tile = treat as dry (JRC omits empty tiles)
    return null;
  }
}

function classify(r: number, g: number, b: number, a: number): WaterPoint {
  if (a < 40) return DRY;                         // transparent → never water
  // Red→blue ramp: blue-dominant = permanent, red-dominant = occasional.
  if (b > r + 30) return { isWater: true, occurrence: 90, permanence: "permanent" };
  if (b > r - 20) return { isWater: true, occurrence: 55, permanence: "seasonal" };
  return { isWater: true, occurrence: 25, permanence: "occasional" };
}

// Water reading at a single point. Samples the exact pixel plus its 4 neighbours
// (≈ a few tens of metres at z14) so a thin river clipping near the point still
// registers, without an extra tile fetch.
export async function waterAt(lat: number, lng: number, z = 14): Promise<WaterPoint> {
  const { x, y, px, py } = lngLatToTile(lat, lng, z);
  const png = await fetchTile(z, x, y);
  if (!png) return DRY;
  const read = (cx: number, cy: number): WaterPoint => {
    if (cx < 0 || cy < 0 || cx >= TILE_SIZE || cy >= TILE_SIZE) return DRY;
    const idx = (cy * TILE_SIZE + cx) * 4;
    return classify(png.data[idx], png.data[idx + 1], png.data[idx + 2], png.data[idx + 3]);
  };
  const samples = [read(px, py), read(px - 1, py), read(px + 1, py), read(px, py - 1), read(px, py + 1)];
  // Strongest water reading among the samples wins.
  const order = { permanent: 3, seasonal: 2, occasional: 1, dry: 0 } as const;
  return samples.reduce((best, s) => (order[s.permanence] > order[best.permanence] ? s : best), DRY);
}

// Batch water classification for hex centres — returns the set of hexes whose
// centre (or near-edge) reads as water at JRC occurrence > 0.
export async function jrcWaterHexes(
  centers: { hex: string; lat: number; lng: number }[],
  z = 13,
): Promise<Set<string>> {
  const flagged = new Set<string>();
  // Sequential-ish with light concurrency; tiles cache across centres.
  await Promise.all(centers.map(async (c) => {
    const w = await waterAt(c.lat, c.lng, z);
    if (w.isWater && w.permanence !== "occasional") flagged.add(c.hex);  // exclude permanent+seasonal water
  }));
  return flagged;
}

// Human-readable flood read for the Collateral Check, from a point sample.
export function floodNarrative(w: WaterPoint, distanceToWaterM?: number): { level: "HIGH" | "MODERATE" | "LOW"; note: string } {
  if (w.permanence === "permanent") return { level: "HIGH", note: "Sits on permanent surface water (satellite-confirmed) — not buildable collateral." };
  if (w.permanence === "seasonal") return { level: "HIGH", note: "Within seasonal surface-water extent (JRC, 30-yr) — flood-prone; flood cover advised." };
  if (w.permanence === "occasional") return { level: "MODERATE", note: "Occasional surface water observed nearby over 30 years — some flood exposure." };
  if (typeof distanceToWaterM === "number" && distanceToWaterM < 200) return { level: "MODERATE", note: `~${Math.round(distanceToWaterM)} m from observed surface water — check local drainage.` };
  return { level: "LOW", note: "No significant surface-water history at this point (JRC, 30-yr)." };
}
