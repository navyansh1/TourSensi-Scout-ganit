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
import { COMPANIES, getCompany, VERTICAL_PLACES_TYPE, VERTICAL_WEIGHTS, VERTICAL_ECONOMICS, type Vertical } from "./companies";
import { competitorsInArea, brandLocationsInArea, noBuildPlacesHexes } from "./places";
import { osmPois } from "./osm";
import { fetchContextPois, areaContextBrief } from "./context";
import { bboxPopulation, densityToDemand } from "./worldpop";
import { bboxNightlights, trendToGrowthNudge } from "./nightlights";
import { runGrowthAgent, aiPropertyEstimate, aiSiteRevenue, aiIncomeContext, computePayback } from "./agent";
import { computeAffluence } from "./affluence";
import { planExpansion } from "./portfolio";
import { analyzeSite, type SiteAnalysisInput } from "./siteAnalysis";
import { analyzeLoanCollateral, type LoanAnalysisInput, type CollateralType } from "./loanAnalysis";
import { getRealEstateSignals } from "./realestate";
import { getLeadRadar } from "./leadRadar";
import { ALL_STATES } from "./rera";
import { scoreHexes, topRecommendations, placeQuality, hexCenters } from "./scoring";
import { waterCenters, centerKey } from "./water";
import { classifyLandUse } from "./landuse";
import { jrcWaterHexes } from "./flood";
import { parseFile, suggestColumnMapping, applyMapping } from "./importLocations";
// Wikipedia context is currently disabled (see analyze-stream). Kept for re-enable.
// import { wikiContext } from "./wikipedia";
import { pinInfo } from "./census";
import { getZoneInsight, type ZoneFacts } from "./zoneInsight";

