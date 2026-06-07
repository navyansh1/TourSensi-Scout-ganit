# GeoScout IQ

**Location Decision Intelligence for BFSI & FMCG companies in India.**
A productized Ganit tool that recommends where banks should open ATMs/branches and where retailers should open stores/warehouses — backed by Google Maps, multi-source web data, and Gemini grounding agents.

Live: **https://toursensi-ganit-71c77.web.app**

---

## What it does

Type any Indian location → pick your industry → pick your company → click Analyze.

In ~30 seconds you get:
1. A **color-coded H3 hex heatmap** of a tight ~2.5 km neighborhood box (green = best site, red = saturated). Strong hexes render bold/opaque with a highlighted outline; weak hexes fade out, so the best zones visually pop instead of one flat blanket.
2. **Competitor pins** (with brand-name labels) for every relevant POI within ~4 km.
3. **Your own existing locations** as green pins.
4. **Vertical-specific nearby-context awareness** — for every hex we know what's physically around it (metro, mall, school, highway, port…) and surface it as *"320 m from a metro · 540 m from a shopping mall"*. The amenities we look for change with the use-case (ATM → footfall + transit; warehouse → ports/railheads/highways; grocery → schools + residential). This feeds the scoring, the recommendations, and the AI narrative.
5. **Real property listings for sale** at each hex (scraped from 99acres).
6. A **McKinsey-style Executive Summary** with:
   - Star rating + GO / CAUTION / AVOID recommendation
   - 3-4 specific growth drivers (e.g. *"Sarjapur–Hebbal Metro Phase 3A operational by Dec 2030"*)
   - 2-3 risks (e.g. *"BBMP zoning violations, Kannada signboard policy"*)
   - Actionable bottom line
7. **5 tagged recommendations**: 🏆 Best Overall, 🚀 Growth Play, 🛡️ Safe Bet, 🎯 Underserved, 💎 Premium Pick — each with its own nearby-amenity proximity line.
8. The **AI agent's full search trail** — every grounded Google query it ran, with clickable sources.
9. A **CSV/Excel/JSON import** for your existing locations (Gemini auto-maps your columns onto our schema).

---

## What's new (latest iteration)

- **Rebrand + map-quality pass (June 7, 2026)**:
  - **Renamed to GeoScout IQ** — the product is now **GeoScout IQ** (the "IQ" rendered in brand orange), with the subtitle **"Location Decision Intelligence"**. The Ganit logo and the wordmark are separated by a vertical divider so it reads as *a Ganit product*. Updated across the header, browser title, About modal, and the Wikipedia client User-Agent.
  - **No ocean zones** — hexes whose centre falls on open sea are detected via the **Google Maps Elevation API** (elevation ≤ 0 m) and excluded from scoring and the heatmap entirely, so the grid never paints over water (`water.ts`). Fails open if the Elevation API is unavailable.
  - **No-build land penalty** — hexes sitting on a **railway, airport/runway, river/lake, or large forest** are detected from **OpenStreetMap** land-use polygons (one Overpass `out geom;` query, local point-in-polygon test — zero extra per-hex API calls) and floored to a near-zero score so they read red and can never be recommended. Kept on the map (not deleted) because OSM polygons can be imperfect; flooring is the safe call (`landuse.ts`). A 🚫 "No-build zone" banner explains it in the hex panel. Fails open on any Overpass hiccup.
  - **Cannibalization warning** — each top recommendation is checked against the user's **own existing network** (both backend brand-search results and imported-CSV locations). Sites that sit inside a vertical-aware trade-area radius of an existing own site are flagged with an **⚠️ Overlap** badge on the card plus a detail line (e.g. *"320 m from your existing 'HDFC Koramangala' — high overlap, likely to split footfall"*).
  - **Labels now work on Satellite** — the Labels toggle previously did nothing on satellite view (the styler only affects roadmap). It now switches between Google's **`hybrid`** (satellite **with** labels) and **`satellite`** (no labels) map types, so the toggle works correctly across Map / Satellite / Standard.
  - **Darker UI lines** — the global border colour was deepened (`#e1e5ee` → `#c2c8d6`) for clearer separators app-wide, with a slightly stronger shade reserved for the brand divider; the modal close (×) buttons are also darker.
  - **Hardened OSM calls** — all Overpass requests now send a proper **User-Agent** header (the public Overpass server returns HTTP 406 without one), fixing the previously-flaky OSM demand signal.
