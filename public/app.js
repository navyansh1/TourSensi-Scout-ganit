// GeoScout IQ — frontend (vanilla JS, no build step).

const DEPLOYED_RUN = "https://api-bvb33x56gq-el.a.run.app";
const isLocal = location.hostname === "localhost" || location.hostname === "127.0.0.1";
const API = isLocal ? `${DEPLOYED_RUN}/api` : "/api";
let RUN = isLocal ? DEPLOYED_RUN : "/api";

let map = null;
let hexPolygons = [];
let markers = [];
let importedMarkers = [];
let importedLocationsData = [];
let lastResult = null;
let comparedSites = [];   // side-by-side comparison set (snapshots of analyses)
let mapsBrowserKey = "";
let currentTheme = localStorage.getItem("scoutTheme") || "soft";
let selectedPolyHighlight = null;
let infoWindow = null;

const TAG_LABELS = {
  BEST_OVERALL: "🏆 Best Overall",
  GROWTH_PLAY:  "🚀 Growth Play",
  SAFE_BET:     "🛡️ Safe Bet",
  UNDERSERVED:  "🎯 Underserved",
  PREMIUM_PICK: "💎 Premium Pick",
};

// ---------- bootstrap ----------
(async function init() {
  const cfg = await fetch(`${API}/config`).then(r => r.json()).catch(() => ({}));
  const key = cfg.mapsBrowserKey;
  mapsBrowserKey = key || "";
  if (cfg.runUrl) RUN = cfg.runUrl;
  if (!key) return setStatus("⚠ Google Maps key not configured.", "error");
  await loadGoogleMaps(key);
  initMap();
  await loadCompanies();
  bindUI();
})();