admin.initializeApp();
// Tolerate undefined fields when writing cached payloads (review text, ratings,
// etc. are often missing) — otherwise Firestore rejects the whole document.
admin.firestore().settings({ ignoreUndefinedProperties: true });

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

    send("progress", { step: "income", label: "💰 Reading area affluence signals…" });
    const [competitors, ownBrand, osmBackdrop, wiki, pinData, realEstate, population, nightlights, income, agent] = await Promise.allSettled([
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
      // Night-time lights (VIIRS) — area-level economic vitality + 3-yr brightening
      // trend. Fresh (monthly), free, fails open. Feeds the growth signal.
      bboxNightlights(geo.bbox)
        .then(r => { if (r) send("progress", { step: "nightlights", label: `🛰️ Nightlights vitality ${r.vitality}/100${r.trendDelta != null ? ` · ${r.trendDelta >= 0 ? "+" : ""}${r.trendDelta} 3-yr trend` : ""}`, done: true }); return r; })
        .catch(() => null),
      // Best-effort grounded income context (district/city-level), cached 14d.
      // Fails open to the deterministic Affluence Index below.
      cachedIncomeContext(geo.area, geo.city)
        .then(r => { send("progress", { step: "income", label: r ? `💰 Affluence read${r.band ? ` · ${r.band}` : ""}` : "💰 Affluence from local signals", done: true }); return r; })
        .catch(() => null),
      cachedGrowthAgent(geo.area, geo.city, contextBrief)
        .then(r => { send("progress", { step: "agent", label: `🤖 Growth ${r.growthScore}/100 · ${r.trail.length} searches · 4 quadrants`, done: true }); return r; }),
    ]);

    const competitorsList = competitors.status === "fulfilled" ? competitors.value : [];
    const ownList = ownBrand.status === "fulfilled" ? ownBrand.value : [];
    const osmList = osmBackdrop.status === "fulfilled" ? osmBackdrop.value : [];
    const overlayList = contextPois;
    const wikiInfo = wiki.status === "fulfilled" ? wiki.value : null;
    const pinInfoData = pinData.status === "fulfilled" ? pinData.value : null;
    let reSignals = realEstate.status === "fulfilled" ? realEstate.value : null;
    reSignals = await withAiPropertyFallback(reSignals, geo.area, geo.city);
    const popData = population.status === "fulfilled" ? population.value : null;
    const nightData = nightlights.status === "fulfilled" ? nightlights.value : null;
    const incomeData = income.status === "fulfilled" ? income.value : null;
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

    // Satellite growth nudge: tilt the AI growth prior by the 3-yr nightlight
    // brightening trend (capped ±10). Brightening areas read as rising; dimming
    // ones get pulled down. Applied to both the area score and each quadrant so
    // the heatmap reflects it. Bounded so the satellite reading can only tilt the
    // analyst-grade narrative, never override it.
    const growthNudge = trendToGrowthNudge(nightData?.trendDelta ?? null);
    if (growthNudge !== 0) {
      const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
      agentResult.growthScore = clamp(agentResult.growthScore + growthNudge);
      if (Array.isArray(agentResult.quadrantScores)) {
        agentResult.quadrantScores = agentResult.quadrantScores.map((q: any) => ({
          ...q, growthScore: clamp(q.growthScore + growthNudge),
        }));
      }
    }

    send("progress", { step: "score", label: "📊 Scoring hexes…" });
    const centers = hexCenters(geo.bbox);
    const [oceanSet, landUse, jrcWater, googleNoBuild] = await Promise.all([
      oceanHexes(geo.bbox, centers),
      classifyLandUse(geo.bbox, centers).catch(() => ({ waterHexes: new Set<string>(), noBuildHexes: new Set<string>() })),
      // Satellite surface-water (JRC) — catches seasonal rivers/lakes that OSM
      // misses in rural India (e.g. the Cheyyar). Fails open to empty.
      jrcWaterHexes(centers).catch(() => new Set<string>()),
      // Google Places no-build vote — catches airports/forests/military that OSM
      // may not tag. Universities & hospitals are intentionally NOT in this set
      // (their gates are prime sites). Fails open to empty.
      noBuildPlacesHexes({ centerLat: geo.lat, centerLng: geo.lng }).catch(() => new Set<string>()),
    ]);
    // Exclude (remove) = open ocean (elevation) + OSM water + JRC satellite water.
    // Penalise (floor to red, keep on map) = airport/forest/military, from OSM
    // and Google agreeing — genuinely dead land only.
    const excludeHexes = new Set<string>([...oceanSet, ...landUse.waterHexes, ...jrcWater]);
    const penalizeHexes = new Set<string>([...landUse.noBuildHexes, ...googleNoBuild]);
    const hexes = scoreHexes({
      vertical, bbox: geo.bbox,
      center: { lat: geo.lat, lng: geo.lng },
      competitors: competitorsList, ownBrand: ownList, osmBackdrop: osmList,
      contextPois,
      realEstate: reSignals, growthScore: agentResult.growthScore,
      quadrantScores: agentResult.quadrantScores,
      populationDemand: popData ? densityToDemand(popData.densityPerKm2) : null,
      excludeHexes, penalizeHexes,
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

    // Deterministic Affluence Index — free composite of property ₹/sqft +
    // venue price tier + satellite night-lights. Always computed; the grounded
    // income context above is an optional, clearly-scoped supplement.
    const affluence = computeAffluence({
      realEstate: reSignals,
      competitors: competitorsList,
      nightlights: nightData,
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
      nightlights: nightData,
      affluence,
      income: incomeData,
      agent: {
        trailId,
        growthScore: agentResult.growthScore,
        reasoning: agentResult.reasoning,
        executive: agentResult.executive,
        quadrantScores: agentResult.quadrantScores,
        trail: agentResult.trail,
      },
      hexes, recommendations: recs,
      weights: VERTICAL_WEIGHTS[vertical],
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
      cachedGrowthAgent(geo.area, geo.city, contextBrief),
    ]);

    const competitorsList = competitors.status === "fulfilled" ? competitors.value : [];
    const ownList = ownBrand.status === "fulfilled" ? ownBrand.value : [];
    const osmList = osmBackdrop.status === "fulfilled" ? osmBackdrop.value : [];
    let reSignals = realEstate.status === "fulfilled" ? realEstate.value : null;
    reSignals = await withAiPropertyFallback(reSignals, geo.area, geo.city);
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

    const centers = hexCenters(geo.bbox);
    const [oceanSet, landUse, jrcWater, googleNoBuild] = await Promise.all([
      oceanHexes(geo.bbox, centers),
      classifyLandUse(geo.bbox, centers).catch(() => ({ waterHexes: new Set<string>(), noBuildHexes: new Set<string>() })),
      jrcWaterHexes(centers).catch(() => new Set<string>()),
      noBuildPlacesHexes({ centerLat: geo.lat, centerLng: geo.lng }).catch(() => new Set<string>()),
    ]);
    const excludeHexes = new Set<string>([...oceanSet, ...landUse.waterHexes, ...jrcWater]);
    const penalizeHexes = new Set<string>([...landUse.noBuildHexes, ...googleNoBuild]);
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
      excludeHexes, penalizeHexes,
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
      weights: VERTICAL_WEIGHTS[vertical],
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

    // Geocode missing lat/lng coordinates by building a full address from all location components
    const needsGeocoding = mapped.filter(loc => loc.lat == null || loc.lng == null);
    // Limit to first 50 to avoid API rate limits/timeouts
    const toGeocode = needsGeocoding.slice(0, 50);

    const excludedCols = new Set<string>();
    if (mapping.name) excludedCols.add(mapping.name);
    if (mapping.branchId) excludedCols.add(mapping.branchId);
    if (mapping.type) excludedCols.add(mapping.type);
    if (mapping.lat) excludedCols.add(mapping.lat);
    if (mapping.lng) excludedCols.add(mapping.lng);

    const geocodePromises = toGeocode.map(async (loc) => {
      const addressParts: string[] = [];
      if (mapping.address && loc.raw[mapping.address]) {
        addressParts.push(String(loc.raw[mapping.address]));
      }
      for (const key of Object.keys(loc.raw)) {
        if (key !== mapping.address && !excludedCols.has(key) && loc.raw[key] != null) {
          const val = String(loc.raw[key]).trim();
          if (val && !addressParts.includes(val)) {
            addressParts.push(val);
          }
        }
      }
      const fullAddress = addressParts.length > 0 ? addressParts.join(", ") : `${loc.name}, Chennai, India`;
      try {
        const geo = await geocodeIndia(fullAddress);
        if (geo) {
          loc.lat = geo.lat;
          loc.lng = geo.lng;
          loc.address = geo.formattedAddress;
        }
      } catch (err) {
        console.error("Geocoding failed for imported location:", fullAddress, err);
      }
    });
    await Promise.all(geocodePromises);

    res.json({ headers: parsed.headers, mapping, count: mapped.length, locations: mapped.slice(0, 500) });
  } catch (e) {
    console.error("import failed:", e);
    res.status(500).json({ error: String((e as Error).message) });
  }
});

