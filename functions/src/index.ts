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
import { runGrowthAgent } from "./agent";
import { getRealEstateSignals } from "./realestate";
import { scoreHexes, topRecommendations } from "./scoring";
import { parseFile, suggestColumnMapping, applyMapping } from "./importLocations";
import { wikiContext } from "./wikipedia";
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

    const company = companyId ? getCompany(companyId) : undefined;
    const placeType = VERTICAL_PLACES_TYPE[vertical];

    send("progress", { step: "competitors", label: `🔴 Pulling ${placeType} POIs from Google Places…` });
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
    const contextBrief = areaContextBrief(vertical, contextPois);

    const [competitors, ownBrand, osmBackdrop, wiki, pinData, realEstate, agent] = await Promise.allSettled([
      competitorsInArea({ category: placeType, centerLat: geo.lat, centerLng: geo.lng, radiusM: 4000 })
        .then(r => { send("progress", { step: "competitors", label: `🔴 ${r.length} competitor POIs found`, done: true }); return r; }),
      (company
        ? brandLocationsInArea({ brandKeywords: company.placesKeywords, centerLat: geo.lat, centerLng: geo.lng, radiusM: 4000 })
        : Promise.resolve([])
      ).then(r => { send("progress", { step: "own", label: `🟢 ${r.length} of your sites identified`, done: true }); return r; }),
      osmPois({ vertical, ...geo.bbox }).catch(() => []),
      wikiContext(geo.area, geo.city)
        .then(r => { send("progress", { step: "wiki", label: r ? `📖 ${r.title}` : "📖 (no Wikipedia entry)", done: true }); return r; })
        .catch(() => null),
      geo.pin ? pinInfo(geo.pin).catch(() => null) : Promise.resolve(null),
      getRealEstateSignals({ city: geo.city, area: geo.area })
        .then(r => { send("progress", { step: "realestate", label: `🏠 ${r.sampleSize} listings, ${r.listings?.length ?? 0} sampled`, done: true }); return r; }),
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
    });
    const recs = topRecommendations(hexes, 5);
    send("progress", { step: "score", label: `📊 Scored ${hexes.length} hexes, picked top ${recs.length}`, done: true });

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
      agent: {
        trailId,
        growthScore: agentResult.growthScore,
        reasoning: agentResult.reasoning,
        executive: agentResult.executive,
        quadrantScores: agentResult.quadrantScores,
        trail: agentResult.trail,
      },
      hexes, recommendations: recs,
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
    const contextBrief = areaContextBrief(vertical, contextPois);

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

export const api = onRequest(
  {
    secrets: [APIFY_TOKEN, GOOGLE_MAPS_SERVER_KEY, GOOGLE_MAPS_BROWSER_KEY],
    cors: true,
    invoker: "public",
  },
  app,
);