- **Latest enhancements (June 2026)**:
  - **Interactive Recommended Markers (1-5)**: Numbered blue markers (`1` to `5`) corresponding to the top 5 recommended locations are plotted on the map. Features custom HTML overlay labels and full synchronization (clicking highlights H3 polygons, glides map, displays hex panel, and expands/scrolls sidebar cards).
  - **Premium Tooltip Popovers**: Replaced browser-default `title` tooltips on `+N more` chips with instant-hover / click-toggle custom `.more-tooltip` popovers, listing additional locations cleanly as bullet points.
  - **Pre-Analysis Welcome Placeholder**: Added a clean dashed welcome card in the sidebar indicating *"Please search for a location first to see suitability assessment"*, toggling visibility automatically based on active analysis states.
  - **Geocoding Precision & CSV Import Persistence**: Constructed full-address queries from all import columns (Street, Area, City, Pincode) to ensure highly accurate coordinate plotting. Preserved imported locations dynamically on subsequent analysis runs and PDF snapshots.
  - **Enriched Maps Search Trail**: Expanded context layers to search for ATMs (🏧), Restaurants (🍔), Offices (🏢), and Supermarkets (🛒) for richer suitability grading.
  - **Layout Stability**: Replaced the map label toggle hide logic with an `.invisible` state to prevent buttons from shifting positions when map views change.
  - **Standard Map View**: Renamed the "Terrain" map option to "Standard" in the header to simplify map types for business users.
  - **Premium Loading Animation**: Redesigned the Analyze button shimmer loading effect into a full-height diagonal sweep.
  - **Clean Details Panel**: Removed repetitive bottom dividing lines between statistic rows in the zone details panel.
  - **Score Context**: Added "Score " prefix to suitability points in the details panel for better consistency.
  - **PDF Export Compass**: Implemented a N-S-E-W compass needle widget overlay on top of the static map snapshot inside the generated PDF and Word reports.