function loadGoogleMaps(key) {
  return new Promise((resolve, reject) => {
    if (window.google?.maps) return resolve();
    const s = document.createElement("script");
    s.src = `https://maps.googleapis.com/maps/api/js?key=${key}&libraries=places,geometry`;
    s.async = true;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

function initMap() {
  map = new google.maps.Map(document.getElementById("map"), {
    center: { lat: 20.5937, lng: 78.9629 },
    zoom: 5,
    styles: brandMapStyle(),
    // All native on-map controls are OFF — we drive the map from custom buttons
    // in the top bar instead, so nothing on the map can be hidden by the panel.
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: false,
    zoomControl: false,
    gestureHandling: "greedy", // scroll-to-zoom without holding ctrl
    clickableIcons: false,     // don't intercept clicks on Google's own POIs
  });

  infoWindow = new google.maps.InfoWindow();
  initMapControls();

  const input = document.getElementById("location");
  const ac = new google.maps.places.Autocomplete(input, {
    componentRestrictions: { country: "in" },
    fields: ["formatted_address", "geometry", "name"],
  });
  ac.addListener("place_changed", () => {
    const p = ac.getPlace();
    if (p.geometry?.location) { map.panTo(p.geometry.location); map.setZoom(14); }
  });
}

// Custom top-bar controls that drive the map directly (mimic Google's own
// terrain / labels / zoom controls, but living in our header).
let _labelsOn = true;
function applyMapStyle() {
  const type = map.getMapTypeId();

  // Satellite/hybrid: Google can't style labels off, but it has two distinct
  // map types — "hybrid" = satellite WITH labels, "satellite" = no labels. So
  // the Labels toggle switches between them. (Buttons mark the imagery view as
  // "satellite"; we translate to hybrid when labels are wanted.)
  if (type === "satellite" || type === "hybrid") {
    const want = _labelsOn ? "hybrid" : "satellite";
    if (type !== want) map.setMapTypeId(want);
    map.setOptions({ styles: null });
    return;
  }

  // Terrain ignores label styling — leave it alone.
  if (type !== "roadmap") { map.setOptions({ styles: null }); return; }

  // Roadmap: hide label elements via the styles array.
  const base = brandMapStyle();
  const labelsOff = [
    { elementType: "labels", stylers: [{ visibility: "off" }] },
    { featureType: "road", elementType: "labels", stylers: [{ visibility: "off" }] },
  ];
  map.setOptions({ styles: _labelsOn ? base : base.concat(labelsOff) });
}

function initMapControls() {
  // Map type buttons
  document.querySelectorAll("#mapTypeGroup .mc-btn").forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll("#mapTypeGroup .mc-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      map.setMapTypeId(btn.dataset.maptype);
      updateLabelsControlVisibility();
      applyMapStyle();
    };
  });
  // Labels toggle
  const labelsBtn = document.getElementById("labelsToggle");
  if (labelsBtn) {
    labelsBtn.classList.add("active");
    labelsBtn.onclick = () => {
      _labelsOn = !_labelsOn;
      labelsBtn.classList.toggle("active", _labelsOn);
      applyMapStyle();
    };
  }
  updateLabelsControlVisibility();
  // Zoom
  document.getElementById("zoomInBtn").onclick = () => map.setZoom((map.getZoom() ?? 12) + 1);
  document.getElementById("zoomOutBtn").onclick = () => map.setZoom((map.getZoom() ?? 12) - 1);
}

function updateLabelsControlVisibility() {
  const labelsBtn = document.getElementById("labelsToggle");
  if (!labelsBtn || !map) return;
  labelsBtn.classList.toggle("invisible", map.getMapTypeId() === "terrain");
}

// Draggable divider between the sidebar and the map.
function initSidebarResizer() {
  const resizer = document.getElementById("sidebarResizer");
  if (!resizer) return;
  const MIN = 320, MAX = 760;
  let dragging = false;

  const onMove = (clientX) => {
    const w = Math.max(MIN, Math.min(MAX, clientX));
    document.documentElement.style.setProperty("--sidebar-width", `${w}px`);
  };

  const start = (e) => {
    dragging = true;
    document.querySelector("main")?.classList.add("resizing");
    e.preventDefault();
  };
  const stop = () => {
    if (!dragging) return;
    dragging = false;
    document.querySelector("main")?.classList.remove("resizing");
    // Google Maps needs a resize nudge once, at drag end (cheap, avoids jank).
    if (map) google.maps.event.trigger(map, "resize");
  };

  resizer.addEventListener("mousedown", start);
  resizer.addEventListener("touchstart", (e) => { start(e); }, { passive: false });

  window.addEventListener("mousemove", (e) => { if (dragging) onMove(e.clientX); });
  window.addEventListener("touchmove", (e) => {
    if (dragging && e.touches[0]) { onMove(e.touches[0].clientX); e.preventDefault(); }
  }, { passive: false });

  window.addEventListener("mouseup", stop);
  window.addEventListener("touchend", stop);

  // Double-click the divider to reset to default width.
  resizer.addEventListener("dblclick", () => {
    document.documentElement.style.setProperty("--sidebar-width", "480px");
    if (map) google.maps.event.trigger(map, "resize");
  });
}

async function loadCompanies() {
  const { companies } = await fetch(`${API}/companies`).then(r => r.json());
  const sel = document.getElementById("company");
  const verticalSel = document.getElementById("vertical");
  function refresh() {
    const v = verticalSel.value;
    sel.innerHTML = `<option value="">(none — show competitors only)</option>` +
      companies.filter(c => c.vertical.includes(v))
        .map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`)
        .join("");
  }
  verticalSel.addEventListener("change", refresh);
  refresh();
}

function bindUI() {
  document.getElementById("analyzeBtn").onclick = onAnalyze;
  document.getElementById("trailToggle").onclick = (e) => {
    const t = document.getElementById("trail");
    t.classList.toggle("hidden");
    e.target.textContent = t.classList.contains("hidden")
      ? "Show 8 grounded searches ▾" : "Hide search trail ▴";
  };
  document.getElementById("hexClose").onclick = () => {
    document.getElementById("hexPanel").classList.add("hidden");
    if (selectedPolyHighlight) {
      selectedPolyHighlight.setMap(null);
      selectedPolyHighlight = null;
    }
  };
  document.getElementById("importBtn").onclick = () => document.getElementById("importModal").classList.remove("hidden");
  document.getElementById("importClose").onclick = () => document.getElementById("importModal").classList.add("hidden");
  document.getElementById("importFile").onchange = onImportFile;
  const execBtn = document.getElementById("execBtn");
  if (execBtn) execBtn.onclick = openExecModal;
  document.getElementById("execClose").onclick = () => document.getElementById("execModal").classList.add("hidden");
  document.getElementById("infoBtn").onclick = () => document.getElementById("infoModal").classList.remove("hidden");
  document.getElementById("infoClose").onclick = () => document.getElementById("infoModal").classList.add("hidden");

  // Compare locations
  document.getElementById("addCompareBtn").onclick = addCurrentToCompare;
  document.getElementById("compareBtn").onclick = openCompareModal;
  document.getElementById("compareClose").onclick = () => document.getElementById("compareModal").classList.add("hidden");

  // "Show on map" layers dropdown
  const layersBtn = document.getElementById("layersBtn");
  const layersMenu = document.getElementById("layersMenu");
  if (layersBtn && layersMenu) {
    layersBtn.onclick = (e) => { e.stopPropagation(); layersMenu.classList.toggle("hidden"); };
    document.addEventListener("click", (e) => {
      if (!layersMenu.classList.contains("hidden") && !layersMenu.contains(e.target) && e.target !== layersBtn) {
        layersMenu.classList.add("hidden");
      }
    });
  }

  initSidebarResizer();

  // Settings panel + theme picker
  const settingsBtn = document.getElementById("settingsBtn");
  const settingsPanel = document.getElementById("settingsPanel");
  const themeSelect = document.getElementById("themeSelect");
  if (settingsBtn && settingsPanel) {
    settingsBtn.onclick = (e) => { e.stopPropagation(); settingsPanel.classList.toggle("hidden"); };
    // Click outside to dismiss.
    document.addEventListener("click", (e) => {
      if (!settingsPanel.classList.contains("hidden") &&
          !settingsPanel.contains(e.target) && e.target !== settingsBtn) {
        settingsPanel.classList.add("hidden");
      }
    });
  }
  if (themeSelect) {
    themeSelect.value = currentTheme;
    themeSelect.onchange = (e) => {
      currentTheme = e.target.value;
      localStorage.setItem("scoutTheme", currentTheme);
      updateLegendSwatches();
      redrawHeatmap();
    };
  }
  updateLegendSwatches();

  // Dismiss all active tooltips when clicking anywhere else
  document.addEventListener("click", () => {
    document.querySelectorAll(".more-chip.active").forEach(el => el.classList.remove("active"));
  });
}

// ---------- analyze (streaming) ----------
async function onAnalyze() {
  const location = document.getElementById("location").value.trim();
  const vertical = document.getElementById("vertical").value;
  const companyId = document.getElementById("company").value;
  if (!location) return setStatus("Enter a location first.", "error");

  clearMap();
  document.getElementById("summary").classList.add("hidden");
  document.getElementById("legend").classList.add("hidden");
  document.getElementById("execBtn")?.classList.add("hidden");
  setAnalyzeBusy(true);
  startProgress();

  try {
    const resp = await fetch(`${RUN}/analyze-stream`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ location, vertical, companyId }),
    });
    if (!resp.ok || !resp.body) throw new Error(await resp.text());

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const evt = parseSSE(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 2);
        if (!evt) continue;
        if (evt.event === "progress") onProgress(evt.data);
        else if (evt.event === "notice") onNotice(evt.data);
        else if (evt.event === "result") {
          lastResult = evt.data;
          renderResult(evt.data);
          finishProgress();
          setAnalyzeBusy(false);
        } else if (evt.event === "error") throw new Error(evt.data.message);
      }
    }
  } catch (e) {
    console.error(e);
    setStatus(`Error: ${e.message}`, "error");
    document.getElementById("progressPanel").classList.add("hidden");
    setAnalyzeBusy(false);
  }
}

function setAnalyzeBusy(on) {
  const btn = document.getElementById("analyzeBtn");
  if (!btn) return;
  btn.classList.toggle("analyzing", on);
  btn.disabled = on;
  btn.innerHTML = on
    ? `<i class="uil uil-hourglass"></i>Analyzing location`
    : `<i class="uil uil-bolt-alt"></i>Analyze location`;
}

function parseSSE(raw) {
  let event = "message", data = "";
  for (const l of raw.split("\n")) {
    if (l.startsWith("event:")) event = l.slice(6).trim();
    else if (l.startsWith("data:")) data += l.slice(5).trim();
  }
  try { return { event, data: JSON.parse(data) }; } catch { return null; }
}

// ---------- progress ----------
// A box of parameters that auto-ticks top-to-bottom. The ticking is entirely
// driven by a timer (fake), so it always feels like steady forward progress
// regardless of which backend call finishes when. The real `result` event just
// flushes any remaining ticks at the end.
const PROGRESS_ITEMS = [
  "Pinpointing the location",
  "Scanning for nearby competitors",
  "Locating your existing sites",
  "Mapping metro, roads & landmarks",
  "Reading area demographics & history",
  "Checking property prices & listings",
  "Researching growth signals on the web",
  "Weighing demand, competition & access",
  "Scoring every area for suitability",
];
let _tickTimer = null, _tickIdx = 0;

function startProgress() {
  const panel = document.getElementById("progressPanel");
  panel.classList.remove("hidden");
  _tickIdx = 0;
  panel.innerHTML = `
    <div class="progress-title"><i class="uil uil-hourglass"></i>Analyzing location</div>
    <ul class="progress-list">
      ${PROGRESS_ITEMS.map((label, i) => `
        <li id="pi-${i}" class="${i === 0 ? "running" : "pending"}">
          <span class="ps-icon">${i === 0 ? '<span class="spinner"></span>' : "○"}</span>
          <span class="ps-label">${label}</span>
        </li>`).join("")}
    </ul>`;
  setStatus("", "");

  // Auto-tick top to bottom at a calm, steady pace. A full analysis takes
  // ~25-40s, so we spread the ticks over ~24s (≈3s each) and deliberately HOLD
  // on the last item ("Scoring…") until the real result arrives — at which point
  // finishProgress() snaps everything to done. This avoids the old "all fast then
  // one hangs forever" feel.
  clearInterval(_tickTimer);
  const STEP_MS = 3000; // steady ~3s per item
  const advance = () => {
    if (_tickIdx >= PROGRESS_ITEMS.length - 1) return; // hold the last for the result
    completeTick(_tickIdx);
    _tickIdx++;
    setRunning(_tickIdx);
    _tickTimer = setTimeout(advance, STEP_MS);
  };
  _tickTimer = setTimeout(advance, STEP_MS);
}

function completeTick(i) {
  const li = document.getElementById(`pi-${i}`);
  if (!li) return;
  li.className = "done";
  li.querySelector(".ps-icon").textContent = "✓";
}
function setRunning(i) {
  const li = document.getElementById(`pi-${i}`);
  if (!li) return;
  li.className = "running";
  li.querySelector(".ps-icon").innerHTML = '<span class="spinner"></span>';
}

// Real SSE events are ignored for display — the tick animation is self-driven.
function onProgress() { /* intentionally cosmetic-only; ticks are timer-driven */ }

// Soft, non-blocking nudge when the user searched a whole city instead of a
// specific neighbourhood. We still run the analysis — just hint they can sharpen it.
let _broadNotice = "";
function onNotice(data) {
  if (data?.kind === "broad-location") {
    _broadNotice = `💡 "${data.area}" is a broad area — for sharper results, try a specific locality (e.g. "Koramangala, ${data.area}").`;
  }
}

function finishProgress() {
  clearTimeout(_tickTimer);
  // Flush every remaining item to ✓.
  for (let i = 0; i < PROGRESS_ITEMS.length; i++) completeTick(i);
  setTimeout(() => document.getElementById("progressPanel").classList.add("hidden"), 450);
  // The designed stat card now carries the result summary; status stays clean.
  setStatus("", "");
  if (_broadNotice) {
    const s = document.getElementById("status");
    if (s) { s.className = "status hint"; s.innerHTML = `<div class="status-hint">${escapeHtml(_broadNotice)}</div>`; }
    _broadNotice = "";
  }
}

// ---------- render ----------
function renderResult(data) {
  map.panTo({ lat: data.geo.lat, lng: data.geo.lng });
  map.fitBounds(data.geo.bbox);

  // Clear previous selected poly
  if (selectedPolyHighlight) {
    selectedPolyHighlight.setMap(null);
    selectedPolyHighlight = null;
  }

  // Heatmap
  for (const h of data.hexes) drawHex(h);
  document.getElementById("legend").classList.remove("hidden");

  // Pins — your sites + competitors are ALWAYS shown by default.
  for (const p of data.competitorsList) addCompetitorPin(p, "#dc2626", "Competitor");
  for (const p of data.ownList)         addCompetitorPin(p, "#22c55e", "Your site", "own");

  // Numbered Recommended Sites (#1-5) on the map
  (data.recommendations || []).forEach((r, idx) => {
    addRecommendedPin(r, idx, data);
  });

  // Context overlays (metro/mall/school/…) are kept hidden by default and only
  // shown when the user ticks them in the "Show on map" dropdown.
  buildLayerControl(data.overlay || []);

  // Headline stat card
  document.getElementById("resultStats").innerHTML = renderResultStats(data);

  // Exec mini card in sidebar
  document.getElementById("execMini").innerHTML = renderExecMini(data);
  document.getElementById("execBtn")?.classList.remove("hidden");
  document.querySelector(".em-cta")?.addEventListener("click", openExecModal);

  // Helper for quadrant name
  function getQuadLabel(lat, lng, center) {
    if (!center) return "area";
    const ns = lat >= center.lat ? "North" : "South";
    const ew = lng >= center.lng ? "East" : "West";
    return `${ns}-${ew} quadrant`;
  }

  // Tagged recommendations
  document.getElementById("recList").innerHTML = data.recommendations.map((r, i) => {
    const scColor = scoreColor(r.final);
    const landmark = r.signals.nearest[0];
    const locDesc = `Zone: Near ${landmark ? escapeHtml(landmark.name) : 'Center'} (${getQuadLabel(r.lat, r.lng, data.geo)})`;
    const cann = cannibalizationFor(r, data);
    const cannBadge = cann && cann.risk !== "NONE"
      ? `<span class="cann-badge ${cann.risk.toLowerCase()}" title="${escapeHtml(cann.note)}">${cann.risk === "HIGH" ? "⚠️" : "🔶"} Overlap</span>`
      : "";

    return `
      <li class="tagged-card" data-hex="${r.hex}" style="--score-color: ${scColor}">
        <div class="rec-card-header">
          <div class="rec-rank"><span class="rank-num">#${i + 1}</span>${cannBadge}</div>
          <div class="rec-card-score">Score ${r.final}/100</div>
        </div>
        <div class="rec-card-summary">
          <div style="font-weight: 700; margin-bottom: 2px; color: var(--ganit-blue);">${locDesc}</div>
          <div style="font-size: 11.5px; color: var(--text-2); font-weight: 500;">📍 ${escapeHtml(r.signals.proximityPhrase || "")}</div>
        </div>
        ${renderExpandedDetails(r, data)}
        <div class="rec-card-chevron">View Details ▾</div>
      </li>
    `;
  }).join("");

  // Attach accordion and amenity click handlers
  document.querySelectorAll("#recList li.tagged-card").forEach(li => {
    li.onclick = (e) => {
      // Check if click was on a link
      if (e.target.classList.contains("amenity-link")) {
        const name = e.target.dataset.name;
        const targetMarker = markers.find(m => m.poiName === name && m.getPosition);
        if (targetMarker) {
          map.panTo(targetMarker.getPosition());
          map.setZoom(17);
          google.maps.event.trigger(targetMarker, "click");
        }
        return;
      }

      const isExpanded = li.classList.contains("expanded");
      document.querySelectorAll("#recList li.tagged-card").forEach(other => {
        other.classList.remove("expanded");
        other.querySelector(".rec-details-panel")?.classList.add("hidden");
        const chevron = other.querySelector(".rec-card-chevron");
        if (chevron) chevron.textContent = "View Details ▾";
      });

      if (!isExpanded) {
        li.classList.add("expanded");
        li.querySelector(".rec-details-panel").classList.remove("hidden");
        li.querySelector(".rec-card-chevron").textContent = "Hide Details ▴";

        const h = data.hexes.find(x => x.hex === li.dataset.hex);
        if (h) {
          glideToZone(h);
          highlightHexOnMap(h);
          showHexPanel(h, data);
        }
      }
    };
  });

  // Regions to avoid — the worst-scoring distinct zones (spread out so they're
  // not all the same cluster). Click to fly there + open the panel.
  renderAvoidList(data);

  // Area context (wiki + pin)
  document.getElementById("contextPanel").innerHTML = renderContext(data);

  // Search trail
  document.getElementById("trail").innerHTML = data.agent.trail.map(t => `
    <div class="trail-item">
      <div class="q">🔎 ${escapeHtml(t.query)}</div>
      <div>${escapeHtml(t.summary)}</div>
      ${t.sources?.length ? `<div class="src">Sources: ${t.sources.slice(0,3).map(s => `<a href="${s.uri}" target="_blank" rel="noopener">${escapeHtml(s.title || "link")}</a>`).join(" · ")}</div>` : ""}
    </div>`).join("");

  document.getElementById("summary").classList.remove("hidden");
}

// A compact, designed stat card replacing the old text status line.
function renderResultStats(data) {
  const c = data.counts || {};
  const growth = data.agent?.growthScore ?? 0;
  const best = data.recommendations?.[0]?.final ?? Math.max(0, ...(data.hexes || []).map(h => h.final));
  const area = data.geo?.area || data.geo?.city || "this area";
  const stat = (value, label, color) => `
    <div class="stat">
      <div class="stat-value" style="${color ? `color:${color}` : ""}">${value}</div>
      <div class="stat-label">${label}</div>
    </div>`;
  return `
    <div class="rs-head"><i class="uil uil-chart-bar"></i>Analysis ready for <strong>${escapeHtml(area)}</strong></div>
    <div class="stat-grid">
      ${stat(c.competitors ?? 0, "Competitors", "#dc2626")}
      ${stat(c.ownBrand ?? 0, "Your sites", "#16a34a")}
      ${stat(`${best}`, "Top site score", scoreColor(best))}
      ${stat(`${growth}`, "Growth outlook", "var(--ganit-blue)")}
    </div>`;
}

// The 3 worst zones, spaced apart so they aren't one tight cluster.
function renderAvoidList(data) {
  const el = document.getElementById("avoidList");
  if (!el) return;
  const sorted = [...data.hexes].sort((a, b) => a.final - b.final);
  const picks = [];
  for (const h of sorted) {
    if (picks.length >= 3) break;
    // keep them spread: skip if within ~600m of an already-picked avoid zone
    if (picks.some(p => Math.hypot(p.lat - h.lat, p.lng - h.lng) < 0.006)) continue;
    picks.push(h);
  }
  el.innerHTML = picks.map(h => {
    const why = h.signals.competitorCount >= 3 ? `${h.signals.competitorCount} competitors crowd this spot`
      : h.demand < 35 ? "very low demand nearby"
      : h.access < 35 ? "poor accessibility"
      : "weak overall fundamentals";
    return `<li class="avoid-card" data-hex="${h.hex}" style="--score-color:${scoreColor(h.final)}">
      <div class="avoid-row">
        <span class="avoid-score">Score ${h.final}/100</span>
        <span class="avoid-coords">${h.lat.toFixed(4)}, ${h.lng.toFixed(4)}</span>
      </div>
      <div class="avoid-why">⚠ ${escapeHtml(why)}</div>
    </li>`;
  }).join("") || `<li class="avoid-empty">No clearly bad zones — this area scores reasonably throughout.</li>`;

  el.querySelectorAll("li.avoid-card").forEach(li => {
    li.onclick = () => {
      const h = data.hexes.find(x => x.hex === li.dataset.hex);
      if (h) { glideToZone(h); highlightHexOnMap(h); showHexPanel(h, data); }
    };
  });
}

function renderExecMini(data) {
  const ex = data.agent.executive || { rating: 3, recommendation: "CAUTION", bottomLine: "" };
  const stars = "★".repeat(ex.rating) + "☆".repeat(5 - ex.rating);
  return `
    <div class="em-row">
      <div class="em-area">${escapeHtml(data.geo.area || data.geo.city)}</div>
      <div class="em-rec ${ex.recommendation}">${recommendationLabel(ex.recommendation)}</div>
    </div>
    <div class="em-stars">${stars}</div>
    ${ex.marketState ? `<div class="em-market">📍 ${boldKeywords(ex.marketState)}</div>` : ""}
    ${ex.bottomLine ? `<ul class="em-points">${bulletize(ex.bottomLine).map(b => `<li>${boldKeywords(b)}</li>`).join("")}</ul>` : ""}
    ${(ex.alternatives && ex.alternatives.length) ? `
      <div class="em-alts">
        <div class="em-alts-label">Consider instead</div>
        ${ex.alternatives.map(a => `<div class="em-alt">↪ ${boldKeywords(a)}</div>`).join("")}
      </div>` : ""}
    <button class="em-cta"><i class="uil uil-file-alt"></i>Open full executive summary →</button>
  `;
}

function recommendationLabel(rec) {
  if (rec === "GO") return "Highly Recommended";
  if (rec === "AVOID") return "Not Recommended";
  return "Proceed with Caution";
}

// Split a short prose blurb into clean sentence bullets.
function bulletize(text) {
  return String(text || "")
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 1);
}

function renderContext(data) {
  const w = data.wiki, pin = data.pin, re = data.realEstate;
  // Wikipedia blurb only rendered when present (the fetch is currently disabled).
  const blurb = w?.summary ? boldKeywords(w.summary.slice(0, 380) + (w.summary.length > 380 ? "…" : "")) : "";
  return `
    ${blurb ? `<div class="context-block">${blurb}
      ${w?.url ? `<div style="margin-top:6px"><a href="${w.url}" target="_blank" style="color:var(--ganit-blue); font-size:11px">Read more on Wikipedia ↗</a></div>` : ""}
    </div>` : ""}
    <div class="context-meta">
      ${pin?.pin ? `<div class="cm-item"><strong>PIN</strong> ${pin.pin}</div>` : ""}
      ${pin?.district ? `<div class="cm-item"><strong>District</strong> ${escapeHtml(pin.district)}</div>` : ""}
      ${data.population?.totalPopulation ? `<div class="cm-item"><strong>Population</strong> ~${data.population.totalPopulation.toLocaleString("en-IN")} (${data.population.densityPerKm2.toLocaleString("en-IN")}/km²)</div>` : (w?.population ? `<div class="cm-item"><strong>Population</strong> ~${w.population.toLocaleString("en-IN")}</div>` : "")}
      ${re?.medianPricePerSqft ? `<div class="cm-item"><strong>Median ₹/sqft</strong> ₹${Math.round(re.medianPricePerSqft).toLocaleString("en-IN")}</div>` : ""}
      ${data.counts?.overlay ? `<div class="cm-item"><strong>${data.counts.overlay}</strong> nearby landmarks</div>` : ""}
    </div>`;
}

function boldKeywords(text) {
  const KEYWORDS = ["metro", "infrastructure", "IT park", "SEZ", "highway", "flyover", "incentive",
    "subsidy", "population", "real estate", "residential", "commercial", "demographic", "young",
    "disposable income", "employment", "construction", "demand", "saturated", "competition",
    "investment", "data center", "headquarters", "campus", "expansion", "growth"];
  let out = escapeHtml(text);
  KEYWORDS.forEach(k => {
    const rx = new RegExp(`\\b(${k}[a-z]*)\\b`, "gi");
    out = out.replace(rx, "<strong>$1</strong>");
  });
  return out;
}

// ---------- map drawing ----------
function drawHex(h) {
  const boundary = window.h3.cellToBoundary(h.hex, true);
  const path = boundary.map(([lng, lat]) => ({ lat, lng }));
  const color = scoreColor(h.final);

  const { fillOpacity, strokeOpacity, strokeWeight } = hexStyle(h.final);

  const poly = new google.maps.Polygon({
    paths: path,
    strokeWeight,
    strokeColor: color,
    strokeOpacity,
    fillColor: color,
    fillOpacity,
    zIndex: Math.round(h.final), // strong hexes render above weak ones
    map, clickable: true,
  });
  poly.h = h; // save reference for theme switching
  poly.addListener("click", () => {
    glideToZone(h);
    highlightHexOnMap(h);
    showHexPanel(h, lastResult);
  });
  hexPolygons.push(poly);
}

function addCompetitorPin(p, color, label, kind = "competitor") {
  // Marker
  const m = new google.maps.Marker({
    position: { lat: p.lat, lng: p.lng }, map,
    title: `${label}: ${p.name}`,
    optimized: true,
    icon: {
      path: google.maps.SymbolPath.CIRCLE,
      scale: 7, fillColor: color, fillOpacity: 1,
      strokeWeight: 2, strokeColor: "#fff",
    },
  });
  m.poiName = p.name;
  m.addListener("click", () => {
    const content = `
      <div style="font-family: 'Inter', sans-serif; padding: 6px; min-width: 150px;">
        <div style="font-size: 11px; font-weight: 700; color: ${color}; text-transform: uppercase; margin-bottom: 2px;">
          ${label === "Your site" ? "🟢 Your Existing Location" : "🔴 Competitor Site"}
        </div>
        <div style="font-size: 13px; font-weight: 600; color: var(--text);">${escapeHtml(p.name)}</div>
        <div style="font-size: 10px; color: var(--muted); margin-top: 4px; font-family: monospace;">
          ${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}
        </div>
        <a class="gmaps-link" href="${gmapsUrl(p)}" target="_blank" rel="noopener">View on Google Maps ↗</a>
      </div>
    `;
    infoWindow.setContent(content);
    infoWindow.open(map, m);
  });
  markers.push(m);

  // Label using OverlayView so we can style it as HTML
  const label2 = makeHTMLLabel({ lat: p.lat, lng: p.lng }, p.name, kind === "own" ? "marker-label own" : "marker-label competitor");
  markers.push(label2);
}

function addImportedPin(p, color, label) {
  const m = new google.maps.Marker({
    position: { lat: p.lat, lng: p.lng }, map,
    title: `Imported: ${p.name}`,
    optimized: true,
    icon: {
      path: google.maps.SymbolPath.CIRCLE,
      scale: 7, fillColor: color, fillOpacity: 1,
      strokeWeight: 2, strokeColor: "#fff",
    },
  });
  m.poiName = p.name;
  m.addListener("click", () => {
    const content = `
      <div style="font-family: 'Inter', sans-serif; padding: 6px; min-width: 150px;">
        <div style="font-size: 11px; font-weight: 700; color: ${color}; text-transform: uppercase; margin-bottom: 2px;">
          🟢 Imported Location
        </div>
        <div style="font-size: 13px; font-weight: 600; color: var(--text);">${escapeHtml(p.name)}</div>
        <div style="font-size: 10px; color: var(--muted); margin-top: 4px; font-family: monospace;">
          ${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}
        </div>
        <a class="gmaps-link" href="${gmapsUrl(p)}" target="_blank" rel="noopener">View on Google Maps ↗</a>
      </div>
    `;
    infoWindow.setContent(content);
    infoWindow.open(map, m);
  });
  importedMarkers.push(m);

  // Label using OverlayView so we can style it as HTML
  const label2 = makeHTMLLabel({ lat: p.lat, lng: p.lng }, p.name, "marker-label own", /*deferred*/ true);
  label2.setMap(map);
  importedMarkers.push(label2);
}

function addRecommendedPin(r, index, data) {
  const m = new google.maps.Marker({
    position: { lat: r.lat, lng: r.lng },
    map,
    title: `Recommended Site #${index + 1}: Score ${r.final}/100`,
    optimized: true,
    label: {
      text: String(index + 1),
      color: "#ffffff",
      fontWeight: "800",
      fontSize: "11px",
    },
    icon: {
      path: google.maps.SymbolPath.CIRCLE,
      scale: 11,
      fillColor: "#1a00d9", // Ganit Blue
      fillOpacity: 1,
      strokeWeight: 2,
      strokeColor: "#ffffff",
    },
  });

  m.addListener("click", () => {
    const h = data.hexes.find(x => x.hex === r.hex);
    if (h) {
      glideToZone(h);
      highlightHexOnMap(h);
      showHexPanel(h, data);
    }

    // Expand the corresponding card in the sidebar
    const cards = document.querySelectorAll("#recList li.tagged-card");
    cards.forEach((li, idx) => {
      if (idx === index) {
        li.classList.add("expanded");
        const details = li.querySelector(".rec-details-panel");
        if (details) details.classList.remove("hidden");
        const chevron = li.querySelector(".rec-card-chevron");
        if (chevron) chevron.textContent = "Hide Details ▴";
        li.scrollIntoView({ behavior: "smooth", block: "nearest" });
      } else {
        li.classList.remove("expanded");
        const details = li.querySelector(".rec-details-panel");
        if (details) details.classList.add("hidden");
        const chevron = li.querySelector(".rec-card-chevron");
        if (chevron) chevron.textContent = "View Details ▾";
      }
    });

    const landmark = r.signals.nearest[0];
    const locDesc = `Near ${landmark ? escapeHtml(landmark.name) : 'Center'}`;
    const content = `
      <div style="font-family: 'Inter', sans-serif; padding: 6px; min-width: 160px;">
        <div style="font-size: 11px; font-weight: 700; color: var(--ganit-blue); text-transform: uppercase; margin-bottom: 2px;">
          ⭐ Recommended Site #${index + 1}
        </div>
        <div style="font-size: 13px; font-weight: 700; color: var(--text);">${escapeHtml(locDesc)}</div>
        <div style="font-size: 12px; font-weight: 600; color: ${scoreColor(r.final)}; margin-top: 4px;">
          Score: ${r.final}/100
        </div>
        <div style="font-size: 10px; color: var(--muted); margin-top: 4px; font-family: monospace;">
          ${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}
        </div>
        <a class="gmaps-link" href="${gmapsUrl(r)}" target="_blank" rel="noopener">View on Google Maps ↗</a>
      </div>
    `;
    infoWindow.setContent(content);
    infoWindow.open(map, m);
  });

  markers.push(m);

  // Overlay HTML label
  const label = makeHTMLLabel(
    { lat: r.lat, lng: r.lng },
    `Site #${index + 1}`,
    "marker-label recommended"
  );
  markers.push(label);
}