// Expansion Planner ("My Network") — fast batched scoring of an uploaded
// network of existing locations + a gap-finder for where to expand next.
// Body: { vertical, locations: [{ name, lat, lng, branchId?, type? }] }
router.post("/portfolio", async (req, res) => {
  try {
    const { vertical, locations } = req.body as {
      vertical: Vertical;
      locations: { name: string; lat: number; lng: number; branchId?: string; type?: string }[];
    };
    if (!vertical || !Array.isArray(locations) || locations.length === 0) {
      res.status(400).json({ error: "vertical and a non-empty locations array are required" });
      return;
    }
    const result = await planExpansion({ vertical, locations });
    res.json(result);
  } catch (e) {
    console.error("portfolio failed:", e);
    res.status(500).json({ error: String((e as Error).message) });
  }
});

// On-demand DEEP analysis for a single clicked site/gap (review text + multi-
// search grounded AI). Shown in the right-side panel. ~5-8s per click.
router.post("/site-analysis", async (req, res) => {
  try {
    const body = req.body as SiteAnalysisInput;
    if (!body || !body.vertical || typeof body.lat !== "number" || typeof body.lng !== "number") {
      res.status(400).json({ error: "vertical, lat and lng are required" });
      return;
    }
    // Cache 7 days — locality fundamentals don't shift hour to hour.
    const key = `${body.vertical}__${body.kind}__${coordKey(body.lat, body.lng)}`;
    const analysis = await withCache("site_analysis", key, 7 * 864e5, () => analyzeSite(body));
    res.json(analysis);
  } catch (e) {
    console.error("site-analysis failed:", e);
    res.status(500).json({ error: String((e as Error).message) });
  }
});

