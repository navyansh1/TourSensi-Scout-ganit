// Main HTTP API exposed as a single Firebase HTTPS function called "api".
// Endpoints:
//   GET  /api/config              → returns browser-safe Google Maps key
//   GET  /api/companies           → list of selectable companies per vertical
//   POST /api/analyze             → main endpoint: location + vertical + company → scored hexes + agent trail
//   POST /api/import              → upload my-locations file → AI maps columns → returns mapped rows
//   GET  /api/agent-trail/:id     → fetch a saved agent trail by id

import { onRequest } from "firebase-functions/v2/https";
import { setGlobalOptions } from "firebase-functions/v2";
import { defineSecret } from "firebase-functions/params";
import * as admin from "firebase-admin";
import express from "express";
import cors from "cors";

import { geocodeIndia } from "./geocode";
import { COMPANIES, getCompany, VERTICAL_PLACES_TYPE, type Vertical } from "./companies";
import { competitorsInArea, brandLocationsInArea } from "./places";
import { osmPois } from "./osm";
import { fetchContextPois, areaContextBrief } from "./context";
import { bboxPopulation, densityToDemand } from "./worldpop";
import { runGrowthAgent } from "./agent";
import { getRealEstateSignals } from "./realestate";
import { scoreHexes, topRecommendations, placeQuality } from "./scoring";
import { parseFile, suggestColumnMapping, applyMapping } from "./importLocations";
// Wikipedia context is currently disabled (see analyze-stream). Kept for re-enable.
// import { wikiContext } from "./wikipedia";
import { pinInfo } from "./census";
import { getZoneInsight, type ZoneFacts } from "./zoneInsight";

admin.initializeApp();

// Vertex AI uses Application Default Credentials in Cloud Functions — no key needed.
const APIFY_TOKEN = defineSecret("APIFY_TOKEN");
const GOOGLE_MAPS_SERVER_KEY = defineSecret("GOOGLE_MAPS_SERVER_KEY");
const GOOGLE_MAPS_BROWSER_KEY = defineSecret("GOOGLE_MAPS_BROWSER_KEY");

setGlobalOptions({ region: "asia-south1", memory: "1GiB", timeoutSeconds: 540 });

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "10mb" }));
app.use(express.raw({ type: "application/octet-stream", limit: "10mb" }));

// Hosting rewrites preserve the full path "/api/...", but direct Cloud Run
// calls use "/config". Mount routes on both so both work.
const router = express.Router();
app.use("/", router);
app.use("/api", router);

router.get("/config", (_req, res) => {
  // The frontend uses runUrl for /analyze (which can take >60s and trip Hosting's edge timeout)
  // and the regular relative URL for short, snappy endpoints.
  res.json({
    mapsBrowserKey: process.env.GOOGLE_MAPS_BROWSER_KEY ?? "",
    runUrl: "https://api-bvb33x56gq-el.a.run.app",
  });
});

router.get("/companies", (_req, res) => {
  res.json({ companies: COMPANIES });
});