// Create an overlay pin + label but DON'T attach to the map yet. The layer
// control attaches/detaches them when the user toggles that amenity type.
function makeOverlayPin(o) {
  const m = new google.maps.Marker({
    position: { lat: o.lat, lng: o.lng },
    title: `${o.label || o.kind}: ${o.name}`,
    optimized: true,
    label: { text: o.icon, fontSize: "16px" },
    icon: {
      path: "M 0,0 m -1,-1 L 1,-1 L 1,1 L -1,1 z",
      scale: 1, fillOpacity: 0, strokeOpacity: 0,
    },
  });
  m.poiName = o.name;
  m.addListener("click", () => {
    infoWindow.setContent(`
      <div style="font-family: 'Inter', sans-serif; padding: 6px; min-width: 150px;">
        <div style="font-size: 11px; font-weight: 700; color: var(--ganit-blue); text-transform: uppercase; margin-bottom: 2px;">
          ${o.icon} ${escapeHtml(o.label || o.kind)}
        </div>
        <div style="font-size: 13px; font-weight: 600; color: var(--text);">${escapeHtml(o.name)}</div>
        <div style="font-size: 10px; color: var(--muted); margin-top: 4px; font-family: monospace;">
          ${o.lat.toFixed(5)}, ${o.lng.toFixed(5)}
        </div>
        <a class="gmaps-link" href="${gmapsUrl(o)}" target="_blank" rel="noopener">View on Google Maps ↗</a>
      </div>`);
    infoWindow.open(map, m);
  });
  const label = makeHTMLLabel({ lat: o.lat, lng: o.lng }, o.name, "marker-label overlay", /*deferred*/ true);
  return { marker: m, label };
}