- **UI/export polish** — the top-bar map controls now place **Labels** before Map/Satellite/Terrain, the Labels toggle hides on Terrain view, the visible Settings control is removed, and action icons use **Unicons** instead of emoji-style UI icons across the top bar and sidebar.
- **Executive summary exports** — the full executive summary modal now includes **Save as PDF** and **Save as Word** actions, with a Google Static Maps snapshot that includes heatmap polygons and key site/competitor markers.
- **Cleaner recommendation language** — visible recommendation badges now say **Highly Recommended / Proceed with Caution / Not Recommended** instead of exposing internal `GO / CAUTION / AVOID` codes.
- **Brand/header and panel refinement** — the `TourSensi Scout` wordmark is lighter and aligned more closely to the Ganit logo, the Analyze button shows a thin moving scan-line while analysis is running, sidebar summary cards vertically center their stat text, and the hex-panel nearby list keeps distance values in a fixed right column so entries like `665 m` do not wrap awkwardly.
- **Per-zone AI verdict** — click any hex → an on-demand, Google-grounded **OPEN / CONSIDER / AVOID** call with short, use-case-specific bullets (bold keywords), the supporting facts, and citations. Cached per zone (`zoneInsight.ts`, `/zone-insight`).
- **Real population (WorldPop)** — free, current, 100 m-grid India population is now the primary demand signal, replacing the POI-density-only proxy (`worldpop.ts`).
- **Honest, non-cheerleader summary** — the exec card states the market reality (competitor/own-site counts), is forced to **AVOID** when the whole area is weak and **CAUTION** when saturated, and suggests **alternative localities** to expand into instead (`applyHonesty` in `index.ts`).
- **Less-generous scoring** — empty land scores red, green is earned; validated against multiple cities. Google Places **ratings / review counts / permanently-closed** share feed demand as a footfall / dying-high-street signal.
- **Use-case-aware nearby context** — ATM → footfall+transit+safety; branch → affluence+offices; retail → schools+residential; warehouse → highways/rail/air/ports. Honest distances (never claims a far-off port is "nearby" in a landlocked city). "+N more" when several of a type are close.
- **Maps everywhere** — every marker (competitor, your site, mall/metro/school…) has a **View on Google Maps** link.
- **Choosable map layers** — a top-bar **"Show on map"** dropdown lets you toggle which nearby layers (metro / mall / school / hospital / …) are drawn. By default the map shows **only your sites + competitors** to stay uncluttered.
- **Ranked recommendations + regions to avoid** — top sites are listed **#1–#5** (clearer than the old tag labels), each chip reads "Score N/100". A separate **"⛔ Regions to avoid"** section surfaces the 3 worst, spread-out zones with a one-line reason.
- **Accurate own-brand matching** — a returned place is only tagged as *yours* if its **name** contains a distinctive brand token (generic words like "supermarket"/"bank" are ignored), so e.g. "More" no longer matches "Grace Supermarket".
- **Heatmap** — locked to a single **green → red** scale (theme switching disabled/commented), with thresholds tuned so weak zones clearly read red/orange. Fill opacity scales with score; map stays readable underneath.
- **UX** — **logo-matched brand colors** (electric indigo `#1a00d9` + orange `#fe6e06`), lighter Poppins wordmark matched to the Ganit logo, draggable sidebar, centered top-bar map controls (Labels/Map/Satellite/Terrain/zoom — native on-map controls hidden so the zone panel never covers them; zoom top-center), **bolded keywords** across the exec card / full summary / zone panel, bottom-line shown as bullet points, **About** modal listing every data source, steadily-paced progress checklist, gentle zone-to-zone glide, soft "be more specific" search nudge. Wikipedia fetch disabled (kept commented).

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  BROWSER (Vanilla JS · Inter font · Ganit blue+orange)          │
│  - Google Maps JS API + H3 hex heatmap                          │
│  - SSE-driven live progress UI                                  │
│  - Sidebar mini exec card + full-screen modal                   │
└────────────┬────────────────────────────────────────────────────┘
             │ fetch() / SSE stream
             ▼
┌─────────────────────────────────────────────────────────────────┐
│  FIREBASE HOSTING ──rewrites──► CLOUD RUN (Functions Gen 2)     │
│  asia-south1 · Node 20 · 1GiB · 540s timeout · public invoker   │
│  Express router mounted on both "/" and "/api" for direct +     │
│  hosting-proxied calls.                                         │
└────────────┬────────────────────────────────────────────────────┘
             │ in-parallel fan-out per analyze call
             ▼
