// TourSensi Scout — frontend (vanilla JS, no build step).

const DEPLOYED_RUN = "https://api-bvb33x56gq-el.a.run.app";
const isLocal = location.hostname === "localhost" || location.hostname === "127.0.0.1";
const API = isLocal ? `${DEPLOYED_RUN}/api` : "/api";
let RUN = isLocal ? DEPLOYED_RUN : "/api";

let map = null;
let hexPolygons = [];
let markers = [];
let lastResult = null;
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
    // Map-type switcher (Map / Satellite / Hybrid / Terrain) as a dropdown, top-right.
    mapTypeControl: true,
    mapTypeControlOptions: {
      style: google.maps.MapTypeControlStyle.DROPDOWN_MENU,
      position: google.maps.ControlPosition.TOP_RIGHT,
      mapTypeIds: ["roadmap", "satellite", "hybrid", "terrain"],
    },
    streetViewControl: true,
    streetViewControlOptions: { position: google.maps.ControlPosition.RIGHT_BOTTOM },
    fullscreenControl: true,
    fullscreenControlOptions: { position: google.maps.ControlPosition.TOP_RIGHT },
    // Single, clean zoom control anchored bottom-right (was crowding RIGHT_CENTER).
    zoomControl: true,
    zoomControlOptions: { position: google.maps.ControlPosition.RIGHT_BOTTOM },
    gestureHandling: "greedy", // scroll-to-zoom without holding ctrl
    clickableIcons: false,     // don't intercept clicks on Google's own POIs
  });

  // Our custom light style only applies to the roadmap base. When the user
  // switches to satellite/hybrid/terrain, clear it so imagery isn't tinted.
  map.addListener("maptypeid_changed", () => {
    map.setOptions({ styles: map.getMapTypeId() === "roadmap" ? brandMapStyle() : null });
  });

  infoWindow = new google.maps.InfoWindow();

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
  document.getElementById("execBtn").onclick = openExecModal;
  document.getElementById("execClose").onclick = () => document.getElementById("execModal").classList.add("hidden");
  document.getElementById("infoBtn").onclick = () => document.getElementById("infoModal").classList.remove("hidden");
  document.getElementById("infoClose").onclick = () => document.getElementById("infoModal").classList.add("hidden");

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
  document.getElementById("execBtn").classList.add("hidden");
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
        else if (evt.event === "result") {
          lastResult = evt.data;
          renderResult(evt.data);
          finishProgress(`✓ Done · ${evt.data.counts.competitors} competitors · ${evt.data.counts.ownBrand} of your sites · growth ${evt.data.agent.growthScore}/100`);
        } else if (evt.event === "error") throw new Error(evt.data.message);
      }
    }
  } catch (e) {
    console.error(e);
    setStatus(`Error: ${e.message}`, "error");
    document.getElementById("progressPanel").classList.add("hidden");
  }
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
// A natural, narrated flow rather than a rigid "pulled / not pulled" checklist.
// A rotating set of human phrases plays while a progress bar steadily advances;
// real backend SSE events nudge the bar forward so it feels alive and honest
// without exposing the raw plumbing.
const PROGRESS_PHRASES = [
  "Pinpointing the location on the map…",
  "Scanning the neighbourhood for competitors…",
  "Mapping nearby metro, roads and landmarks…",
  "Reading the area's demographics and history…",
  "Checking local property prices and listings…",
  "Researching growth signals across the web…",
  "Weighing demand, competition and access…",
  "Scoring every zone for site suitability…",
];
// Map real backend step ids → how far along the bar should be (0..1).
const STEP_PROGRESS = {
  geocode: 0.10, competitors: 0.28, own: 0.38, overlay: 0.50,
  wiki: 0.58, realestate: 0.70, agent: 0.88, score: 0.97,
};
let _progressTimer = null, _phraseTimer = null, _progressTarget = 0.06, _progressShown = 0.06, _phraseIdx = 0;