// Build the "Show on map" dropdown from whatever amenity types are present,
// and wire each to attach/detach its pins. Default: everything OFF.
let _layerGroups = {};   // factorKey → { label, icon, items:[{marker,label}], on:false }
function buildLayerControl(overlay) {
  // tear down any prior layer pins
  for (const k in _layerGroups) for (const it of _layerGroups[k].items) { it.marker.setMap(null); it.label.setMap(null); }
  _layerGroups = {};

  for (const o of overlay) {
    const key = o.factorKey || o.kind || "other";
    if (!_layerGroups[key]) _layerGroups[key] = { label: (o.label || o.kind || "Places").split(" / ")[0], icon: o.icon || "📍", items: [], on: false };
    _layerGroups[key].items.push(makeOverlayPin(o));
  }

  const menu = document.getElementById("layersMenu");
  const keys = Object.keys(_layerGroups);
  if (!keys.length) { menu.innerHTML = `<div class="layers-empty">No nearby landmarks found.</div>`; return; }
  menu.innerHTML = keys.map(k => {
    const g = _layerGroups[k];
    return `<label class="layer-row"><input type="checkbox" data-key="${k}" />
      <span>${g.icon} ${escapeHtml(cap(g.label))}</span><span class="layer-count">${g.items.length}</span></label>`;
  }).join("") + `<div class="layers-hint">Your sites &amp; competitors are always shown.</div>`;

  menu.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.onchange = () => toggleLayer(cb.dataset.key, cb.checked);
  });
}

function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

// --- Cannibalization (client-side) ---------------------------------------
// A recommended site sitting too close to one of the user's OWN existing
// locations risks splitting footfall with itself instead of capturing new
// demand. We compute this on the frontend because the user's real network can
// come from EITHER the backend brand search (data.ownList) OR the imported CSV
// (importedLocationsData) — both live here.
const CANNIBAL_RADII = {
  BFSI_ATM:       { high: 0.4, moderate: 0.9 },
  BFSI_BRANCH:    { high: 0.8, moderate: 1.8 },
  FMCG_RETAIL:    { high: 0.7, moderate: 1.5 },
  FMCG_WAREHOUSE: { high: 3.0, moderate: 6.0 },
};

function haversineKm(aLat, aLng, bLat, bLng) {
  const R = 6371, toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Returns { risk: "HIGH"|"MODERATE"|"NONE", km, name, note } for a recommended
// hex, or null when the user has no own sites to compare against.
function cannibalizationFor(r, data) {
  const own = [...(data.ownList || []), ...(importedLocationsData || [])]
    .filter(o => typeof o.lat === "number" && typeof o.lng === "number");
  if (!own.length) return null;

  const radii = CANNIBAL_RADII[data.vertical] || { high: 0.7, moderate: 1.5 };
  let best = null;
  for (const o of own) {
    const km = haversineKm(r.lat, r.lng, o.lat, o.lng);
    if (!best || km < best.km) best = { km, name: o.name || "your site" };
  }
  const { km, name } = best;
  if (km <= radii.high) {
    return { risk: "HIGH", km, name, note: `${Math.round(km * 1000)} m from your existing "${name}" — high overlap, likely to split footfall.` };
  } else if (km <= radii.moderate) {
    return { risk: "MODERATE", km, name, note: `${km.toFixed(1)} km from your existing "${name}" — some catchment overlap.` };
  }
  return { risk: "NONE", km, name, note: `Nearest own site ("${name}") is ${km.toFixed(1)} km away — distinct catchment.` };
}

function toggleLayer(key, on) {
  const g = _layerGroups[key];
  if (!g) return;
  g.on = on;
  for (const it of g.items) { it.marker.setMap(on ? map : null); it.label.setMap(on ? map : null); }
}

// HTML labels for competitor/own pins. When `deferred` is true the label is NOT
// attached to the map (the layer control attaches it on demand).
function makeHTMLLabel(latLng, text, className, deferred = false) {
  function HTMLLabel(latLng, text, className) {
    this.latLng = latLng;
    this.text = text;
    this.className = className;
    this.div = null;
  }
  HTMLLabel.prototype = new google.maps.OverlayView();
  HTMLLabel.prototype.onAdd = function () {
    const div = document.createElement("div");
    div.className = this.className;
    div.style.position = "absolute";
    div.style.left = "0";
    div.style.top = "0";
    div.style.willChange = "transform";
    div.textContent = this.text.length > 24 ? this.text.slice(0, 22) + "…" : this.text;
    this.div = div;
    this._latLngObj = new google.maps.LatLng(this.latLng.lat, this.latLng.lng);
    // mapPane (markerLayer) repaints far less aggressively than floatPane.
    (this.getPanes().markerLayer || this.getPanes().overlayLayer).appendChild(div);
  };
  HTMLLabel.prototype.draw = function () {
    if (!this.div) return;
    const proj = this.getProjection();
    if (!proj) return;
    const pos = proj.fromLatLngToDivPixel(this._latLngObj);
    // translate3d → GPU-composited, avoids per-frame layout reflow that left/top causes.
    this.div.style.transform = `translate3d(${Math.round(pos.x + 10)}px, ${Math.round(pos.y - 8)}px, 0)`;
  };
  HTMLLabel.prototype.onRemove = function () { this.div?.remove(); };
  HTMLLabel.prototype.setMap2 = google.maps.OverlayView.prototype.setMap;
  const lbl = new HTMLLabel(latLng, text, className);
  if (!deferred) lbl.setMap(map);
  return lbl;
}

function showHexPanel(h, data) {
  const panel = document.getElementById("hexPanel");
  const re = data?.realEstate;
  const listings = (data?.propertyListings || []).slice(0, 3);
  
  // Render Suitability Assessment and Pros/Cons
  const assessmentHTML = renderHexAssessment(h, data);
  
  document.getElementById("hexBody").innerHTML = `
    ${h.signals.noBuild ? `<div class="nobuild-banner">🚫 No-build zone — this area sits on a railway, airport, water body or forest. Not a viable site.</div>` : ""}
    ${h.tag ? `<div class="rec-tag tag-${h.tag}" style="margin-bottom:8px; background: ${scoreColor(h.final)}">${TAG_LABELS[h.tag]}</div>` : ""}
    <div style="margin-bottom: 14px"><span class="final-pill" style="background:${scoreColor(h.final)}">Score ${h.final}/100</span></div>

    <div id="zoneInsight" class="zone-insight loading">
      <div class="zi-spinner"><span class="spinner"></span> Analyzing this zone with AI…</div>
    </div>

    ${assessmentHTML}

    <div class="score-row"><span class="label">Demand</span><span class="v">${h.demand}</span></div>
    <div class="score-row"><span class="label">Free space (low saturation)</span><span class="v">${h.saturation}</span></div>
    <div class="score-row"><span class="label">Accessibility</span><span class="v">${h.access}</span></div>
    <div class="score-row"><span class="label">Future growth (AI)</span><span class="v">${h.growth}</span></div>
    
    <div class="subhead">Zone Statistics</div>
    <div class="score-row"><span class="label">🔴 Competitors</span><span class="v">${h.signals.competitorCount}</span></div>
    <div class="score-row"><span class="label">🟢 Your sites</span><span class="v">${h.signals.ownBrandCount}</span></div>
    <div class="score-row"><span class="label">Distance from center</span><span class="v">${h.signals.distanceKm} km</span></div>
    
    ${(h.signals.nearest && h.signals.nearest.length) ? `
    <div class="subhead">What's nearby</div>
    ${h.signals.nearest.map(n => {
      const dist = (m) => m >= 1000 ? (m/1000).toFixed(1) + " km" : m + " m";
      const moreCount = (n.others || []).length;
      const listText = moreCount ? (n.others).map(o => `• ${escapeHtml(o.name)} (${dist(o.meters)})`).join('<br/>') : "";
      const moreChip = moreCount ? ` <span class="more-chip" onclick="toggleMoreTooltip(event, this)">+${moreCount}<span class="more-tooltip">${listText}</span></span>` : "";
      const link = `<a class="gmaps-inline" href="${gmapsUrl({ name: n.name, id: n.id })}" target="_blank" rel="noopener" title="Open ${escapeHtml(n.name)} on Google Maps">${escapeHtml(n.name)} ↗</a>`;
      return `
      <div class="score-row nearby-row">
        <span class="label">
          <span class="nearby-title">${n.icon} ${escapeHtml(n.label.split(" / ")[0])}${moreChip}</span>
          <span class="nearby-name">${link}</span>
        </span>
        <span class="v">${dist(n.meters)}</span>
      </div>`;
    }).join("")}
    ` : ""}
    ${re ? `
    <div class="subhead">Real-estate signals</div>
    ${re.medianPricePerSqft != null ? `<div class="score-row"><span class="label">Median ₹/sqft</span><span class="v">₹${Math.round(re.medianPricePerSqft).toLocaleString("en-IN")}</span></div>` : ""}
    ${re.avgBHK != null ? `<div class="score-row"><span class="label">Avg config</span><span class="v">${re.avgBHK.toFixed(1)} BHK</span></div>` : ""}
    ${re.underConstructionShare ? `<div class="score-row"><span class="label">% under-construction</span><span class="v">${Math.round(re.underConstructionShare * 100)}%</span></div>` : ""}
    <div class="score-row"><span class="label">Listings analyzed</span><span class="v">${re.sampleSize ?? 0}</span></div>
    ` : ""}
    ${listings.length ? `
    <div class="subhead">Properties for sale near here</div>
    ${listings.map(l => `
      <div class="listing">
        <div class="lst-title">${escapeHtml(l.title || "Property listing")}</div>
        <div class="lst-meta">
          ${l.price ? `₹${Number(l.price).toLocaleString("en-IN")} · ` : ""}
          ${l.bhk ? `${l.bhk} BHK · ` : ""}
          ${l.pricePerSqft ? `₹${Math.round(l.pricePerSqft)}/sqft · ` : ""}
          ${l.url ? `<a href="${escapeHtml(l.url)}" target="_blank" rel="noopener">View</a>` : ""}
        </div>
      </div>`).join("")}
    ` : ""}
    <div style="margin-top:12px; font-size:11px; color:var(--muted); font-family: ui-monospace, monospace">
      Coordinates: ${h.lat.toFixed(5)}, ${h.lng.toFixed(5)}
    </div>`;
  // Animate only on a fresh open (hidden → visible). Switching between zones
  // while the panel is already open should NOT replay the slide-in.
  const wasHidden = panel.classList.contains("hidden");
  panel.classList.remove("hidden");
  if (wasHidden) {
    panel.classList.remove("just-opened");
    void panel.offsetWidth;            // restart the animation cleanly
    panel.classList.add("just-opened");
  }
  panel.scrollTop = 0;
  fetchZoneInsight(h, data);
}

// Fetch the on-demand AI verdict for a clicked zone and render it.
let _zoneInsightSeq = 0;
async function fetchZoneInsight(h, data) {
  const seq = ++_zoneInsightSeq;        // guard against out-of-order responses
  const el = document.getElementById("zoneInsight");
  if (!el) return;
  const facts = {
    vertical: data?.vertical || document.getElementById("vertical").value,
    area: data?.geo?.area || "",
    city: data?.geo?.city || "",
    lat: h.lat, lng: h.lng,
    final: h.final, demand: h.demand, saturation: h.saturation, access: h.access, growth: h.growth,
    competitorCount: h.signals.competitorCount, ownBrandCount: h.signals.ownBrandCount,
    pricePerSqft: h.signals.pricePerSqft ?? null,
    distanceKm: h.signals.distanceKm,
    nearest: (h.signals.nearest || []).map(n => ({ label: n.label, meters: n.meters, sign: n.sign })),
    placeQuality: data?.placeQuality || null,
  };
  try {
    const resp = await fetch(`${RUN}/zone-insight`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(facts),
    });
    if (!resp.ok) throw new Error(await resp.text());
    const ins = await resp.json();
    if (seq !== _zoneInsightSeq) return;  // a newer zone was clicked; ignore
    renderZoneInsight(ins);
  } catch (e) {
    if (seq !== _zoneInsightSeq) return;
    const el2 = document.getElementById("zoneInsight");
    if (el2) { el2.className = "zone-insight"; el2.innerHTML = `<div class="zi-error">AI insight unavailable right now.</div>`; }
  }
}

