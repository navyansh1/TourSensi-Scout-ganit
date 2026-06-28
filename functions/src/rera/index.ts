// RERA project access layer used by the Lead Radar pipeline.
//
// Two paths, by state portal type:
//  - STATIC states (currently only TN): scraped live over HTTP, fast.
//  - DYNAMIC states (MH, KA, TG, RJ): their portals need a headless browser, so a
//    separate batch job (scripts/reraBatch.ts, run on a weekly schedule) scrapes
//    them with Playwright and writes rows into Firestore (collection: rera_cache,
//    doc per state). Here we just READ that cache — instant, no browser at runtime.
//
// RERA data changes slowly (a few new projects per area per week), so a weekly
// cache refresh is plenty fresh and keeps the morning lead feed sub-second.

import * as admin from "firebase-admin";
import type { ReraAdapter, ReraProject } from "./types";
// Static adapters run live. All current states are cached via the batch job
// (incl. TN, whose plain-fetch logic the batch reuses) so the UI serves them
// uniformly from Firestore — fast and consistent.
const STATIC_ADAPTERS: Record<string, ReraAdapter> = {};

export const DYNAMIC_STATES: Record<string, string> = {
  TN: "Tamil Nadu",
  MH: "Maharashtra",
  KA: "Karnataka",
  RJ: "Rajasthan",
  HR: "Haryana (Gurugram)",
};

export const ALL_STATES: Record<string, string> = {
  ...DYNAMIC_STATES,
};

interface CacheMeta {
  state: string;
  shardCount: number;
  total: number;
  refreshedAt: number;
}

// The batch job shards each state across rera_cache/<STATE>__shard_<n> docs
// (Firestore's 1 MB/doc limit) with a meta doc at rera_cache/<STATE>. We read the
// meta, then fetch + concatenate the shards.
async function readCache(state: string): Promise<ReraProject[]> {
  const col = admin.firestore().collection("rera_cache");
  const meta = await col.doc(state).get();
  if (!meta.exists) return [];
  const { shardCount = 0 } = meta.data() as CacheMeta;
  if (!shardCount) return [];
  const shards = await Promise.all(
    Array.from({ length: shardCount }, (_, i) => col.doc(`${state}__shard_${i}`).get()),
  );
  return shards.flatMap((s) => (s.exists ? ((s.data() as { projects: ReraProject[] }).projects ?? []) : []));
}

// Get projects for a state. Static -> live scrape; dynamic -> Firestore cache.
export async function getReraProjects(state: string): Promise<ReraProject[]> {
  const code = state.toUpperCase();
  if (STATIC_ADAPTERS[code]) {
    return STATIC_ADAPTERS[code].fetchProjects().catch(() => readCache(code));
  }
  if (DYNAMIC_STATES[code]) return readCache(code);
  return [];
}

// When was a state's data last refreshed (null for live/static)?
export async function getReraAsOf(state: string): Promise<number | null> {
  const code = state.toUpperCase();
  if (STATIC_ADAPTERS[code]) return null; // live
  const snap = await admin.firestore().collection("rera_cache").doc(code).get();
  return snap.exists ? (snap.data() as CacheMeta).refreshedAt ?? null : null;
}

export type { ReraProject } from "./types";