function startProgress() {
  const panel = document.getElementById("progressPanel");
  panel.classList.remove("hidden");
  _progressTarget = 0.06; _progressShown = 0.04; _phraseIdx = 0;
  panel.innerHTML = `
    <div class="progress-narrate">
      <span class="spinner"></span>
      <span id="progressPhrase">${PROGRESS_PHRASES[0]}</span>
    </div>
    <div class="progress-bar"><div id="progressFill" class="progress-fill"></div></div>`;
  setStatus("", "");

  // Smoothly ease the displayed bar toward the target; creep slowly between
  // events so it never looks frozen.
  clearInterval(_progressTimer);
  _progressTimer = setInterval(() => {
    // gentle autonomous creep, capped just under the current target + a ceiling
    _progressShown += (Math.max(_progressTarget, _progressShown + 0.004) - _progressShown) * 0.08;
    _progressShown = Math.min(_progressShown, 0.985);
    const fill = document.getElementById("progressFill");
    if (fill) fill.style.width = `${(_progressShown * 100).toFixed(1)}%`;
  }, 80);

  // Rotate the narration phrases on a calm cadence.
  clearInterval(_phraseTimer);
  _phraseTimer = setInterval(() => {
    _phraseIdx = (_phraseIdx + 1) % PROGRESS_PHRASES.length;
    const p = document.getElementById("progressPhrase");
    if (p) { p.style.opacity = 0; setTimeout(() => { p.textContent = PROGRESS_PHRASES[_phraseIdx]; p.style.opacity = 1; }, 180); }
  }, 2300);
}

function onProgress({ step }) {
  // Real events only nudge the bar/phrase forward — we never show the raw
  // "X found / Y skipped" detail; the narration stays smooth and natural.
  if (step && STEP_PROGRESS[step] != null) {
    _progressTarget = Math.max(_progressTarget, STEP_PROGRESS[step]);
  }
}