function renderZoneInsight(ins) {
  const el = document.getElementById("zoneInsight");
  if (!el) return;
  const v = ins.verdict || "CONSIDER";
  el.className = `zone-insight verdict-${v}`;
  el.innerHTML = `
    <div class="zi-head">
      <span class="zi-badge ${v}">${v === "OPEN" ? "✅ OPEN HERE" : v === "AVOID" ? "⛔ AVOID" : "🤔 CONSIDER"}</span>
    </div>
    <div class="zi-headline">${mdBold(ins.headline || "")}</div>
    ${(ins.reasoning && ins.reasoning.length) ? `
      <div class="zi-section-label">Why${v === "AVOID" ? " not" : ""}</div>
      <ul class="zi-reasons">${ins.reasoning.slice(0, 4).map(r => `<li>${mdBold(r)}</li>`).join("")}</ul>` : ""}
    ${(ins.facts && ins.facts.length) ? `
      <div class="zi-section-label">The facts</div>
      <ul class="zi-facts">${ins.facts.slice(0, 4).map(f => `<li>${mdBold(f)}</li>`).join("")}</ul>` : ""}
    ${ins.bottomLine ? `<div class="zi-bottom">${mdBold(ins.bottomLine)}</div>` : ""}
    ${(ins.sources && ins.sources.length) ? `
      <div class="zi-sources">Sources: ${ins.sources.slice(0, 4).map(s => `<a href="${escapeHtml(s.uri)}" target="_blank" rel="noopener">${escapeHtml(s.title || "link")}</a>`).join(" · ")}</div>` : ""}
  `;
}

function clearMap() {
  for (const p of hexPolygons) p.setMap(null);
  for (const m of markers) m.setMap(null);
  hexPolygons = []; markers = [];
  // tear down toggleable layer pins too
  for (const k in _layerGroups) for (const it of _layerGroups[k].items) { it.marker.setMap(null); it.label.setMap(null); }
  _layerGroups = {};
  if (selectedPolyHighlight) {
    selectedPolyHighlight.setMap(null);
    selectedPolyHighlight = null;
  }
  document.getElementById("hexPanel").classList.add("hidden");
  const menu = document.getElementById("layersMenu");
  if (menu) menu.innerHTML = '<div class="layers-empty">Please search for a location first</div>';
}

// Smoothly glide the map from the current zone to the clicked one, easing in a
// touch of zoom so the move feels like travelling between zones.
function glideToZone(h) {
  if (!map) return;
  const target = { lat: h.lat, lng: h.lng };
  map.panTo(target);            // built-in eased pan
  // Gentle dolly-in, but not too tight — 15 keeps the surrounding zones visible.
  const desired = 15;
  const cur = map.getZoom() ?? 14;
  if (cur < desired) {
    setTimeout(() => { if ((map.getZoom() ?? 14) < desired) map.setZoom(desired); }, 240);
  }
}

function highlightHexOnMap(h) {
  if (selectedPolyHighlight) {
    selectedPolyHighlight.setMap(null);
  }
  const boundary = window.h3.cellToBoundary(h.hex, true);
  const path = boundary.map(([lng, lat]) => ({ lat, lng }));
  selectedPolyHighlight = new google.maps.Polygon({
    paths: path,
    strokeWeight: 4,
    strokeColor: "#1a2b8c", // Ganit Blue for visual highlight
    strokeOpacity: 0.9,
    fillColor: "#1a2b8c",
    fillOpacity: 0.08,
    zIndex: 1000,
    map: map,
    clickable: false
  });
}

function getPaletteStops(/* theme */) {
  // Heatmap palette is LOCKED to a single green→red scale (theme switching is
  // intentionally disabled — see the commented alternatives below). Thresholds
  // are shifted "harder" so red/orange covers more of the range: a 50/100 zone
  // reads orange, not neutral, and only genuinely strong zones (70+) go green.
  return [
    [0,   [214, 47, 47]],    // Avoid — clear red
    [30,  [233, 105, 60]],   // Weak — red-orange
    [45,  [240, 160, 70]],   // Marginal — orange
    [58,  [235, 205, 90]],   // Decent — amber/yellow
    [70,  [150, 200, 100]],  // Fair — yellow-green
    [82,  [70, 180, 95]],    // Strong — green
    [100, [25, 135, 70]],    // Best — deep green
  ];

  /* --- Disabled alternative themes (kept for future re-enable) ---
  if (theme === "vivid")   return [[0,[239,68,68]],[35,[249,115,22]],[50,[234,179,8]],[65,[132,204,22]],[80,[34,197,94]],[100,[21,128,61]]];
  if (theme === "ganit")   return [[0,[230,120,90]],[35,[244,160,100]],[50,[210,200,170]],[65,[120,140,220]],[80,[60,70,200]],[100,[26,0,217]]];
  if (theme === "colorblind") return [[0,[70,110,200]],[35,[120,160,220]],[50,[200,200,200]],[65,[240,210,120]],[80,[240,180,40]],[100,[200,140,0]]];
  */
}

function scoreColor(s) {
  const stops = getPaletteStops(currentTheme);
  for (let i = 1; i < stops.length; i++) {
    const [a, b] = [stops[i-1], stops[i]];
    if (s <= b[0]) {
      const t = (s - a[0]) / (b[0] - a[0]);
      const c = a[1].map((ai, k) => Math.round(ai + (b[1][k] - ai) * t));
      return `rgb(${c[0]},${c[1]},${c[2]})`;
    }
  }
  const lastStop = stops[stops.length-1][1];
  return `rgb(${lastStop[0]},${lastStop[1]},${lastStop[2]})`;
}

// Single source of truth for hex appearance. Opacity scales with score so the
// best regions read as "highlighted", but the ceiling is kept LOW (~0.42) so the
// underlying map (roads, labels, satellite) stays visible — the earlier 0.7 made
// strong hexes opaque slabs.
function hexStyle(score) {
  const t = Math.max(0, Math.min(1, score / 100));
  const topTier = score >= 75;
  return {
    // Darker, more readable fills (was 0.06→0.42). Map still shows through.
    fillOpacity: 0.22 + Math.pow(t, 1.3) * 0.45,   // ~0.22 (weak) → ~0.67 (best)
    strokeOpacity: topTier ? 1 : 0.55 + t * 0.4,
    strokeWeight: topTier ? 2.5 : 1.2,
  };
}

function redrawHeatmap() {
  if (!lastResult) return;
  for (let i = 0; i < hexPolygons.length; i++) {
    const poly = hexPolygons[i];
    if (poly.h) {
      const color = scoreColor(poly.h.final);
      const s = hexStyle(poly.h.final);
      poly.setOptions({
        strokeColor: color,
        fillColor: color,
        fillOpacity: s.fillOpacity,
        strokeOpacity: s.strokeOpacity,
        strokeWeight: s.strokeWeight,
      });
    }
  }
}

function updateLegendSwatches() {
  const stops = getPaletteStops(currentTheme);
  const fmt = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
  document.getElementById("swatch-excellent").style.background = fmt(stops[4][1]);
  document.getElementById("swatch-strong").style.background = fmt(stops[3][1]);
  document.getElementById("swatch-decent").style.background = fmt(stops[2][1]);
  document.getElementById("swatch-marginal").style.background = fmt(stops[1][1]);
  document.getElementById("swatch-avoid").style.background = fmt(stops[0][1]);
}

function renderExpandedDetails(r, data) {
  const bullets = [];
  
  // 1. Tag specific reason
  bullets.push(`
    <div class="rec-detail-bullet">
      <span class="icon">🎯</span>
      <div><strong>Analysis Reason:</strong> ${escapeHtml(r.tagReason || "Highly viable site selection.")}</div>
    </div>
  `);
  
  // 2. Specific Nearby Amenities with names (clickable links to map) + "+N more"
  r.signals.nearest.forEach(n => {
    const dist = (m) => m >= 1000 ? (m/1000).toFixed(1) + " km" : m + " m";
    const moreCount = (n.others || []).length;
    const listText = moreCount ? (n.others).map(o => `• ${escapeHtml(o.name)} (${dist(o.meters)})`).join('<br/>') : "";
    const moreChip = moreCount
      ? ` <span class="more-chip" onclick="toggleMoreTooltip(event, this)">+${moreCount} more<span class="more-tooltip">${listText}</span></span>`
      : "";
    bullets.push(`
      <div class="rec-detail-bullet">
        <span class="icon">${n.icon}</span>
        <div>
          <strong>${escapeHtml(n.label.split(" / ")[0])}:</strong>
          <a class="amenity-link" data-name="${escapeHtml(n.name)}" data-key="${n.factorKey}">${escapeHtml(n.name)}</a>
          (${dist(n.meters)} away)${moreChip}
        </div>
      </div>
    `);
  });
  
  // 3. Competitor and Own Sites
  const compPhrase = r.signals.competitorCount === 0 
    ? "Zero competitor outlets within immediate proximity (Highly Underserved market)" 
    : `${r.signals.competitorCount} competitor locations within proximity`;
    
  bullets.push(`
    <div class="rec-detail-bullet">
      <span class="icon">📊</span>
      <div>
        <strong>Local Supply Density:</strong> ${compPhrase}, with ${r.signals.ownBrandCount} of your own operational sites.
      </div>
    </div>
  `);

  // 3b. Cannibalization vs. the user's own existing network (if any imported/found)
  const cann = cannibalizationFor(r, data);
  if (cann && cann.risk !== "NONE") {
    const icon = cann.risk === "HIGH" ? "⚠️" : "🔶";
    const color = cann.risk === "HIGH" ? "#dc2626" : "#d97706";
    bullets.push(`
      <div class="rec-detail-bullet">
        <span class="icon">${icon}</span>
        <div>
          <strong style="color:${color}">Cannibalization ${cap(cann.risk.toLowerCase())} risk:</strong>
          ${escapeHtml(cann.note)}
        </div>
      </div>
    `);
  }

  // 4. Real estate details if available
  if (data.realEstate && data.realEstate.medianPricePerSqft) {
    bullets.push(`
      <div class="rec-detail-bullet">
        <span class="icon">💰</span>
        <div>
          <strong>Demographics & Property:</strong> Area benchmark pricing is 
          ₹${Math.round(data.realEstate.medianPricePerSqft).toLocaleString("en-IN")}/sqft 
          (${data.realEstate.sampleSize} area data-points scraping verified).
        </div>
      </div>
    `);
  }

  // Subscores mini bar charts
  const scColor = scoreColor(r.final);
  const subscoresHTML = `
    <div class="rec-subscores">
      <div class="rec-subscore-item">
        <span class="label">Local Demand (${r.demand})</span>
        <div class="rec-subscore-bar-bg">
          <div class="rec-subscore-bar-fg" style="width: ${r.demand}%; background: ${scoreColor(r.demand)}"></div>
        </div>
      </div>
      <div class="rec-subscore-item">
        <span class="label">Underserved Market (${r.saturation})</span>
        <div class="rec-subscore-bar-bg">
          <div class="rec-subscore-bar-fg" style="width: ${r.saturation}%; background: ${scoreColor(r.saturation)}"></div>
        </div>
      </div>
      <div class="rec-subscore-item">
        <span class="label">Accessibility (${r.access})</span>
        <div class="rec-subscore-bar-bg">
          <div class="rec-subscore-bar-fg" style="width: ${r.access}%; background: ${scoreColor(r.access)}"></div>
        </div>
      </div>
      <div class="rec-subscore-item">
        <span class="label">AI Growth Forecast (${r.growth})</span>
        <div class="rec-subscore-bar-bg">
          <div class="rec-subscore-bar-fg" style="width: ${r.growth}%; background: ${scoreColor(r.growth)}"></div>
        </div>
      </div>
    </div>
  `;

  return `
    <div class="rec-details-panel hidden">
      ${bullets.join("")}
      ${subscoresHTML}
      <div class="rec-coords" style="margin-top: 4px;">Cell Coordinates: ${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}</div>
    </div>
  `;
}