// Streaming variant — Server-Sent Events. Same body as /analyze, but pushes
// progress events as each pipeline stage completes. Final event is `result`.
router.post("/analyze-stream", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const send = (event: string, data: any) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const { location, vertical, companyId } = req.body as { location: string; vertical: Vertical; companyId?: string };
    if (!location || !vertical) { send("error", { message: "location and vertical are required" }); res.end(); return; }

    send("progress", { step: "geocode", label: "Geocoding location…" });
    const geo = await geocodeIndia(location);
    if (!geo) { send("error", { message: "Could not geocode" }); res.end(); return; }
    send("progress", { step: "geocode", label: `📍 Found ${geo.formattedAddress}`, done: true });
    if (geo.broad) send("notice", { kind: "broad-location", area: geo.area || geo.city });

    const company = companyId ? getCompany(companyId) : undefined;
    const placeType = VERTICAL_PLACES_TYPE[vertical];

    send("progress", { step: "competitors", label: `🔴 Finding nearby ${placeType} locations…` });
    send("progress", { step: "own", label: company ? `🟢 Finding your ${company.name} sites…` : "🟢 (skipped, no company selected)" });
    send("progress", { step: "overlay", label: "🗺️ Mapping nearby metro/roads/anchors (Google Maps)…" });
    send("progress", { step: "wiki", label: "📖 Fetching Wikipedia geo-context…" });
    send("progress", { step: "realestate", label: "🏠 Scraping 99acres for property listings (15-30s)…" });
    send("progress", { step: "agent", label: "🤖 AI agent: 8 grounded searches + 4 quadrant micro-runs…" });

    // Fetch the vertical-specific nearby context FIRST (one fast Places fan-out)
    // so the AI agent can reference what's physically around the site.
    const contextPois = await fetchContextPois({
      vertical, centerLat: geo.lat, centerLng: geo.lng, radiusM: 4000,
    }).catch(() => []);
    send("progress", { step: "overlay", label: `🗺️ ${contextPois.length} nearby context POIs mapped`, done: true });
    const contextBrief = areaContextBrief(vertical, contextPois, { lat: geo.lat, lng: geo.lng });

    const [competitors, ownBrand, osmBackdrop, wiki, pinData, realEstate, population, agent] = await Promise.allSettled([
      competitorsInArea({ category: placeType, centerLat: geo.lat, centerLng: geo.lng, radiusM: 4000 })
        .then(r => { send("progress", { step: "competitors", label: `🔴 ${r.length} competitor POIs found`, done: true }); return r; }),
      (company
        ? brandLocationsInArea({ brandKeywords: company.placesKeywords, centerLat: geo.lat, centerLng: geo.lng, radiusM: 4000 })
        : Promise.resolve([])
      ).then(r => { send("progress", { step: "own", label: `🟢 ${r.length} of your sites identified`, done: true }); return r; }),
      osmPois({ vertical, ...geo.bbox }).catch(() => []),
      // Wikipedia context disabled (kept for easy re-enable):
      // wikiContext(geo.area, geo.city)
      //   .then(r => { send("progress", { step: "wiki", label: r ? `📖 ${r.title}` : "📖 (no Wikipedia entry)", done: true }); return r; })
      //   .catch(() => null),
      Promise.resolve(null),
      geo.pin ? pinInfo(geo.pin).catch(() => null) : Promise.resolve(null),
      getRealEstateSignals({ city: geo.city, area: geo.area })
        .then(r => { send("progress", { step: "realestate", label: `🏠 ${r.sampleSize} listings, ${r.listings?.length ?? 0} sampled`, done: true }); return r; }),
      bboxPopulation(geo.bbox).catch(() => null),
      runGrowthAgent({ area: geo.area, city: geo.city, contextBrief })
        .then(r => { send("progress", { step: "agent", label: `🤖 Growth ${r.growthScore}/100 · ${r.trail.length} searches · 4 quadrants`, done: true }); return r; }),
    ]);

    const competitorsList = competitors.status === "fulfilled" ? competitors.value : [];
    const ownList = ownBrand.status === "fulfilled" ? ownBrand.value : [];
    const osmList = osmBackdrop.status === "fulfilled" ? osmBackdrop.value : [];
    const overlayList = contextPois;
    const wikiInfo = wiki.status === "fulfilled" ? wiki.value : null;
    const pinInfoData = pinData.status === "fulfilled" ? pinData.value : null;
    const reSignals = realEstate.status === "fulfilled" ? realEstate.value : null;
    const popData = population.status === "fulfilled" ? population.value : null;
    const fallbackAgent = {
      area: geo.area, city: geo.city, growthScore: 50,
      reasoning: "(agent unavailable)", trail: [] as any[],
      executive: { rating: 3, recommendation: "CAUTION" as const, drivers: [], risks: [], bottomLine: "Agent unavailable." },
      quadrantScores: [
        { quadrant: "NE" as const, growthScore: 50, headline: "" },
        { quadrant: "NW" as const, growthScore: 50, headline: "" },
        { quadrant: "SE" as const, growthScore: 50, headline: "" },
        { quadrant: "SW" as const, growthScore: 50, headline: "" },
      ],
    };
    const agentResult: any = agent.status === "fulfilled" ? agent.value : fallbackAgent;

    send("progress", { step: "score", label: "📊 Scoring hexes…" });
    const hexes = scoreHexes({
      vertical, bbox: geo.bbox,
      center: { lat: geo.lat, lng: geo.lng },
      competitors: competitorsList, ownBrand: ownList, osmBackdrop: osmList,
      contextPois,
      realEstate: reSignals, growthScore: agentResult.growthScore,
      quadrantScores: agentResult.quadrantScores,
      populationDemand: popData ? densityToDemand(popData.densityPerKm2) : null,
    });
    const recs = topRecommendations(hexes, 5);
    send("progress", { step: "score", label: `📊 Scored ${hexes.length} hexes, picked top ${recs.length}`, done: true });

    // Honesty pass: don't let the exec summary be a cheerleader. If the searched
    // area is saturated or simply weak, downgrade the recommendation and state
    // the market reality plainly. (The agent runs in parallel so it may not have
    // seen the final counts — this enforces it deterministically.)
    applyHonesty(agentResult, {
      vertical, area: geo.area,
      competitorCount: competitorsList.length,
      ownCount: ownList.length,
      hexes,
    });

    const trailId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await admin.firestore().collection("agent_trails").doc(trailId).set({
      area: agentResult.area, city: agentResult.city,
      growthScore: agentResult.growthScore, reasoning: agentResult.reasoning,
      trail: agentResult.trail, createdAt: Date.now(),
    });

    send("result", {
      geo, vertical, company: company ?? null,
      counts: { competitors: competitorsList.length, ownBrand: ownList.length, osmBackdrop: osmList.length, overlay: overlayList.length },
      realEstate: reSignals,
      propertyListings: reSignals?.listings ?? [],
      overlay: overlayList,
      wiki: wikiInfo,
      pin: pinInfoData,
      population: popData,
      agent: {
        trailId,
        growthScore: agentResult.growthScore,
        reasoning: agentResult.reasoning,
        executive: agentResult.executive,
        quadrantScores: agentResult.quadrantScores,
        trail: agentResult.trail,
      },
      hexes, recommendations: recs,
      placeQuality: placeQuality(competitorsList),
      competitorsList, ownList,
    });
    res.end();
  } catch (e) {
    console.error("analyze-stream failed:", e);
    send("error", { message: String((e as Error).message) });
    res.end();
  }
});