// Loan Assessor — geographic collateral analysis (ONE input, not a verdict).
// Body: { collateralType, location } OR { collateralType, lat, lng, address }
router.post("/loan-analysis", async (req, res) => {
  try {
    const { collateralType, location, lat, lng, address } = req.body as {
      collateralType: CollateralType; location?: string; lat?: number; lng?: number; address?: string;
    };
    if (!collateralType) { res.status(400).json({ error: "collateralType is required" }); return; }

    let plat = lat, plng = lng, paddr = address;
    if ((plat == null || plng == null) && location) {
      const geo = await geocodeIndia(location);
      if (!geo) { res.status(404).json({ error: "Could not locate that address" }); return; }
      plat = geo.lat; plng = geo.lng; paddr = geo.formattedAddress;
    }
    if (plat == null || plng == null) { res.status(400).json({ error: "location or lat/lng required" }); return; }

    const input: LoanAnalysisInput = { collateralType, lat: plat, lng: plng, address: paddr };
    const key = `${collateralType}__${coordKey(plat, plng)}`;
    const analysis = await withCache("loan_analysis", key, 7 * 864e5, () => analyzeLoanCollateral(input));
    res.json({ ...analysis, lat: plat, lng: plng, address: paddr });
  } catch (e) {
    console.error("loan-analysis failed:", e);
    res.status(500).json({ error: String((e as Error).message) });
  }
});

// Lead Radar — daily feed of new-construction loan opportunities near a branch.
// Body: { query, state, radiusKm? }   e.g. { query: "Anna Nagar East, Chennai", state: "TN" }
router.get("/lead-radar/states", (_req, res) => {
  res.json({ states: ALL_STATES });
});
router.post("/lead-radar", async (req, res) => {
  try {
    const { query, state, radiusKm } = req.body as { query?: string; state?: string; radiusKm?: number };
    if (!query || !state) { res.status(400).json({ error: "query and state are required" }); return; }
    // Cache per anchor+state+radius for a day — RERA + ₹/sqft both move slowly.
    // The v2 suffix busts stale cache after the geocode/₹ pipeline fixes.
    const key = `v2__${state}__${query}__${radiusKm ?? 5}`.toLowerCase().replace(/[^a-z0-9_]/g, "_");
    const result = await withCache("lead_radar", key, 864e5, () =>
      getLeadRadar({ query, state, radiusKm }));
    res.json(result);
  } catch (e) {
    console.error("lead-radar failed:", e);
    res.status(500).json({ error: String((e as Error).message) });
  }
});