function renderHexAssessment(h, data) {
  let statusClass = "caution";
  let statusText = "Proceed with Caution";
  if (h.final >= 75) {
    statusClass = "go";
    statusText = "Highly Recommended";
  } else if (h.final < 50) {
    statusClass = "avoid";
    statusText = "Not Recommended";
  }

  const pros = [];
  const cons = [];

  // Demand pros/cons
  if (h.demand >= 65) {
    pros.push(`High consumer demand index (score: ${h.demand}/100) indicating strong local target demographic.`);
  } else if (h.demand < 45) {
    cons.push(`Muted local demand footprint (score: ${h.demand}/100) indicating limited footfall capture potential.`);
  }

  // Access pros/cons
  if (h.access >= 65) {
    pros.push(`Excellent transit connectivity (score: ${h.access}/100) ensuring seamless customer accessibility.`);
  } else if (h.access < 45) {
    cons.push(`Sub-par transport infrastructure or poor arterial visibility (score: ${h.access}/100).`);
  }

  // Growth pros/cons
  if (h.growth >= 65) {
    pros.push(`Stellar future expansion projection (score: ${h.growth}/100) backed by regional commercial pipelines.`);
  } else if (h.growth < 45) {
    cons.push(`Low future development index (score: ${h.growth}/100), suggesting a stagnant commercial sub-market.`);
  }

  // Saturation pros/cons
  if (h.signals.competitorCount === 0) {
    pros.push("Market Opportunity: Zero active competitor locations within the immediate local sector.");
  } else if (h.signals.competitorCount > 2) {
    cons.push(`Competitor Density: ${h.signals.competitorCount} direct rival outlets pose high market share diluting risk.`);
  }

  // Proximity details
  const nearestMetro = h.signals.nearest.find(n => n.factorKey === "metro");
  if (nearestMetro && nearestMetro.meters <= 450) {
    pros.push(`Transit Anchor: Highly accessible, situated only ${nearestMetro.meters}m from ${nearestMetro.name}.`);
  }

  const nearestResidential = h.signals.nearest.find(n => n.factorKey === "residential");
  if (nearestResidential && nearestResidential.meters <= 450) {
    pros.push(`Demographic Catchment: Located near active residential complexes (${nearestResidential.name}).`);
  }

  return `
    <div class="assessment-section">
      <div class="assessment-badge ${statusClass}">${statusText}</div>
      <ul class="assessment-list">
        ${pros.map(p => `<li class="pro">${escapeHtml(p)}</li>`).join("")}
        ${cons.map(c => `<li class="con">${escapeHtml(c)}</li>`).join("")}
        ${pros.length === 0 && cons.length === 0 ? "<li>Stable localized viability index. Review nearby context overlays.</li>" : ""}
      </ul>
    </div>
  `;
}

// ---------- Compare locations ----------

// Build a compact, comparable snapshot from a full analysis result.
function compareSnapshot(data) {
  const recs = data.recommendations || [];
  const best = recs[0]?.final ?? Math.max(0, ...(data.hexes || []).map(h => h.final));
  const avg = (data.hexes && data.hexes.length)
    ? Math.round(data.hexes.reduce((a, h) => a + h.final, 0) / data.hexes.length) : 0;
  // Average the recommended zones' sub-scores so the comparison reflects the
  // *opportunity* zones, not the whole (mostly empty) bbox.
  const avgOf = (key) => recs.length ? Math.round(recs.reduce((a, r) => a + (r[key] || 0), 0) / recs.length) : 0;
  // Count HIGH-risk cannibalization among the top recs for this location.
  const highCann = recs.filter(r => {
    const c = cannibalizationFor(r, data);
    return c && c.risk === "HIGH";
  }).length;

  return {
    name: data.geo?.area || data.geo?.city || "Location",
    address: data.geo?.formattedAddress || "",
    vertical: data.vertical,
    company: data.company?.name || null,
    bestScore: best,
    avgScore: avg,
    demand: avgOf("demand"),
    saturation: avgOf("saturation"),
    access: avgOf("access"),
    growth: data.agent?.growthScore ?? avgOf("growth"),
    recommendation: data.agent?.executive?.recommendation || "CAUTION",
    rating: data.agent?.executive?.rating ?? null,
    competitors: data.counts?.competitors ?? (data.competitorsList?.length || 0),
    ownSites: (data.ownList?.length || 0) + (importedLocationsData?.length || 0),
    pricePerSqft: data.realEstate?.medianPricePerSqft ?? null,
    highCannibalization: highCann,
  };
}

function addCurrentToCompare() {
  if (!lastResult) return;
  const snap = compareSnapshot(lastResult);
  // Replace an existing entry for the same area+vertical instead of duplicating.
  const key = (s) => `${s.name}|${s.vertical}`;
  const idx = comparedSites.findIndex(s => key(s) === key(snap));
  if (idx >= 0) comparedSites[idx] = snap; else comparedSites.push(snap);
  if (comparedSites.length > 4) comparedSites = comparedSites.slice(-4); // keep last 4

  updateCompareButton();
  const btn = document.getElementById("addCompareBtn");
  if (btn) {
    const original = btn.innerHTML;
    btn.innerHTML = `<i class="uil uil-check-circle"></i>Added — ${comparedSites.length} in compare`;
    setTimeout(() => { btn.innerHTML = original; }, 1800);
  }
}

function updateCompareButton() {
  // Compare feature is currently HIDDEN. Keep the top-bar button hidden
  // regardless of state. (Remove this early-return to re-enable.)
  const btn = document.getElementById("compareBtn");
  if (btn) btn.classList.add("hidden");
  return;
  /* eslint-disable no-unreachable */
  const count = document.getElementById("compareCount");
  if (count) count.textContent = String(comparedSites.length);
  if (btn) btn.classList.toggle("hidden", comparedSites.length < 1);
}

function removeFromCompare(i) {
  comparedSites.splice(i, 1);
  updateCompareButton();
  if (comparedSites.length === 0) {
    document.getElementById("compareModal").classList.add("hidden");
  } else {
    openCompareModal();
  }
}
window.removeFromCompare = removeFromCompare;

function openCompareModal() {
  if (!comparedSites.length) return;
  document.getElementById("compareContent").innerHTML = renderCompareTable(comparedSites);
  document.getElementById("compareModal").classList.remove("hidden");
}

// Each row is a metric; columns are the locations. The winner of each row gets
// a `.win` highlight. higherIsBetter controls the direction.
function renderCompareTable(sites) {
  const fmtPrice = (v) => v ? "₹" + Math.round(v).toLocaleString("en-IN") : "—";
  const rows = [
    { label: "Best zone score", key: "bestScore", better: "high", fmt: v => `${v}/100` },
    { label: "Avg zone score",  key: "avgScore",  better: "high", fmt: v => `${v}/100` },
    { label: "Demand",          key: "demand",    better: "high", fmt: v => `${v}` },
    { label: "Free space (low competition)", key: "saturation", better: "high", fmt: v => `${v}` },
    { label: "Accessibility",   key: "access",    better: "high", fmt: v => `${v}` },
    { label: "Growth outlook",  key: "growth",    better: "high", fmt: v => `${v}/100` },
    { label: "Competitors nearby", key: "competitors", better: "low", fmt: v => `${v}` },
    { label: "Your sites nearby",  key: "ownSites",    better: "low", fmt: v => `${v}` },
    { label: "High-overlap recs",  key: "highCannibalization", better: "low", fmt: v => v ? `⚠️ ${v}` : "0" },
    { label: "Area ₹/sqft",     key: "pricePerSqft", better: "neutral", fmt: fmtPrice },
  ];

  // Determine an overall winner by best zone score (the headline metric).
  let winnerIdx = 0;
  sites.forEach((s, i) => { if (s.bestScore > sites[winnerIdx].bestScore) winnerIdx = i; });

  const header = `
    <tr>
      <th class="metric-col">Metric</th>
      ${sites.map((s, i) => `
        <th class="${i === winnerIdx ? "col-winner" : ""}">
          <div class="cmp-loc-name">${escapeHtml(s.name)}${i === winnerIdx ? ' <span class="cmp-crown">🏆</span>' : ""}</div>
          <div class="cmp-loc-sub">${escapeHtml((s.vertical || "").replace("_", " "))}${s.company ? " · " + escapeHtml(s.company) : ""}</div>
          <div class="cmp-loc-rec rec-${(s.recommendation || "").toLowerCase()}">${recommendationLabel(s.recommendation)}</div>
          <button class="cmp-remove" onclick="removeFromCompare(${i})" title="Remove">×</button>
        </th>`).join("")}
    </tr>`;

  const body = rows.map(row => {
    const vals = sites.map(s => s[row.key]);
    const numeric = vals.map(v => (typeof v === "number" ? v : null));
    let winVal = null;
    if (row.better === "high") winVal = Math.max(...numeric.filter(v => v != null));
    else if (row.better === "low") winVal = Math.min(...numeric.filter(v => v != null));
    // Only mark a winner when values actually differ.
    const allSame = numeric.every(v => v === numeric[0]);
    return `
      <tr>
        <td class="metric-col">${row.label}</td>
        ${sites.map((s, i) => {
          const v = s[row.key];
          const isWin = row.better !== "neutral" && !allSame && v != null && v === winVal;
          return `<td class="${isWin ? "win" : ""} ${i === winnerIdx ? "col-winner" : ""}">${row.fmt(v)}</td>`;
        }).join("")}
      </tr>`;
  }).join("");

  return `
    <div class="compare-table-wrap">
      <table class="compare-table">
        <thead>${header}</thead>
        <tbody>${body}</tbody>
      </table>
    </div>
    <div class="compare-foot">🏆 = leading location overall (by best zone score). Green cell = best in that row.</div>
  `;
}