function finishProgress(msg) {
  clearInterval(_progressTimer); clearInterval(_phraseTimer);
  const fill = document.getElementById("progressFill");
  if (fill) fill.style.width = "100%";
  setTimeout(() => document.getElementById("progressPanel").classList.add("hidden"), 350);
  setStatus(msg, "ok");
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

  // Pins
  for (const p of data.competitorsList) addCompetitorPin(p, "#dc2626", "Competitor");
  for (const p of data.ownList)         addCompetitorPin(p, "#22c55e", "Your site", "own");

  // Context overlays
  for (const o of (data.overlay || [])) addOverlayPin(o);

  // Exec mini card in sidebar
  document.getElementById("execMini").innerHTML = renderExecMini(data);
  document.getElementById("execBtn").classList.remove("hidden");
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
    
    return `
      <li class="tagged-card" data-hex="${r.hex}" style="--score-color: ${scColor}">
        <div class="rec-card-header">
          ${r.tag ? `<div class="rec-card-tag">${TAG_LABELS[r.tag]}</div>` : "<div></div>"}
          <div class="rec-card-score">${r.final}/100</div>
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

function renderExecMini(data) {
  const ex = data.agent.executive || { rating: 3, recommendation: "CAUTION", bottomLine: "" };
  const stars = "★".repeat(ex.rating) + "☆".repeat(5 - ex.rating);
  return `
    <div class="em-row">
      <div class="em-area">${escapeHtml(data.geo.area || data.geo.city)}</div>
      <div class="em-rec ${ex.recommendation}">${ex.recommendation}</div>
    </div>
    <div class="em-stars">${stars}</div>
    <div class="em-bottom">${escapeHtml(ex.bottomLine || "")}</div>
    <button class="em-cta">📋 Open full executive summary →</button>
  `;
}

function renderContext(data) {
  const w = data.wiki, pin = data.pin, re = data.realEstate;
  const blurb = w?.summary ? boldKeywords(w.summary.slice(0, 380) + (w.summary.length > 380 ? "…" : "")) : "<em>(no Wikipedia context found)</em>";
  return `
    <div class="context-block">${blurb}
      ${w?.url ? `<div style="margin-top:6px"><a href="${w.url}" target="_blank" style="color:var(--ganit-blue); font-size:11px">Read more on Wikipedia ↗</a></div>` : ""}
    </div>
    <div class="context-meta">
      ${pin?.pin ? `<div class="cm-item"><strong>PIN</strong> ${pin.pin}</div>` : ""}
      ${pin?.district ? `<div class="cm-item"><strong>District</strong> ${escapeHtml(pin.district)}</div>` : ""}
      ${w?.population ? `<div class="cm-item"><strong>Population</strong> ~${w.population.toLocaleString("en-IN")}</div>` : ""}
      ${re?.medianPricePerSqft ? `<div class="cm-item"><strong>Median ₹/sqft</strong> ₹${Math.round(re.medianPricePerSqft).toLocaleString("en-IN")}</div>` : ""}
      ${data.counts?.overlay ? `<div class="cm-item"><strong>${data.counts.overlay}</strong> context POIs</div>` : ""}
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

function addOverlayPin(o) {
  const m = new google.maps.Marker({
    position: { lat: o.lat, lng: o.lng }, map,
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
    const content = `
      <div style="font-family: 'Inter', sans-serif; padding: 6px; min-width: 150px;">
        <div style="font-size: 11px; font-weight: 700; color: var(--ganit-blue); text-transform: uppercase; margin-bottom: 2px;">
          ${o.icon} ${escapeHtml(o.label || o.kind)}
        </div>
        <div style="font-size: 13px; font-weight: 600; color: var(--text);">${escapeHtml(o.name)}</div>
        <div style="font-size: 10px; color: var(--muted); margin-top: 4px; font-family: monospace;">
          ${o.lat.toFixed(5)}, ${o.lng.toFixed(5)}
        </div>
      </div>
    `;
    infoWindow.setContent(content);
    infoWindow.open(map, m);
  });
  markers.push(m);

  // Overlay text name displayed directly next to pin on the map
  const label2 = makeHTMLLabel({ lat: o.lat, lng: o.lng }, o.name, "marker-label overlay");
  markers.push(label2);
}

// HTML labels for competitor/own pins
function makeHTMLLabel(latLng, text, className) {
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
  lbl.setMap(map);
  return lbl;
}

function showHexPanel(h, data) {
  const panel = document.getElementById("hexPanel");
  const re = data?.realEstate;
  const listings = (data?.propertyListings || []).slice(0, 3);
  
  // Render Suitability Assessment and Pros/Cons
  const assessmentHTML = renderHexAssessment(h, data);
  
  document.getElementById("hexBody").innerHTML = `
    ${h.tag ? `<div class="rec-tag tag-${h.tag}" style="margin-bottom:8px; background: ${scoreColor(h.final)}">${TAG_LABELS[h.tag]}</div>` : ""}
    <div style="margin-bottom: 14px"><span class="final-pill" style="background:${scoreColor(h.final)}">${h.final}/100</span></div>

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
    ${h.signals.nearest.map(n => `
      <div class="score-row">
        <span class="label">${n.icon} ${escapeHtml(n.label.split(" / ")[0])}</span>
        <span class="v">${n.meters >= 1000 ? (n.meters/1000).toFixed(1) + " km" : n.meters + " m"}</span>
      </div>`).join("")}
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
  panel.classList.remove("hidden");
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
    <div class="zi-headline">${escapeHtml(ins.headline || "")}</div>
    ${(ins.reasoning && ins.reasoning.length) ? `
      <div class="zi-section-label">Why${v === "AVOID" ? " not" : ""}</div>
      <ul class="zi-reasons">${ins.reasoning.map(r => `<li>${escapeHtml(r)}</li>`).join("")}</ul>` : ""}
    ${(ins.facts && ins.facts.length) ? `
      <div class="zi-section-label">The facts</div>
      <ul class="zi-facts">${ins.facts.map(f => `<li>${escapeHtml(f)}</li>`).join("")}</ul>` : ""}
    ${ins.bottomLine ? `<div class="zi-bottom">${escapeHtml(ins.bottomLine)}</div>` : ""}
    ${(ins.sources && ins.sources.length) ? `
      <div class="zi-sources">Sources: ${ins.sources.slice(0, 4).map(s => `<a href="${escapeHtml(s.uri)}" target="_blank" rel="noopener">${escapeHtml(s.title || "link")}</a>`).join(" · ")}</div>` : ""}
  `;
}

function clearMap() {
  for (const p of hexPolygons) p.setMap(null);
  for (const m of markers) m.setMap(null);
  hexPolygons = []; markers = [];
  if (selectedPolyHighlight) {
    selectedPolyHighlight.setMap(null);
    selectedPolyHighlight = null;
  }
  document.getElementById("hexPanel").classList.add("hidden");
}

// Smoothly glide the map from the current zone to the clicked one, easing in a
// touch of zoom so the move feels like travelling between zones.
function glideToZone(h) {
  if (!map) return;
  const target = { lat: h.lat, lng: h.lng };
  map.panTo(target);            // built-in eased pan
  const desired = 16;
  const cur = map.getZoom() ?? 14;
  if (cur < desired) {
    // step the zoom up a notch shortly after the pan starts for a gentle dolly-in
    setTimeout(() => { if ((map.getZoom() ?? 14) < desired) map.setZoom(Math.min(desired, (map.getZoom() ?? 14) + 1)); }, 220);
    setTimeout(() => { if ((map.getZoom() ?? 14) < desired) map.setZoom(desired); }, 460);
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

function getPaletteStops(theme) {
  if (theme === "vivid") {
    // High-saturation option for users who want a punchy heatmap.
    return [
      [0,   [239, 68, 68]],
      [35,  [249, 115, 22]],
      [50,  [234, 179, 8]],
      [65,  [132, 204, 22]],
      [80,  [34, 197, 94]],
      [100, [21, 128, 61]],
    ];
  } else if (theme === "ganit") {
    // Brand palette: orange (bad) → blue (good), distinct hues, softened.
    return [
      [0,   [230, 120, 90]],   // Avoid  (muted terracotta)
      [35,  [244, 160, 100]],  // Marginal (soft orange)
      [50,  [210, 200, 170]],  // Decent (warm neutral)
      [65,  [120, 140, 220]],  // Strong (soft blue)
      [80,  [60, 70, 200]],    // Excellent (brand-ish blue)
      [100, [26, 0, 217]],     // Best (logo blue)
    ];
  } else if (theme === "colorblind") {
    // Blue (bad) → yellow (good): safe for red-green colorblindness, distinct.
    return [
      [0,   [70, 110, 200]],
      [35,  [120, 160, 220]],
      [50,  [200, 200, 200]],
      [65,  [240, 210, 120]],
      [80,  [240, 180, 40]],
      [100, [200, 140, 0]],
    ];
  } else { // default "soft" — distinct, gentle, lets the map show through
    return [
      [0,   [214, 96, 77]],    // Avoid (soft coral-red)
      [35,  [233, 156, 96]],   // Marginal (soft amber)
      [50,  [235, 214, 140]],  // Decent (pale sand)
      [65,  [150, 200, 150]],  // Strong (soft sage green)
      [80,  [70, 175, 110]],   // Excellent (clean green)
      [100, [33, 140, 90]],    // Best (deep teal-green)
    ];
  }
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
    fillOpacity: 0.06 + Math.pow(t, 1.5) * 0.36,   // ~0.06 (weak) → ~0.42 (best)
    strokeOpacity: topTier ? 0.9 : 0.35 + t * 0.35,
    strokeWeight: topTier ? 2 : 1,
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
  
  // 2. Specific Nearby Amenities with names (clickable links to map)
  r.signals.nearest.forEach(n => {
    bullets.push(`
      <div class="rec-detail-bullet">
        <span class="icon">${n.icon}</span>
        <div>
          <strong>${escapeHtml(n.label.split(" / ")[0])}:</strong> 
          <a class="amenity-link" data-name="${escapeHtml(n.name)}" data-key="${n.factorKey}">${escapeHtml(n.name)}</a> 
          (${n.meters >= 1000 ? (n.meters/1000).toFixed(1) + " km" : n.meters + " m"} away)
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
  let statusText = "Proceed with Caution (CAUTION)";
  if (h.final >= 75) {
    statusClass = "go";
    statusText = "Highly Recommended (GO)";
  } else if (h.final < 50) {
    statusClass = "avoid";
    statusText = "Not Recommended (AVOID)";
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

// ---------- Executive Modal ----------
function openExecModal() {
  if (!lastResult) return;
  const ex = lastResult.agent.executive || {};
  const stars = "★".repeat(ex.rating || 3) + "☆".repeat(5 - (ex.rating || 3));
  const quads = lastResult.agent.quadrantScores || [];
  
  // Build Site Comparison Matrix
  const recs = lastResult.recommendations || [];
  const comparisonRows = recs.map(r => {
    let recStatus = "Proceed with Caution";
    let recColor = "var(--warn)";
    if (r.final >= 75) { recStatus = "Highly Recommended"; recColor = "var(--good)"; }
    else if (r.final < 50) { recStatus = "Not Recommended"; recColor = "var(--bad)"; }
    
    const landmark = r.signals.nearest[0];
    const quadLabel = (r.lat >= lastResult.geo.lat ? "North" : "South") + "-" + (r.lng >= lastResult.geo.lng ? "East" : "West");
    const locDesc = `Near ${landmark ? landmark.name : 'Center'} (${quadLabel})`;

    return `
      <tr>
        <td style="padding: 10px; font-weight: 700; border-bottom: 1px solid var(--border); font-size: 11.5px;">
          <span style="border-left: 3px solid ${scoreColor(r.final)}; padding-left: 6px;">${TAG_LABELS[r.tag] || r.tag}</span>
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
        <div style="font-size: 10px; color: var(--muted); text-transform: uppercase; font-weight: 700; letter-spacing: 0.5px;">Median Property Price</div>
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
      <!-- Tab Selector Header -->
      <div style="display: flex; gap: 8px; margin-bottom: 20px; border-bottom: 2px solid var(--border); padding-bottom: 12px; position: sticky; top: -24px; background: #ffffff; z-index: 100;">
        <button id="execTabSummary" class="primary mini" style="width: auto; padding: 8px 16px;">📋 Summary Insights</button>
        <button id="execTabDetails" class="ghost mini" style="width: auto; padding: 8px 16px; border: 1px solid var(--border);">🔍 Detailed Site Metrics</button>
      </div>

      <!-- View 1: Summary -->
      <div id="execSummaryView">
        <div class="eb-section drivers">
          <h4>✅ Growth drivers</h4>
          ${(ex.drivers || []).map(d => `
            <div class="driver">
              <div class="icon">✓</div>
              <div>
                <div class="d-headline">${escapeHtml(d.headline)}</div>
                <div class="d-detail">${escapeHtml(d.detail)}</div>
              </div>
            </div>`).join("") || "<em>(none identified)</em>"}
        </div>
  
        <div class="eb-section risks">
          <h4>⚠️ Risks &amp; concerns</h4>
          ${(ex.risks || []).map(r => `
            <div class="risk">
              <div class="icon">!</div>
              <div>
                <div class="d-headline">${escapeHtml(r.headline)}</div>
                <div class="d-detail">${escapeHtml(r.detail)}</div>
              </div>
            </div>`).join("") || "<em>(none identified)</em>"}
        </div>
  
        <div class="eb-section">
          <h4>📊 Sub-area breakdown</h4>
          <div class="context-meta">
            ${quads.map(q => `<div class="cm-item"><strong>${q.quadrant}</strong> ${q.growthScore}/100 — ${escapeHtml(q.headline || "—")}</div>`).join("")}
          </div>
        </div>
  
        <div class="eb-section">
          <h4>🎯 Bottom line</h4>
          <div class="bottom-line">${escapeHtml(ex.bottomLine || "")}</div>
        </div>
      </div>

      <!-- View 2: Detailed Site Metrics -->
      <div id="execDetailsView" class="hidden">
        <div class="eb-section">
          <h4>📍 Suitability Comparison Matrix</h4>
          <p style="font-size: 12px; color: var(--muted); margin-bottom: 12px;">Side-by-side suitability and proximity comparison matrix for the selected sites.</p>
          ${comparisonTable}
        </div>
        
        <div class="eb-section" style="margin-top: 24px;">
          <h4>🏘️ Local Real Estate Indicators</h4>
          ${realEstateHTML}
        </div>

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
}

// ---------- utils ----------
function setStatus(msg, kind = "") {
  const s = document.getElementById("status");
  s.textContent = msg; s.className = `status ${kind}`;
}
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
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