// Main analyze pipeline.
// Body: { location: "Anna Nagar Chennai", vertical: "BFSI_ATM", companyId: "hdfc" }
router.post("/analyze", async (req, res) => {
  try {
    const { location, vertical, companyId } = req.body as {
      location: string;
      vertical: Vertical;
      companyId?: string;
    };

    if (!location || !vertical) {
      res.status(400).json({ error: "location and vertical are required" });
      return;
    }

    const geo = await geocodeIndia(location);
    if (!geo) {
      res.status(404).json({ error: "Could not geocode that location" });
      return;
    }

    const company = companyId ? getCompany(companyId) : undefined;
    const placeType = VERTICAL_PLACES_TYPE[vertical];

    // Nearby vertical-specific context first, so the agent can use the brief.
    const contextPois = await fetchContextPois({
      vertical, centerLat: geo.lat, centerLng: geo.lng, radiusM: 4000,
    }).catch(() => []);
    const contextBrief = areaContextBrief(vertical, contextPois, { lat: geo.lat, lng: geo.lng });

    // Fan out: competitors, our brand, OSM, real estate, and the agent — all in parallel.
    const [competitors, ownBrand, osmBackdrop, realEstate, agent] = await Promise.allSettled([
      competitorsInArea({ category: placeType, centerLat: geo.lat, centerLng: geo.lng, radiusM: 4000 }),
      company
        ? brandLocationsInArea({ brandKeywords: company.placesKeywords, centerLat: geo.lat, centerLng: geo.lng, radiusM: 4000 })
        : Promise.resolve([]),
      osmPois({ vertical, ...geo.bbox }),
      getRealEstateSignals({ city: geo.city, area: geo.area }),
      runGrowthAgent({ area: geo.area, city: geo.city, contextBrief }),
    ]);

    const competitorsList = competitors.status === "fulfilled" ? competitors.value : [];
    const ownList = ownBrand.status === "fulfilled" ? ownBrand.value : [];
    const osmList = osmBackdrop.status === "fulfilled" ? osmBackdrop.value : [];
    const reSignals = realEstate.status === "fulfilled" ? realEstate.value : null;
    const agentResult: any = agent.status === "fulfilled" ? agent.value : {
      area: geo.area, city: geo.city, growthScore: 50,
      reasoning: "(agent unavailable)", trail: [],
      executive: { rating: 3, recommendation: "CAUTION", drivers: [], risks: [], bottomLine: "Agent unavailable." },
      quadrantScores: [
        { quadrant: "NE", growthScore: 50, headline: "" },
        { quadrant: "NW", growthScore: 50, headline: "" },
        { quadrant: "SE", growthScore: 50, headline: "" },
        { quadrant: "SW", growthScore: 50, headline: "" },
      ],
    };

    const hexes = scoreHexes({
      vertical,
      bbox: geo.bbox,
      center: { lat: geo.lat, lng: geo.lng },
      competitors: competitorsList,
      ownBrand: ownList,
      osmBackdrop: osmList,
      contextPois,
      realEstate: reSignals,
      growthScore: agentResult.growthScore,
      quadrantScores: agentResult.quadrantScores,
    });

    const recs = topRecommendations(hexes, 5);

    // Save the agent trail for later retrieval (so /api/agent-trail can fetch it)
    const trailId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await admin.firestore().collection("agent_trails").doc(trailId).set({
      area: agentResult.area,
      city: agentResult.city,
      growthScore: agentResult.growthScore,
      reasoning: agentResult.reasoning,
      trail: agentResult.trail,
      createdAt: Date.now(),
    });

    res.json({
      geo,
      vertical,
      company: company ?? null,
      counts: {
        competitors: competitorsList.length,
        ownBrand: ownList.length,
        osmBackdrop: osmList.length,
        overlay: contextPois.length,
      },
      realEstate: reSignals,
      propertyListings: reSignals?.listings ?? [],
      overlay: contextPois,
      agent: { trailId, growthScore: agentResult.growthScore, reasoning: agentResult.reasoning, trail: agentResult.trail },
      hexes,
      recommendations: recs,
      competitorsList,
      ownList,
    });
  } catch (e) {
    console.error("analyze failed:", e);
    res.status(500).json({ error: String((e as Error).message) });
  }
});

