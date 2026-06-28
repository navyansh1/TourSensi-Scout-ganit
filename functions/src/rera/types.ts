// Shared shape for a RERA project across all states. Each state portal has its
// own layout, so every state gets an "adapter" that maps its raw rows onto this
// common type. Adding a state = adding one adapter file + registering it.

export interface ReraProject {
  state: string;            // "TN" | "MH" | "KA" | "RJ" | "TG" | ...
  regNo: string;            // RERA registration number (unique-ish per state)
  projectName: string;
  promoter: string;
  units: number | null;     // dwelling-unit count (the lead-size driver)
  floors?: string;
  district?: string;
  locality?: string;        // best free-text locality we can extract
  address?: string;         // fuller address for geocoding when locality is thin
  lat?: number;             // only some portals (e.g. MahaRERA map) give this
  lng?: number;
  completion?: string;      // completion date or status text
  status?: string;
  registeredOn?: number;    // RERA registration date (ms epoch) for freshness sort
  fetchedAt: number;
}

// An adapter knows how to pull projects for one state.
// - "static" adapters fetch over plain HTTP and run live on request (fast).
// - "dynamic" adapters need a headless browser, so they run as a scheduled
//   batch job that writes into the Firestore cache; the live request reads cache.
export interface ReraAdapter {
  state: string;            // short code, e.g. "TN"
  name: string;             // human label, e.g. "Tamil Nadu"
  kind: "static" | "dynamic";
  // Pull projects. For static adapters this is called live; for dynamic ones it
  // is called by the batch job. `district` lets us scope the pull where the
  // portal supports it (keeps static pulls small).
  fetchProjects(opts?: { district?: string }): Promise<ReraProject[]>;
}