┌──────────────┬──────────────┬─────────────┬───────────────┐
│ Google APIs  │ External web │ Cached      │ Vertex AI     │
│ - Geocoding  │ - 99acres    │ Firestore   │ - 8 grounded  │
│ - Places New │   (Apify)    │ - realestate│   Google      │
│   competitors│ - Wikipedia  │   per-area  │   searches    │
│ - Places New │   REST       │   cache     │ - 4 quadrant  │
│   nearby     │ - India Post │ - agent     │   micro-runs  │
│   context    │   PIN API    │   trails    │ - synthesis   │
│   (per-      │ - OSM        │             │   (executive  │
│    vertical) │   Overpass   │             │    summary +  │
│ - Reverse    │              │             │    nearby     │
│   geocode    │              │             │    context)   │
└──────────────┴──────────────┴─────────────┴───────────────┘
```

### Tech stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | Vanilla HTML/CSS/JS, no build step | Simplicity, instant edits, no toolchain |
| Map | Google Maps JS API + `h3-js@4.1.0` | Hex heatmap library + maps quality |
| Backend | Firebase Cloud Functions Gen 2 (Express, TypeScript) | One HTTPS endpoint, auto-scales |
| DB | Firestore (asia-south1) | Cache 99acres + agent trails |
| Auth bootstrap | Firebase Hosting public | No login needed for demo |
| AI | Vertex AI Gemini 2.5 Flash + `googleSearch` grounding | Bills against existing Blaze project, no separate AI Studio prepay |
| Web search | Vertex `googleSearch` tool inside Gemini | Returns citations natively |
| Real-estate | Apify actor `easyapi/99acres-com-scraper` | Pre-built, free tier, no Cloudflare babysitting |
| Spatial index | Uber H3 resolution 8 (≈460m edges) | Industry-standard hexagonal grid |
| Hosting region | asia-south1 (Mumbai) | Lowest latency for Indian users |
| Vertex region | us-central1 | `googleSearch` grounding only supported there |

### Data sources by category

| Category | Source | Cost | Notes |
|---|---|---|---|
| **Geocoding** | Google Geocoding API + Reverse Geocoding | 10K free/mo + $5 per 1K | Reverse geocode fills PIN when neighborhood lookup didn't include it |
| **Water / ocean** | Google Maps Elevation API | 40K free/mo | One batched call over all hex centres; elevation ≤ 0 m ⇒ sea ⇒ hex excluded (`water.ts`). Fails open. |
| **No-build land** | OpenStreetMap Overpass (`out geom;`) | Free | Railway/airport/water/forest polygons; local point-in-polygon test floors those hexes (`landuse.ts`). Fails open. |
| **Competitor POIs** | Google Places API (New) Text Search | 5K free/mo + $32 per 1K | 20-result `searchText` per analyze call. Now also captures `rating`, `userRatingCount`, `priceLevel`, `businessStatus` → fed into scoring as a footfall / "dying high-street" quality signal (`placeQuality` in `scoring.ts`). |
| **Your brand POIs** | Same — keyword filter per `companies.ts` catalog | same | E.g. `"HDFC Bank", "HDFC ATM"` |
| **Population (demand)** | **WorldPop** stats API (`api.worldpop.org`) | **Free, no key** | Real, current (2020, 100 m grid) gridded population for the analysis bbox. Async submit→poll. Density → primary demand signal (`worldpop.ts`). Replaces the dropped 2011-Census idea — current, not 14-yr-old, and spatial. |
| **Real estate** | Apify `easyapi/99acres-com-scraper` | ~$0.25 per 1K results | Scraped on-demand, cached in Firestore per `city_area` for 7 days |
| **Property listings shown in UI** | Same 99acres scrape | (above) | Top 10 listings per area surfaced to hex panel |
| **PIN/district** | api.postalpincode.in (free, India Post) | Free | + Google Reverse Geocoding fallback when geocode didn't return postal_code |
| **Geo-context paragraph** | ~~Wikipedia REST `/page/summary`~~ | Free | **Currently disabled** (commented in `index.ts`, kept for easy re-enable). |
| **Background POIs** | OpenStreetMap Overpass | Free, 10K req/day/IP | Used for OSM-based demand backdrop |
| **Nearby context** | Google Places (New) Text Search, **vertical-specific** | Pro SKU | Metro/road/anchor amenities chosen per use-case (ATM→footfall+transit, warehouse→ports/railheads/highways, retail→schools+residential). Feeds scoring (access/demand), per-hex proximity ("320 m from a metro"), AND the AI narrative. Replaces the old broken OSM overlay. See `context.ts`. |
| **AI growth signals** | Vertex AI Gemini 2.5 Flash + `googleSearch` | Blaze billing | 8 area queries + 4 quadrant queries + 1 synthesis = 13 calls per analyze |

### Folder layout

```
TourSensi Scout/
├── README.md                      ← this file
├── RUN_LOCAL.md                   ← local dev steps
├── firebase.json                  ← hosting + functions + emulators config
├── firestore.rules                ← public read of cached scores, per-user writes
├── firestore.indexes.json
├── .firebaserc                    ← project ID toursensi-ganit-71c77
├── .env.local                     ← gitignored secret stash (Gemini, Apify, Maps keys)
├── images.png                     ← Ganit logo (also copied into public/img/)
├── public/                        ← Firebase Hosting root
│   ├── index.html                 ← brand header + sidebar + map + legend + modals
│   ├── styles.css                 ← Ganit-brand light theme, exec-modal, progress
│   ├── app.js                     ← all UI logic (SSE, Maps drawing, exec rendering)
│   └── img/ganit-logo.png         ← logo
└── functions/                     ← Cloud Functions source
    ├── package.json               ← deps incl. firebase-functions, vertexai, h3-js
    ├── tsconfig.json
    └── src/
        ├── index.ts               ← Express router, /api/* endpoints, SSE stream
        ├── geocode.ts             ← Google Geocoding + reverse PIN fallback
        ├── places.ts              ← Google Places (New) text search wrappers
        ├── osm.ts                 ← Overpass POI fetch (background demand layer)
        ├── context.ts             ← vertical-specific nearby amenities (Google Places) + per-hex proximity + AI brief
        ├── worldpop.ts            ← WorldPop free population API (async submit→poll) → demand signal
        ├── zoneInsight.ts         ← on-demand per-zone AI verdict (OPEN/CONSIDER/AVOID), cached in Firestore
        ├── companies.ts           ← BFSI + FMCG company catalog (HDFC, DMart, Zepto…)
        ├── realestate.ts          ← Apify 99acres caller + Firestore cache + signal compute
        ├── wikipedia.ts           ← REST summary fetcher (currently disabled in index.ts)
        ├── census.ts              ← India Post PIN lookup
        ├── agent.ts               ← Vertex AI: 8 grounded queries + 4 quadrants + honest MBA synthesis
        ├── scoring.ts             ← H3 hex scoring (pop/quality/context aware) + tagged recommendation picker
        └── importLocations.ts     ← CSV/Excel/JSON parser + Gemini column auto-mapper
```

---

## The analyze pipeline

When the user clicks Analyze, the backend's `/api/analyze-stream` SSE endpoint runs **all of this in parallel** and streams progress events back to the browser:

```
1. Geocode location (Google Geocoding) → clamp bbox to a fixed ~2.5 km
   half-width box around center (granular, neighborhood-level; not Google's
   wildly-varying viewport)
   ↓
2. Fetch vertical-specific nearby context FIRST (Google Places, ~6 parallel
   queries) — metro/road/anchor amenities chosen per use-case (see context.ts).
   Done up-front so the AI agent can reference what's physically nearby.
   ↓
3. Fan-out (parallel):
   ├─ Google Places "ATM"/"bank"/"supermarket"/etc. in 4 km radius (competitors)
   ├─ Google Places filtered by company brand keywords (your sites)
   ├─ OSM Overpass POIs for the vertical (background demand layer)
   ├─ Wikipedia /page/summary  (4-variant title fallback)
   ├─ India Post PIN lookup → district
   ├─ Apify 99acres scrape (with Firestore cache key = city__area)
   └─ Vertex AI growth agent (now fed the nearby-context brief):
        ├─ 8 grounded Google searches in parallel (cap 3 concurrent)
        ├─ 4 quadrant micro-runs (NE/NW/SE/SW) for spatial variation
        ├─ Synthesis call → MBA executive summary JSON (cites nearby amenities)
        └─ all with exponential-backoff retry on 429
   ↓
4. Score every H3 hex in the bounding box using ScoreInputs:
   - demand = OSM POI density + wealth proxy + distance bump + nearby-context
     demand boost (schools/malls/offices/residential) + noise
   - saturation = inverse of competitor + own-brand density (or noise when zero)
   - access = OSM-driven + distance bump + nearby-context access boost
     (transit/highways/ports/railheads), distance-decayed per amenity
   - growth = quadrant-specific score from agent (not flat across the bbox)
   - final = weighted sum by vertical + ±2 noise so adjacent hexes look distinct
   - each hex also records its nearest amenities + a "320 m from a metro" phrase
   ↓
5. Pick top 5 tagged recommendations by diversifying along sub-scores:
   - BEST_OVERALL  (highest final)
   - GROWTH_PLAY   (highest growth sub-score)
   - SAFE_BET      (highest demand + access combined)
   - UNDERSERVED   (highest saturation = least competition)
   - PREMIUM_PICK  (highest median ₹/sqft from 99acres)
   ↓
6. Persist agent trail to Firestore (collection: agent_trails) for later retrieval.
   ↓
7. Stream final `result` event with everything to the browser.
```

The browser renders:
- Hex polygons on Google Maps with brand-color gradient; **fill opacity scales
  with score** (strong zones bold + outlined, weak zones faded) so good regions pop
- Competitor + own-brand markers with HTML name labels
- Nearby-context amenity markers (metro/mall/highway/port… per vertical)
- Sidebar exec mini card → click → full modal
- Wikipedia paragraph + PIN/district context block
- Tagged recommendations with click-to-pan-and-zoom + per-hex proximity line
- Hex panel "What's nearby" list with per-amenity distances
- Search trail accordion

---

## API reference (Cloud Run)

All endpoints under `https://api-bvb33x56gq-el.a.run.app` and also proxied at `/api/*` on the hosting URL.

| Method | Path | Body / Params | Returns |
|---|---|---|---|
| GET | `/config` | — | `{mapsBrowserKey, runUrl}` |
| GET | `/companies` | — | `{companies: Company[]}` — BFSI + FMCG catalog |
| POST | `/analyze` | `{location, vertical, companyId?}` | Single JSON blob with all results (use only for fast areas — hits Firebase Hosting's 60s edge timeout) |
| POST | `/analyze-stream` | same body | **SSE stream**: `progress` + `notice` (broad-location nudge) events, final `result` event. **Used by the frontend.** |
| POST | `/zone-insight` | `{vertical, area, city, lat, lng, final, demand, …}` (a clicked hex's facts) | On-demand, grounded AI verdict for ONE zone: `{verdict: OPEN\|CONSIDER\|AVOID, headline, facts[], reasoning[], bottomLine, sources[]}`. Cached in Firestore per zone. |
| POST | `/import?name=foo.csv` | raw bytes (octet-stream) | Gemini-mapped canonical locations |
| GET | `/agent-trail/:id` | — | Saved trail by ID |

### Verticals

`BFSI_ATM`, `BFSI_BRANCH`, `FMCG_RETAIL`, `FMCG_WAREHOUSE`

### Scoring weights (vertical-specific)

| Vertical | demand | saturation | access | growth |
|---|---|---|---|---|
| BFSI_ATM       | 0.40 | 0.30 | 0.20 | 0.10 |
| BFSI_BRANCH    | 0.35 | 0.25 | 0.20 | 0.20 |
| FMCG_RETAIL    | 0.45 | 0.25 | 0.15 | 0.15 |
| FMCG_WAREHOUSE | 0.25 | 0.10 | 0.40 | 0.25 |

---

## Cost & free-tier notes

| Item | Free tier | Hackathon cost estimate |
|---|---|---|
| Firebase Hosting + Firestore + Functions | Spark plan free → Blaze pay-as-you-go | <$1 |
| Google Maps JS API | 10K loads/month free | $0 |
| Places API (New) text search | 5K free/month (Pro SKU) | $0 — note: each analyze now also runs ~5-6 *nearby-context* Places queries (vertical-dependent) on top of the competitor/brand searches. Still within free tier for demo volume; cache per-area in Firestore if traffic grows. |
| Geocoding | 10K free/month | $0 |
| Vertex AI Gemini 2.5 Flash + grounding | Generous Blaze free tier; ~$0.035 per grounded prompt thereafter | <$2 |
| Apify 99acres actor | Free tier covers demo runs | $0 |
| Wikipedia / OSM / India Post | Free, unlimited (within etiquette) | $0 |
| **Total** | | **< $5 for the whole hackathon** |

---

## Key design decisions & lessons learned

### 1. Why Vertex AI instead of AI Studio (Gemini API key)?
We initially used the AI Studio Gemini API (`@google/generative-ai` SDK with an `AIzaSy…` key) but hit `RESOURCE_EXHAUSTED — prepayment credits depleted` at the account level. AI Studio bills through a separate prepayment wallet that isn't linked to Firebase Blaze. **Vertex AI bills directly against the project's Blaze account**, uses Application Default Credentials (no key in code), and has its own free tier. Switching cost us ~30 minutes; should have started there.

### 2. Why a 4-quadrant agent instead of one flat growth score?
The original "one score for the whole bbox" made every hex show `Score 50/100` and recommendations were indistinguishable. Running the agent 4 times (NE/NW/SE/SW) at a slightly higher cost gives real spatial variation. Combined with a distance-from-center bump + small per-hex noise, the heatmap actually looks like a heatmap.

### 3. Why drop MagicBricks?
The Apify MagicBricks actor moved to paid-rental after its free trial expired. 99acres alone provides enough listings to compute price/sqft and BHK signals. Adding MagicBricks back is one constant change in `realestate.ts`.

### 4. Why Server-Sent Events?
The full analyze takes 30-120s. Firebase Hosting's edge timeout is 60s, which 502s the browser before the function returns. Two fixes:
- Frontend calls Cloud Run directly (`https://api-bvb33x56gq-el.a.run.app/api/...`) which has the full 540s timeout
- SSE streams progress events so the user sees `geocode ✓`, `competitors ✓`, `realestate ✓`, etc. live — feels much faster

### 5. Why Express + router mounted on both `/` and `/api`?
Firebase Hosting rewrites preserve the full `/api/...` path when forwarding to Cloud Run, but direct Cloud Run calls hit `/config` without the prefix. Mounting the same router on both keeps both call paths working.

### 6. Why `googleSearch` not `googleSearchRetrieval`?
Gemini 2.5 (current Vertex flagship) uses `googleSearch`. Older `googleSearchRetrieval` returns 400. The SDK `@google/generative-ai@0.21.0` types still say `googleSearchRetrieval`, so we cast as `any`.

### 7. Why Wikipedia needed a User-Agent?
The Wikipedia REST API requires a non-default User-Agent header. Axios's default `axios/x.x.x` UA returns 403/null silently. Setting `User-Agent: TourSensiScout/1.0 (contact: ...)` fixed it instantly.

### 8. Why exponential-backoff retry on Vertex 429s?
Running 8 grounded queries + 4 quadrant queries + 1 synthesis in close succession trips Vertex's per-minute quota. Cap concurrency at 3 and retry up to 3 times with `2s, 4s, 8s` backoff. Result is reliable end-to-end runs.

### 9. Why a vertical-specific nearby-context engine (and why drop the OSM overlay)?
The old OSM Overpass overlay returned 0 results, drew nothing on the map, and — even when it worked — was purely decorative: it never touched scoring or the AI. We replaced it with `context.ts`, which uses Google Places and recognizes that **what counts as good "nearby" depends on the use-case**:
- **ATM** → footfall + walk-up access + safety (metro, bus, malls, hospitals, busy roads)
- **Bank branch** → affluence + commercial/office density + parking
- **Grocery / retail** → residential demand + family footfall (schools, apartments, markets)
- **Warehouse** → logistics arteries (highways, railheads, airports, ports/ICDs, industrial parks)

Each amenity carries a weight, a "good distance" (a port matters at 10 km; a metro at 400 m), and which sub-score it feeds. Per hex we compute distance-decayed proximity → boosts `access`/`demand`, records the nearest amenities, and produces a phrase like *"320 m from a metro"*. The same context is summarized into a brief handed to the AI synthesis so the executive summary can cite real surroundings. This is why context is fetched **before** the parallel fan-out rather than inside it.

### 10. Why clamp the bbox + scale hex opacity by score?
Two "make the map read as a map" fixes. (a) Google's geocode viewport ranges from a city block to a whole district; we clamp to a fixed ~2.5 km half-width box so every analysis is consistently granular and local. (b) Drawing every hex at a flat `0.55` opacity made strong and weak zones look equally loud. Now fill opacity scales with score on an eased curve (faint ~0.08 → bold ~0.7), top-tier hexes (≥75) get a heavier outline and higher z-index, so the best regions genuinely stand out.

---

## What's left / known issues

- ~~**OSM overlay query returns 0**~~ — **fixed**: replaced with vertical-specific Google Places nearby context (`context.ts`), now wired into scoring + AI narrative.
- **MagicBricks dropped** — could be re-added via Bright Data or by paying for the actor rental.
- **OSM background POIs returning 0** — same Overpass issue. Doesn't affect scoring critically since other signals dominate.
- **No auth** — anyone with the URL can run analyses. Fine for a demo; add Firebase Auth before going public.
- **Maps API key is unrestricted** — restrict by HTTP referrer before public launch.
- **No PDF/Excel export** for the executive summary — easy add (`html2pdf.js` would do it).
- **Single-tenant** — no per-user state beyond Firestore rules. Multi-tenant requires Auth + per-user collections.

---

## Running locally

See [RUN_LOCAL.md](./RUN_LOCAL.md). TL;DR:

```bash
cd "TourSensi Scout/public"
npx serve -p 5173
# open http://localhost:5173
```

Frontend changes show instantly with a hard refresh. Backend lives on Firebase — `firebase deploy --only functions` to push changes.

---

## Deploying

```bash
# from project root
firebase deploy --only functions,hosting,firestore:rules
```

Required: `firebase login` as the account that owns project `toursensi-ganit-71c77` (Blaze enabled).

### Secrets

Stored in Firebase Secret Manager and mounted into the function at runtime:
- `APIFY_TOKEN`
- `GOOGLE_MAPS_SERVER_KEY`
- `GOOGLE_MAPS_BROWSER_KEY`

`GEMINI_API_KEY` is no longer needed — Vertex AI uses ADC.

To rotate:
```bash
printf 'NEW_TOKEN' | firebase functions:secrets:set APIFY_TOKEN --data-file -
firebase deploy --only functions
```

### IAM roles required on the function's service account
(`402329536314-compute@developer.gserviceaccount.com`)
- Cloud Build Service Account
- Secret Manager Secret Accessor (auto-granted on `secrets:set`)
- **Vertex AI User** (shown as "Agent Platform User" in the rebranded GCP UI) — required for Gemini grounding calls

---

## Built for

The Ganit Inc. ideathon. Service-based company, ~218 people, sells into BFSI / FMCG / retail / logistics. The pitch: turn the kind of analysis their consultants do manually (site selection, demand modelling, competitor mapping) into a productized SaaS tool — *Data Speaks*.

Brand colors used throughout — sampled directly from the Ganit "data speaks" logo: **Ganit Blue `#1a00d9`** (electric indigo) and **Ganit Orange `#fe6e06`**. The wordmark uses **Poppins** to match the logo.