// File upload: send raw bytes as application/octet-stream with ?name=... query.
router.post("/import", async (req, res) => {
  try {
    const filename = String(req.query.name ?? "upload.csv");
    const buf: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));
    const parsed = parseFile(buf, filename);
    const mapping = await suggestColumnMapping(parsed.headers, parsed.rows);
    const mapped = applyMapping(parsed.rows, mapping as any);
    res.json({ headers: parsed.headers, mapping, count: mapped.length, locations: mapped.slice(0, 500) });
  } catch (e) {
    console.error("import failed:", e);
    res.status(500).json({ error: String((e as Error).message) });
  }
});

// On-demand per-zone AI insight. The frontend posts a clicked hex's facts and
// gets back a decisive, fact-backed verdict. Cached in Firestore per zone.
router.post("/zone-insight", async (req, res) => {
  try {
    const facts = req.body as ZoneFacts;
    if (!facts || typeof facts.lat !== "number" || typeof facts.lng !== "number" || !facts.vertical) {
      res.status(400).json({ error: "lat, lng and vertical are required" });
      return;
    }
    const insight = await getZoneInsight(facts);
    res.json(insight);
  } catch (e) {
    console.error("zone-insight failed:", e);
    res.status(500).json({ error: String((e as Error).message) });
  }
});

router.get("/agent-trail/:id", async (req, res) => {
  const snap = await admin.firestore().collection("agent_trails").doc(req.params.id).get();
  if (!snap.exists) { res.status(404).json({ error: "not found" }); return; }
  res.json(snap.data());
});

// Deterministic honesty pass over the executive summary. Ensures the blue
// sidebar card never forces an optimistic verdict on a saturated or weak area,
// and surfaces the plain market reality.
function applyHonesty(
  agentResult: any,
  ctx: { vertical: Vertical; area: string; competitorCount: number; ownCount: number; hexes: { final: number }[] },
) {
  const ex = agentResult.executive;
  if (!ex) return;

  const finals = ctx.hexes.map(h => h.final);
  const bestFinal = finals.length ? Math.max(...finals) : 0;
  const avgFinal = finals.length ? Math.round(finals.reduce((a, b) => a + b, 0) / finals.length) : 0;

  const VERTICAL_NOUN: Record<string, string> = {
    BFSI_ATM: "ATMs", BFSI_BRANCH: "bank branches",
    FMCG_RETAIL: "stores", FMCG_WAREHOUSE: "warehouses/dark stores",
  };
  const noun = VERTICAL_NOUN[ctx.vertical] ?? "sites";

  // Saturation: lots of competitors and/or the company already operates several
  // sites here, while there's little headroom (best zone not strong).
  const saturated = (ctx.competitorCount >= 12 || ctx.ownCount >= 4) && bestFinal < 68;
  const weak = bestFinal < 50;

  if (!ex.marketState) {
    const parts: string[] = [];
    if (ctx.competitorCount > 0) parts.push(`${ctx.competitorCount} competing ${noun} already here`);
    if (ctx.ownCount > 0) parts.push(`you already run ${ctx.ownCount}`);
    parts.push(`best zone scores ${bestFinal}/100`);
    ex.marketState = `${ctx.area}: ${parts.join(", ")}.`;
  }

  if (weak) {
    ex.recommendation = "AVOID";
    ex.rating = Math.min(ex.rating ?? 2, 2);
    if (!/avoid|elsewhere|other/i.test(ex.bottomLine || "")) {
      ex.bottomLine = `This area is a weak bet (best zone only ${bestFinal}/100). ${ex.alternatives?.length ? "Consider the alternatives below instead." : "Look at adjacent micro-markets before committing."}`;
    }
  } else if (saturated && ex.recommendation === "GO") {
    ex.recommendation = "CAUTION";
    ex.rating = Math.min(ex.rating ?? 3, 3);
  }
}

export const api = onRequest(
  {
    secrets: [APIFY_TOKEN, GOOGLE_MAPS_SERVER_KEY, GOOGLE_MAPS_BROWSER_KEY],
    cors: true,
    invoker: "public",
  },
  app,
);