// A compact stat strip of REAL signals we already collect but never surfaced in
// the exec summary: live population + density (WorldPop), and competitor health
// from Google Places (avg rating, review volume, share of shuttered businesses).
function renderMarketSnapshot(data) {
  const pop = data.population;
  const pq = data.placeQuality;
  const cards = [];

  const fmtInt = (n) => Math.round(n).toLocaleString("en-IN");

  if (pop && pop.totalPopulation > 0) {
    cards.push(`
      <div class="ms-card">
        <div class="ms-label">Area Population</div>
        <div class="ms-value">${fmtInt(pop.totalPopulation)}</div>
        <div class="ms-sub">WorldPop ${pop.year ?? ""}</div>
      </div>`);
    cards.push(`
      <div class="ms-card">
        <div class="ms-label">Population Density</div>
        <div class="ms-value">${fmtInt(pop.densityPerKm2)}</div>
        <div class="ms-sub">people / km²</div>
      </div>`);
  }

  if (pq) {
    if (pq.avgRating != null) {
      cards.push(`
        <div class="ms-card">
          <div class="ms-label">Avg Competitor Rating</div>
          <div class="ms-value">${pq.avgRating.toFixed(1)} ★</div>
          <div class="ms-sub">across nearby ${escapeHtml((data.vertical || "").replace("_", " ").toLowerCase())}</div>
        </div>`);
    }
    if (pq.totalReviews > 0) {
      cards.push(`
        <div class="ms-card">
          <div class="ms-label">Footfall (Reviews)</div>
          <div class="ms-value">${fmtInt(pq.totalReviews)}</div>
          <div class="ms-sub">total Google reviews nearby</div>
        </div>`);
    }
    // Closed-business share: a high value signals a declining high street.
    const closedPct = Math.round((pq.closedShare || 0) * 100);
    if (pq.closedShare != null) {
      const tone = closedPct >= 20 ? "var(--bad)" : closedPct >= 10 ? "var(--warn)" : "var(--good)";
      cards.push(`
        <div class="ms-card">
          <div class="ms-label">Shuttered Businesses</div>
          <div class="ms-value" style="color:${tone}">${closedPct}%</div>
          <div class="ms-sub">permanently closed nearby</div>
        </div>`);
    }
  }

  if (!cards.length) return "";
  return `
    <div class="eb-section">
      <h4>📈 Market snapshot</h4>
      <div class="market-snapshot">${cards.join("")}</div>
    </div>`;
}

// ---------- Executive Modal ----------
function openExecModal() {
  if (!lastResult) return;
  const ex = lastResult.agent.executive || {};
  const stars = "★".repeat(ex.rating || 3) + "☆".repeat(5 - (ex.rating || 3));
  const quads = lastResult.agent.quadrantScores || [];
  
  // Build Site Comparison Matrix
  const recs = lastResult.recommendations || [];
  const comparisonRows = recs.map((r, i) => {
    let recStatus = "Proceed with Caution";
    let recColor = "var(--warn)";
    if (r.final >= 75) { recStatus = "Highly Recommended"; recColor = "var(--good)"; }
    else if (r.final < 50) { recStatus = "Not Recommended"; recColor = "var(--bad)"; }
    
    const landmark = r.signals.nearest[0];
    const quadLabel = (r.lat >= lastResult.geo.lat ? "North" : "South") + "-" + (r.lng >= lastResult.geo.lng ? "East" : "West");
    const locDesc = `Near ${landmark ? landmark.name : 'Center'} (${quadLabel})`;

    return `
      <tr>
        <td style="padding: 10px; font-weight: 700; border-bottom: 1px solid var(--border); font-size: 11.5px; white-space: nowrap;">
          <span style="border-left: 3px solid ${scoreColor(r.final)}; padding-left: 6px; white-space: nowrap;">Site #${i + 1}</span>
        </td>
        <td style="padding: 10px; border-bottom: 1px solid var(--border);"><span style="background: ${scoreColor(r.final)}; color: #fff; padding: 2px 6px; border-radius: 4px; font-weight: bold; font-size: 11px;">${r.final}/100</span></td>
        <td style="padding: 10px; border-bottom: 1px solid var(--border); font-weight: 500; font-size: 12px;">${escapeHtml(locDesc)}</td>
        <td style="padding: 10px; border-bottom: 1px solid var(--border); font-size: 11px; color: var(--muted);">${escapeHtml(r.signals.proximityPhrase || "N/A")}</td>
        <td style="padding: 10px; border-bottom: 1px solid var(--border); text-align: center; font-weight: bold; font-size: 12px;">${r.signals.competitorCount}</td>
        <td style="padding: 10px; border-bottom: 1px solid var(--border); font-weight: 700; font-size: 11.5px; color: ${recColor};">${recStatus}</td>
      </tr>
    `;
  }).join("");

  const comparisonTable = `
    <div style="overflow-x: auto; border: 1px solid var(--border); border-radius: 8px;">
      <table style="width: 100%; border-collapse: collapse; text-align: left; font-size: 12.5px;">
        <thead>
          <tr style="background: var(--bg-2); border-bottom: 2px solid var(--border); color: var(--ganit-blue);">
            <th style="padding: 10px; font-weight: 700;">Site Tag</th>
            <th style="padding: 10px; font-weight: 700;">Score</th>
            <th style="padding: 10px; font-weight: 700;">Location Sector</th>
            <th style="padding: 10px; font-weight: 700;">Key Proximities</th>
            <th style="padding: 10px; font-weight: 700; text-align: center;">Competitors</th>
            <th style="padding: 10px; font-weight: 700;">Recommendation</th>
          </tr>
        </thead>
        <tbody>
          ${comparisonRows}
        </tbody>
      </table>
    </div>
  `;

  // Build Real Estate trends
  const re = lastResult.realEstate;
  const realEstateHTML = re ? `
    <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-top: 10px;">
      <div style="background: var(--bg-2); padding: 12px; border-radius: 8px; border: 1px solid var(--border);">
        <div style="font-size: 10px; color: var(--muted); text-transform: uppercase; font-weight: 700; letter-spacing: 0.5px;">Median Property Price${re.aiEstimated ? ' <span style="color: var(--ganit-orange);">· AI estimate</span>' : ''}</div>
        <div style="font-size: 18px; font-weight: 800; color: var(--ganit-blue); margin-top: 4px;">₹${Math.round(re.medianPricePerSqft).toLocaleString("en-IN")}/sqft</div>
      </div>
      <div style="background: var(--bg-2); padding: 12px; border-radius: 8px; border: 1px solid var(--border);">
        <div style="font-size: 10px; color: var(--muted); text-transform: uppercase; font-weight: 700; letter-spacing: 0.5px;">Average Configuration</div>
        <div style="font-size: 18px; font-weight: 800; color: var(--ganit-blue); margin-top: 4px;">${re.avgBHK?.toFixed(1) || "N/A"} BHK Layout</div>
      </div>
      <div style="background: var(--bg-2); padding: 12px; border-radius: 8px; border: 1px solid var(--border);">
        <div style="font-size: 10px; color: var(--muted); text-transform: uppercase; font-weight: 700; letter-spacing: 0.5px;">Under-Construction Share</div>
        <div style="font-size: 18px; font-weight: 800; color: var(--ganit-blue); margin-top: 4px;">${Math.round(re.underConstructionShare * 100)}% of listings</div>
      </div>
    </div>
  ` : `<div style="padding: 12px; font-size:12px; color: var(--muted);">No neighborhood real-estate scraping index cache available.</div>`;

  const wikiBlurb = lastResult.wiki?.summary ? escapeHtml(lastResult.wiki.summary) : "No regional geographical summary details were cached on Wikipedia for this locality boundary.";

  document.getElementById("execContent").innerHTML = `
    <div class="exec-head">
      <div class="eh-area">${escapeHtml(lastResult.geo.area || lastResult.geo.city)}</div>
      <div class="eh-sub">${escapeHtml(lastResult.geo.formattedAddress)} · ${escapeHtml(lastResult.vertical.replace("_", " — "))} · ${escapeHtml(lastResult.company?.name || "no company selected")}</div>
      <div class="exec-head-row">
        <div>
          <div style="font-size:11px; opacity:0.7; letter-spacing:1px; text-transform:uppercase">Opportunity rating</div>
          <div class="eh-stars">${stars}</div>
        </div>
        <div class="eh-rec ${ex.recommendation || 'CAUTION'}">
          ${ex.recommendation === "GO" ? "🟢 Highly Recommended" : ex.recommendation === "AVOID" ? "🔴 Not Recommended" : "🟡 Proceed with Caution"}
        </div>
      </div>
    </div>
    
    <div class="exec-body" style="max-height: 58vh; overflow-y: auto;">
      <div class="exec-toolbar">
        <div class="exec-tabs">
          <button id="execTabSummary" class="primary mini"><i class="uil uil-file-alt"></i>Summary Insights</button>
          <button id="execTabDetails" class="ghost mini"><i class="uil uil-search"></i>Detailed Site Metrics</button>
        </div>
        <div class="exec-actions">
          <button id="savePdfBtn" class="primary mini">Save as PDF</button>
          <button id="saveWordBtn" class="ghost mini">Save as Word</button>
        </div>
      </div>

      <!-- View 1: Summary -->
      <div id="execSummaryView">
        ${renderMarketSnapshot(lastResult)}

        ${ex.marketState ? `
        <div class="eb-section">
          <h4>📍 Market reality</h4>
          <div class="bottom-line">${boldKeywords(ex.marketState)}</div>
        </div>` : ""}

        <div class="eb-section drivers">
          <h4>✅ Growth drivers</h4>
          ${(ex.drivers || []).map(d => `
            <div class="driver">
              <div class="icon">✓</div>
              <div>
                <div class="d-headline">${boldKeywords(d.headline)}</div>
                <div class="d-detail">${boldKeywords(d.detail)}</div>
              </div>
            </div>`).join("") || "<em>(none identified)</em>"}
        </div>
  
        <div class="eb-section risks">
          <h4>⚠️ Risks &amp; concerns</h4>
          ${(ex.risks || []).map(r => `
            <div class="risk">
              <div class="icon">!</div>
              <div>
                <div class="d-headline">${boldKeywords(r.headline)}</div>
                <div class="d-detail">${boldKeywords(r.detail)}</div>
              </div>
            </div>`).join("") || "<em>(none identified)</em>"}
        </div>
  
        <div class="eb-section">
          <h4>📊 Sub-area breakdown</h4>
          <div class="context-meta">
            ${quads.map(q => `<div class="cm-item"><strong>${q.quadrant}</strong> ${q.growthScore}/100 — ${escapeHtml(q.headline || "—")}</div>`).join("")}
          </div>
        </div>
  
        ${(ex.alternatives && ex.alternatives.length) ? `
        <div class="eb-section">
          <h4>↪ Where to expand instead</h4>
          <div class="alts-list">
            ${ex.alternatives.map(a => `<div class="alt-item">${boldKeywords(a)}</div>`).join("")}
          </div>
        </div>` : ""}

        <div class="eb-section">
          <h4>🎯 Bottom line</h4>
          <ul class="bl-points">${bulletize(ex.bottomLine || "").map(b => `<li>${boldKeywords(b)}</li>`).join("") || "<li>—</li>"}</ul>
        </div>
      </div>

      <!-- View 2: Detailed Site Metrics -->
      <div id="execDetailsView" class="hidden">
        <div class="eb-section">
          <h4>📍 Suitability Comparison Matrix</h4>
          <p style="font-size: 12px; color: var(--muted); margin-bottom: 12px;">Side-by-side suitability and proximity comparison matrix for the selected sites.</p>
          ${comparisonTable}
        </div>
        
        ${(re && re.medianPricePerSqft > 0) ? `
        <div class="eb-section" style="margin-top: 24px;">
          <h4>🏘️ Local Real Estate Indicators</h4>
          ${realEstateHTML}
        </div>` : ""}

        <div class="eb-section" style="margin-top: 24px;">
          <h4>📖 Regional Background Summary</h4>
          <p style="font-size: 13px; line-height: 1.55; color: var(--text-2); background: var(--bg-2); padding: 12px; border-radius: 8px; border: 1px solid var(--border);">${wikiBlurb}</p>
        </div>
      </div>
    </div>`;

  // Bind tab switching logic
  const tabSum = document.getElementById("execTabSummary");
  const tabDet = document.getElementById("execTabDetails");
  const viewSum = document.getElementById("execSummaryView");
  const viewDet = document.getElementById("execDetailsView");
  document.getElementById("savePdfBtn").onclick = saveExecutiveSummaryPdf;
  document.getElementById("saveWordBtn").onclick = saveExecutiveSummaryWord;

  tabSum.onclick = () => {
    tabSum.className = "primary mini";
    tabSum.style.background = "";
    tabSum.style.border = "";
    tabDet.className = "ghost mini";
    tabDet.style.background = "transparent";
    tabDet.style.border = "1px solid var(--border)";
    viewSum.classList.remove("hidden");
    viewDet.classList.add("hidden");
  };

  tabDet.onclick = () => {
    tabDet.className = "primary mini";
    tabDet.style.background = "";
    tabDet.style.border = "";
    tabSum.className = "ghost mini";
    tabSum.style.background = "transparent";
    tabSum.style.border = "1px solid var(--border)";
    viewDet.classList.remove("hidden");
    viewSum.classList.add("hidden");
  };

  document.getElementById("execModal").classList.remove("hidden");
}