// On-demand grounded ₹ revenue estimate for a single clicked site/gap.
// Body: { vertical, lat, lng, area?, competitorCount, footfallIndex }
router.post("/site-revenue", async (req, res) => {
  try {
    const { vertical, lat, lng, area, competitorCount, footfallIndex, monthlyRentINR, marginPct, setupCapex } = req.body as {
      vertical: Vertical; lat: number; lng: number; area?: string;
      competitorCount?: number; footfallIndex?: number;
      monthlyRentINR?: number;   // optional override (else derived/omitted)
      marginPct?: number;        // optional override of the default economics
      setupCapex?: number;       // optional override of the default economics
    };
    if (!vertical || typeof lat !== "number" || typeof lng !== "number") {
      res.status(400).json({ error: "vertical, lat and lng are required" });
      return;
    }
    const key = `${vertical}__${coordKey(lat, lng)}`;
    const est = await withCache("site_revenue", key, 7 * 864e5, () => aiSiteRevenue({
      vertical, lat, lng, area,
      competitorCount: competitorCount ?? 0,
      footfallIndex: footfallIndex ?? 50,
    }));
    if (!est) { res.json({ available: false }); return; }
    // Derive payback from the revenue midpoint + (editable) vertical economics.
    // Margin/capex are overridable per request so the UI can recompute when the
    // user edits the assumptions — no re-call to the AI.
    const econ = VERTICAL_ECONOMICS[vertical];
    const payback = computePayback({
      monthlyRevenueINR: est.monthlyRevenueMidINR ?? null,
      marginPct: typeof marginPct === "number" ? marginPct : econ.marginPct,
      setupCapex: typeof setupCapex === "number" ? setupCapex : econ.setupCapex,
      monthlyRentINR: typeof monthlyRentINR === "number" ? monthlyRentINR : null,
    });
    res.json({
      available: true, ...est, payback,
      economics: {
        marginPct: typeof marginPct === "number" ? marginPct : econ.marginPct,
        setupCapex: typeof setupCapex === "number" ? setupCapex : econ.setupCapex,
        label: econ.label,
      },
    });
  } catch (e) {
    console.error("site-revenue failed:", e);
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

// Generic Firestore-backed cache for expensive AI/Places results. Keyed by a
// caller-supplied string; rounded coordinates make nearby clicks share a cache
// entry. Best-effort: any cache error just means we recompute. Same pattern as
// zone_insights / realestate already used elsewhere.
async function withCache<T>(collection: string, key: string, ttlMs: number, compute: () => Promise<T>): Promise<T> {
  const safeKey = key.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 480);
  const ref = admin.firestore().collection(collection).doc(safeKey);
  try {
    const snap = await ref.get();
    if (snap.exists) {
      const d = snap.data() as any;
      if (d && d._cachedAt && Date.now() - d._cachedAt < ttlMs) return d.payload as T;
    }
  } catch { /* ignore — recompute */ }
  const payload = await compute();
  ref.set({ _cachedAt: Date.now(), payload }).catch(() => {});
  return payload;
}

// Round coords so clicks within ~100 m reuse the same cached analysis.
function coordKey(lat: number, lng: number) { return `${lat.toFixed(3)}_${lng.toFixed(3)}`; }

// Cache the expensive 12-call growth agent by locality (area+city). Same area
// searched again — by anyone — returns instantly instead of re-running Gemini.
// 3-day TTL so growth signals stay reasonably fresh.
function cachedGrowthAgent(area: string, city: string, contextBrief: string) {
  return withCache("growth_agent", `${area}__${city}`.toLowerCase(), 3 * 864e5,
    () => runGrowthAgent({ area, city, contextBrief }));
}

// Best-effort grounded income context, cached 14 days per locality (income data
// moves slowly and a grounded prompt is the only billed cost here, so cache hard).
function cachedIncomeContext(area: string, city: string) {
  return withCache("income_context", `${area}__${city}`.toLowerCase(), 14 * 864e5,
    () => aiIncomeContext(area, city));
}

router.get("/agent-trail/:id", async (req, res) => {
  const snap = await admin.firestore().collection("agent_trails").doc(req.params.id).get();
  if (!snap.exists) { res.status(404).json({ error: "not found" }); return; }
  res.json(snap.data());
});

// Share a result snapshot. Stores the full result blob the frontend already
// holds (lastResult) and returns a short id; the link "/?r=<id>" re-renders the
// exact same UI for anyone. Read-only snapshot — the viewer can fork it locally
// (re-analyse / tweak weights client-side) but doesn't mutate the original.
router.post("/share", async (req, res) => {
  try {
    const result = req.body?.result;
    const kind = typeof req.body?.kind === "string" ? req.body.kind : "site";
    if (!result || typeof result !== "object") { res.status(400).json({ error: "result is required" }); return; }
    const id = Math.random().toString(36).slice(2, 10);
    await admin.firestore().collection("shared_results").doc(id).set({
      result, kind, createdAt: Date.now(),
    });
    res.json({ id });
  } catch (e) {
    console.error("share save failed:", e);
    res.status(500).json({ error: String((e as Error).message) });
  }
});

router.get("/share/:id", async (req, res) => {
  const id = String(req.params.id).replace(/[^a-z0-9]/gi, "").slice(0, 16);
  const snap = await admin.firestore().collection("shared_results").doc(id).get();
  if (!snap.exists) { res.status(404).json({ error: "not found" }); return; }
  res.json(snap.data());
});

// Detect ocean/sea hexes in the bbox via the Elevation API and return the set
// of hex ids to exclude from scoring/drawing. Fails open (empty set) on error.
async function oceanHexes(
  _bbox: { south: number; west: number; north: number; east: number },
  centers: { hex: string; lat: number; lng: number }[],
): Promise<Set<string>> {
  try {
    const water = await waterCenters(centers.map(c => ({ lat: c.lat, lng: c.lng })));
    if (!water.size) return new Set();
    const exclude = new Set<string>();
    for (const c of centers) {
      if (water.has(centerKey(c.lat, c.lng))) exclude.add(c.hex);
    }
    return exclude;
  } catch {
    return new Set();
  }
}

// When the property scrape returned no usable median price, fall back to a
// grounded-AI estimate so the UI can still show a (clearly-labelled) figure
// instead of ₹0. Returns a RealEstateSignals-shaped object or the original.
async function withAiPropertyFallback(
  reSignals: any,
  area: string,
  city: string,
): Promise<any> {
  const hasPrice = reSignals && typeof reSignals.medianPricePerSqft === "number" && reSignals.medianPricePerSqft > 0;
  if (hasPrice) return reSignals;
  const est = await aiPropertyEstimate(area, city).catch(() => null);
  if (!est) return reSignals;
  return {
    ...(reSignals ?? { area, city, source: "merged", sampleSize: 0, medianPrice: null, underConstructionShare: 0, listings: [], fetchedAt: Date.now() }),
    medianPricePerSqft: est.medianPricePerSqft,
    avgBHK: est.avgBHK,
    aiEstimated: true,
    aiNote: est.note,
  };
}

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
    if (ex.bottomLine) {
      ex.bottomLine = ex.bottomLine
        .replace(/\bcompelling ['"]?GO['"]? opportunity/gi, "'AVOID' (Not Recommended) opportunity due to weak local metrics")
        .replace(/\b['"]?GO['"]? opportunity/gi, "'AVOID' (Not Recommended) opportunity")
        .replace(/\b['"]?GO['"]?\b/g, "'AVOID'");
    }
  } else if (saturated && ex.recommendation === "GO") {
    ex.recommendation = "CAUTION";
    ex.rating = Math.min(ex.rating ?? 3, 3);
    if (ex.bottomLine) {
      ex.bottomLine = ex.bottomLine
        .replace(/\bcompelling ['"]?GO['"]? opportunity/gi, "'CAUTION' (Proceed with Caution) opportunity due to high competitor saturation")
        .replace(/\b['"]?GO['"]? opportunity/gi, "'CAUTION' (Proceed with Caution) opportunity")
        .replace(/\b['"]?GO['"]?\b/g, "'CAUTION'");
    }
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