function buildMapSnapshotUrl(data = lastResult) {
  if (!data || !mapsBrowserKey) return "";
  const params = new URLSearchParams({
    key: mapsBrowserKey,
    size: "1000x620",
    scale: "2",
    maptype: map?.getMapTypeId() === "satellite" ? "satellite" : "roadmap",
  });
  const center = `${data.geo.lat},${data.geo.lng}`;
  params.set("center", center);
  params.set("zoom", String(Math.min(map?.getZoom?.() || 13, 14)));

  const addPath = (h) => {
    const color = scoreColor(h.final).match(/\d+/g).map(n => Number(n).toString(16).padStart(2, "0")).join("");
    const boundary = window.h3.cellToBoundary(h.hex, true);
    const points = boundary.concat([boundary[0]]).map(([lng, lat]) => `${lat.toFixed(5)},${lng.toFixed(5)}`);
    const path = `color:0x${color}cc|fillcolor:0x${color}80|weight:1|${points.join("|")}`;
    const next = `${params.toString()}&path=${encodeURIComponent(path)}`;
    if (next.length < 14500) params.append("path", path);
  };
  (data.hexes || []).forEach(addPath);

  (data.ownList || []).slice(0, 12).forEach(p => params.append("markers", `color:green|label:Y|${p.lat},${p.lng}`));
  (data.competitorsList || []).slice(0, 12).forEach(p => params.append("markers", `color:red|label:C|${p.lat},${p.lng}`));
  (data.recommendations || []).forEach((r, idx) => params.append("markers", `color:blue|label:${idx + 1}|${r.lat},${r.lng}`));
  importedLocationsData.slice(0, 12).forEach(p => params.append("markers", `color:green|label:I|${p.lat},${p.lng}`));
  return `https://maps.googleapis.com/maps/api/staticmap?${params.toString()}`;
}

function buildExecutiveReportHtml() {
  const data = lastResult;
  const ex = data.agent.executive || {};
  const stars = "★".repeat(ex.rating || 3) + "☆".repeat(5 - (ex.rating || 3));
  const snapshot = buildMapSnapshotUrl(data);
  const recs = data.recommendations || [];
  return `<!doctype html>
  <html>
  <head>
    <meta charset="utf-8" />
    <title>Executive Summary - ${escapeHtml(data.geo.area || data.geo.city)}</title>
    <style>
      body { font-family: Arial, sans-serif; color: #1a1d2b; margin: 32px; line-height: 1.45; }
      h1 { color: #1a00d9; margin: 0 0 4px; }
      h2 { color: #1a00d9; font-size: 15px; margin-top: 24px; text-transform: uppercase; }
      .meta { color: #6b7390; margin-bottom: 18px; }
      .rec { display: inline-block; padding: 6px 10px; border-radius: 6px; background: #16a34a; color: #fff; font-weight: bold; }
      .map-container { position: relative; width: 100%; max-height: 520px; margin: 16px 0; }
      .snapshot { width: 100%; max-height: 520px; object-fit: cover; border: 1px solid #e1e5ee; border-radius: 8px; display: block; }
      .pdf-compass {
        position: absolute; left: 16px; top: 16px;
        width: 52px; height: 52px; border-radius: 50%;
        background: rgba(255,255,255,0.95); border: 1px solid #e1e5ee;
        box-shadow: 0 2px 10px rgba(0,0,0,0.12); z-index: 6;
        font-family: Arial, sans-serif;
        font-size: 10px; font-weight: 800; color: #4a5168;
      }
      .pdf-compass span { position: absolute; transform: translate(-50%, -50%); }
      .pdf-compass .cmp-n { left: 50%; top: 22%; color: #dc2626; }
      .pdf-compass .cmp-s { left: 50%; top: 78%; }
      .pdf-compass .cmp-e { left: 78%; top: 50%; }
      .pdf-compass .cmp-w { left: 22%; top: 50%; }
      .pdf-compass .cmp-needle { left: 50%; top: 50%; font-size: 22px; color: #1a00d9; line-height: 1; }
      .box { background: #f6f7fb; border-left: 4px solid #fe6e06; padding: 12px 14px; border-radius: 0 8px 8px 0; }
      table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 12px; }
      th, td { border-bottom: 1px solid #e1e5ee; padding: 8px; text-align: left; }
      th { color: #1a00d9; background: #f6f7fb; }
      ul { padding-left: 20px; }
    </style>
  </head>
  <body>
    <h1>${escapeHtml(data.geo.area || data.geo.city)} Executive Summary</h1>
    <div class="meta">${escapeHtml(data.geo.formattedAddress)} | ${escapeHtml(data.vertical.replace("_", " - "))} | ${escapeHtml(data.company?.name || "no company selected")}</div>
    <div class="rec">${recommendationLabel(ex.recommendation || "CAUTION")}</div>
    <div style="font-size:22px;color:#fe6e06;margin-top:8px">${stars}</div>
    ${snapshot ? `
    <div class="map-container">
      <img class="snapshot" src="${snapshot}" alt="Map snapshot with heatmap" />
      <div class="pdf-compass">
        <span class="cmp-n">N</span>
        <span class="cmp-e">E</span>
        <span class="cmp-s">S</span>
        <span class="cmp-w">W</span>
        <span class="cmp-needle">▲</span>
      </div>
    </div>
    ` : ""}
    ${ex.marketState ? `<h2>Market Reality</h2><div class="box">${boldKeywords(ex.marketState)}</div>` : ""}
    <h2>Growth Drivers</h2>
    <ul>${(ex.drivers || []).map(d => `<li><strong>${boldKeywords(d.headline)}</strong>: ${boldKeywords(d.detail)}</li>`).join("") || "<li>None identified</li>"}</ul>
    <h2>Risks And Concerns</h2>
    <ul>${(ex.risks || []).map(r => `<li><strong>${boldKeywords(r.headline)}</strong>: ${boldKeywords(r.detail)}</li>`).join("") || "<li>None identified</li>"}</ul>
    <h2>Bottom Line</h2>
    <ul>${bulletize(ex.bottomLine || "").map(b => `<li>${boldKeywords(b)}</li>`).join("") || "<li>-</li>"}</ul>
    <h2>Recommended Sites</h2>
    <table>
      <thead><tr><th>Site</th><th>Score</th><th>Recommendation</th><th>Coordinates</th></tr></thead>
      <tbody>${recs.map((r, i) => `<tr><td>Site ${i + 1}</td><td>${r.final}/100</td><td>${recommendationLabel(r.final >= 75 ? "GO" : r.final < 50 ? "AVOID" : "CAUTION")}</td><td>${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}</td></tr>`).join("")}</tbody>
    </table>
  </body>
  </html>`;
}

function saveExecutiveSummaryPdf() {
  if (!lastResult) return;
  const report = window.open("", "_blank");
  if (!report) return alert("Allow pop-ups to save the executive summary as PDF.");
  report.document.write(buildExecutiveReportHtml());
  report.document.close();
  setTimeout(() => report.print(), 500);
}

function saveExecutiveSummaryWord() {
  if (!lastResult) return;
  const blob = new Blob([buildExecutiveReportHtml()], { type: "application/msword" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${(lastResult.geo.area || lastResult.geo.city || "executive-summary").replace(/[^\w-]+/g, "-").toLowerCase()}-executive-summary.doc`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- import ----------
async function onImportFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  const status = document.getElementById("importStatus");
  status.textContent = "Reading + AI-mapping columns…";
  status.className = "status loading";
  const buf = await file.arrayBuffer();
  const resp = await fetch(`${RUN}/import?name=${encodeURIComponent(file.name)}`, {
    method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: buf,
  });
  if (!resp.ok) { status.textContent = `Error: ${await resp.text()}`; status.className = "status error"; return; }
  const data = await resp.json();
  status.textContent = `✓ Imported ${data.count} locations. Column mapping:`;
  status.className = "status ok";
  const out = document.getElementById("importResult");
  out.textContent = JSON.stringify(data.mapping, null, 2) + "\n\nPreview (first 3):\n" +
    JSON.stringify(data.locations.slice(0, 3), null, 2);
  out.classList.remove("hidden");

  // Plot locations on the map
  const validLocs = (data.locations || []).filter(l => l.lat != null && l.lng != null);
  if (validLocs.length > 0) {
    // Clear previous imported markers
    for (const m of importedMarkers) m.setMap(null);
    importedMarkers = [];
    importedLocationsData = validLocs;

    const bounds = new google.maps.LatLngBounds();
    validLocs.forEach(p => {
      addImportedPin(p, "#22c55e", p.name);
      bounds.extend({ lat: p.lat, lng: p.lng });
    });
    if (map) {
      map.fitBounds(bounds);
    }
    status.textContent = `✓ Imported ${data.count} locations. Plotted ${validLocs.length} pins on the map.`;
  }
}

// ---------- utils ----------
function setStatus(msg, kind = "") {
  const s = document.getElementById("status");
  s.textContent = msg; s.className = `status ${kind}`;
}
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
// Escape, bold **text**, AND bold domain keywords — so the zone panel highlights
// key terms even when the model didn't wrap them in asterisks.
const KW_LIST = ["metro", "railway", "station", "highway", "expressway", "flyover", "bridge",
  "port", "harbour", "airport", "warehouse", "industrial", "logistics", "mall", "market",
  "school", "college", "university", "hospital", "residential", "apartment", "office",
  "commercial", "footfall", "competition", "competitors", "saturated", "underserved",
  "affluent", "population", "demand", "access", "growth", "parking", "rupees", "sqft"];
function mdBold(s) {
  let out = escapeHtml(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  KW_LIST.forEach(k => {
    // skip if already inside a <strong> we just made — simple heuristic: bold standalone occurrences
    out = out.replace(new RegExp(`\\b(${k}[a-z]*)\\b`, "gi"), m => `<strong>${m}</strong>`);
  });
  // collapse accidental nested <strong><strong>
  out = out.replace(/<strong><strong>/g, "<strong>").replace(/<\/strong><\/strong>/g, "</strong>");
  return out;
}
// Build a Google Maps listing URL for any place on the map. Prefer the Places
// ID (lands on the exact listing); fall back to name + coordinates.
function gmapsUrl(p) {
  const q = encodeURIComponent(p.name || `${p.lat},${p.lng}`);
  if (p.id) return `https://www.google.com/maps/search/?api=1&query=${q}&query_place_id=${encodeURIComponent(p.id)}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${p.lat},${p.lng}`)}`;
}

window.toggleMoreTooltip = (event, elem) => {
  event.stopPropagation();
  const wasActive = elem.classList.contains("active");
  document.querySelectorAll(".more-chip.active").forEach(el => el.classList.remove("active"));
  if (!wasActive) {
    elem.classList.add("active");
  }
};
function brandMapStyle() {
  return [
    { elementType: "geometry", stylers: [{ color: "#f6f7fb" }] },
    { elementType: "labels.text.fill", stylers: [{ color: "#6b7390" }] },
    { elementType: "labels.text.stroke", stylers: [{ color: "#ffffff" }] },
    { featureType: "administrative", elementType: "geometry", stylers: [{ color: "#e1e5ee" }] },
    { featureType: "poi", stylers: [{ visibility: "off" }] },
    { featureType: "road", elementType: "geometry", stylers: [{ color: "#ffffff" }] },
    { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#fff2e0" }] },
    { featureType: "road", elementType: "labels.text.fill", stylers: [{ color: "#4a5168" }] },
    { featureType: "water", elementType: "geometry", stylers: [{ color: "#dde7f5" }] },
    { featureType: "transit", stylers: [{ visibility: "off" }] },
  ];
}
