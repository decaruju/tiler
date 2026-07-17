"use strict";
/* Tiler — DOM, rendering, interaction. Pure geometry/packing/formatting is in core.js. */

/* ---- Rendering ----------------------------------------------------------- */

const canvas = document.getElementById("plan");
const ctx = canvas.getContext("2d");

const view = { scale: 1, tx: 0, ty: 0, ready: false };
let state = { polygons: [], layout: null, origin: { x: 0, y: 0 } };

const css = k => getComputedStyle(document.documentElement).getPropertyValue(k).trim();

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(r.width * dpr));
  canvas.height = Math.max(1, Math.round(r.height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function worldBounds(polygons) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const poly of polygons) for (const p of poly) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

function fitView() {
  if (!state.polygons.length) return;
  const b = worldBounds(state.polygons);
  const r = canvas.getBoundingClientRect();
  const pad = 40;
  const w = Math.max(b.maxX - b.minX, 1e-6);
  const h = Math.max(b.maxY - b.minY, 1e-6);
  const scale = Math.min((r.width - pad * 2) / w, (r.height - pad * 2) / h);
  view.scale = scale;
  // Center; note screen Y is flipped so world +Y points up.
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  view.tx = r.width / 2 - cx * scale;
  view.ty = r.height / 2 + cy * scale;
  view.ready = true;
  draw();
}

const toScreen = p => ({ x: p.x * view.scale + view.tx, y: -p.y * view.scale + view.ty });
const toWorld = (sx, sy) => ({ x: (sx - view.tx) / view.scale, y: -(sy - view.ty) / view.scale });

function pathPolys(polygons) {
  ctx.beginPath();
  for (const poly of polygons) {
    poly.forEach((p, i) => {
      const s = toScreen(p);
      i === 0 ? ctx.moveTo(s.x, s.y) : ctx.lineTo(s.x, s.y);
    });
    ctx.closePath();
  }
}

function draw() {
  const r = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, r.width, r.height);
  if (!view.ready || !state.layout) return;

  // Room fill.
  ctx.fillStyle = css("--room-fill");
  pathPolys(state.polygons);
  ctx.fill("evenodd");

  // Tiles, clipped to the room outline so cuts render as real partial pieces.
  ctx.save();
  pathPolys(state.polygons);
  ctx.clip("evenodd");

  const full = css("--tile-full"), fullLine = css("--tile-full-line"),
        cut = css("--cut"), sliver = css("--sliver");
  ctx.lineWidth = 1;
  for (const t of state.layout.tiles) {
    ctx.beginPath();
    t.corners.forEach((p, i) => {
      const s = toScreen(p);
      i === 0 ? ctx.moveTo(s.x, s.y) : ctx.lineTo(s.x, s.y);
    });
    ctx.closePath();
    ctx.fillStyle = t.sliver ? sliver : t.cut ? cut : full;
    ctx.fill();
    ctx.strokeStyle = t.cut ? "rgba(255,255,255,.6)" : fullLine;
    ctx.stroke();
  }
  ctx.restore();

  // Room outline.
  ctx.lineJoin = "round";
  ctx.lineWidth = 2;
  ctx.strokeStyle = css("--ink");
  pathPolys(state.polygons);
  ctx.stroke();

  drawNumbers();
  drawOrigin();
}

// Number every tile — only when tiles are large enough on screen to read.
function drawNumbers() {
  const px = view.scale * Math.min(state.layout.tileW || 0, state.layout.tileH || 0);
  if (px < 24) return;
  const size = Math.min(13, px * 0.26);
  ctx.font = `600 ${size}px ${css("--mono") || "monospace"}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "rgba(35,32,27,.55)";
  for (const t of state.layout.tiles) {
    const s = toScreen(t.label);
    ctx.fillText(t.num, s.x, s.y);
  }
}

function drawOrigin() {
  const s = toScreen(state.origin);
  const c = css("--accent");
  ctx.save();
  ctx.strokeStyle = c; ctx.fillStyle = c; ctx.lineWidth = 1.5;
  const R = 11;
  ctx.beginPath();
  ctx.moveTo(s.x - R, s.y); ctx.lineTo(s.x + R, s.y);
  ctx.moveTo(s.x, s.y - R); ctx.lineTo(s.x, s.y + R);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(s.x, s.y, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/* ---- Wiring -------------------------------------------------------------- */

const $ = id => document.getElementById(id);
const inputs = ["units", "coords", "tileW", "tileH", "grout", "pattern", "rotation",
  "originX", "originY", "align", "kerf", "maxAspect", "reuse", "rollWidth", "waste", "box", "price"].map($);
const errorEl = $("error");

function readConfig() {
  const patt = $("pattern").value;
  return {
    units: $("units").value,
    tileW: parseFloat($("tileW").value),
    tileH: parseFloat($("tileH").value),
    grout: parseFloat($("grout").value) || 0,
    rotationDeg: parseFloat($("rotation").value) || 0,
    originX: parseFloat($("originX").value) || 0,
    originY: parseFloat($("originY").value) || 0,
    align: $("align").value,
    rowOffset: patt === "seam" ? 0 : (parseFloat(patt) || 0),
    seam: patt === "seam",
    kerf: parseFloat($("kerf").value) || 0,
    maxAspect: parseFloat($("maxAspect").value) || 0,
    reuse: $("reuse").checked,
    rollWidth: parseFloat($("rollWidth").value) || 0,
    waste: parseFloat($("waste").value) || 0,
    box: Math.max(1, Math.floor(parseFloat($("box").value) || 1)),
    price: parseFloat($("price").value) || 0,
  };
}

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.hidden = false;
  state.layout = null;
  ["stTotal", "stFull", "stCut", "stSlivers", "stArea", "stMembrane", "stBuy", "stBoxes", "stCost"].forEach(id => ($(id).textContent = "–"));
  $("cutSheet").innerHTML = "";
  draw();
}

/* ---- Cut sheet ----------------------------------------------------------- */

function renderCutSheet(layout, unit) {
  const el = $("cutSheet");
  const cuts = layout.tiles.filter(t => t.cut).length;
  if (cuts === 0) {
    el.innerHTML = `<p class="cs-empty">No cuts needed — every tile is laid whole.</p>`;
    return;
  }
  const saved = cuts - layout.cutStock;
  const savedTxt = saved > 0
    ? ` — reusing offcuts saves <strong>${saved}</strong> tile${saved === 1 ? "" : "s"}`
    : "";

  let rows = "";
  for (const s of layout.stocks) {
    const pieces = [...s.pieces].sort((a, b) => a.num - b.num);
    pieces.forEach((p, i) => {
      const stockCell = i === 0
        ? `<td class="cs-stock" rowspan="${pieces.length}">Tile ${s.id}</td>`
        : "";
      rows += `<tr>${stockCell}` +
        `<td class="cs-num"><button type="button" class="cs-link" data-stock="${s.id}" data-num="${p.num}">#${p.num}</button></td>` +
        `<td class="cs-size">${fmtLen(p.w, unit)} &times; ${fmtLen(p.h, unit)}</td></tr>`;
    });
  }

  el.innerHTML =
    `<div class="cs-head">
       <h2>Cut sheet</h2>
       <p><strong>${cuts}</strong> cut piece${cuts === 1 ? "" : "s"} from ` +
         `<strong>${layout.cutStock}</strong> tile${layout.cutStock === 1 ? "" : "s"}${savedTxt}. ` +
         `Sizes are the piece bounding box; # matches the plan.</p>
     </div>
     <div class="cs-scroll">
       <table class="cs-table">
         <thead><tr><th>Cut from</th><th>Piece&nbsp;#</th><th>Cut size (w &times; h)</th></tr></thead>
         <tbody>${rows}</tbody>
       </table>
     </div>`;
}

function recompute(refit) {
  let cfg;
  try {
    cfg = readConfig();
    if (!(cfg.tileW > 0) || !(cfg.tileH > 0)) throw new Error("Tile width and height must be positive.");
    if (cfg.kerf < 0) throw new Error("Saw kerf can't be negative.");
    const polygons = parseRooms($("coords").value);
    const layout = computeLayout({ ...cfg, polygons });

    // Reuse offcuts to work out how many physical tiles the cuts really need.
    const { stocks } = packCuts(layout.tiles, cfg.tileW, cfg.tileH, cfg.kerf, cfg.reuse);
    layout.stocks = stocks;
    layout.cutStock = stocks.length;
    layout.total = layout.full + layout.cutStock;

    state.polygons = polygons;
    state.layout = layout;
    state.origin = { x: cfg.originX, y: cfg.originY };
    state.units = cfg.units;
    errorEl.hidden = true;

    $("stTotal").textContent = layout.total.toLocaleString();
    $("stFull").textContent = layout.full.toLocaleString();
    $("stCut").textContent = layout.cut.toLocaleString();
    $("stSlivers").textContent = cfg.maxAspect > 1 ? layout.slivers.toLocaleString() : "–";
    $("stArea").textContent = fmtArea(layout.area, cfg.units);

    // Underlayment membrane roll length (butt-jointed strips).
    const membrane = membraneRoll(polygons, cfg.rollWidth);
    $("stMembrane").textContent = membrane ? fmtLen(membrane.length, cfg.units) : "–";
    const buy = Math.ceil(layout.total * (1 + cfg.waste / 100));
    $("stBuy").textContent = buy.toLocaleString();

    // Tiles are sold in boxes — round the purchase up to whole boxes.
    const boxes = Math.ceil(buy / cfg.box);
    const tilesBought = boxes * cfg.box;
    $("stBoxes").textContent = cfg.box > 1
      ? `${boxes.toLocaleString()} (${tilesBought.toLocaleString()})`
      : boxes.toLocaleString();

    // Total cost = tiles actually bought (whole boxes) × price per tile.
    const cost = tilesBought * cfg.price;
    $("stCost").textContent = cfg.price > 0
      ? cost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : "–";

    renderCutSheet(layout, cfg.units);

    if (refit || !view.ready) fitView();
    else draw();
  } catch (e) {
    showError(e.message || String(e));
  }
}

/* Inputs: recompute live. Coordinate/rotation edits refit the view. */
inputs.forEach(el => {
  const refit = ["coords", "rotation", "units"].includes(el.id);
  el.addEventListener("input", () => recompute(refit));
  el.addEventListener("change", () => recompute(refit));
});

/* Toolbar */
$("fitBtn").addEventListener("click", fitView);

let settingOrigin = false;
const originBtn = $("originBtn");
originBtn.addEventListener("click", () => {
  settingOrigin = !settingOrigin;
  originBtn.setAttribute("aria-pressed", String(settingOrigin));
  canvas.classList.toggle("setting", settingOrigin);
});

/* Canvas interaction: drag origin (in set mode or by grabbing ✛), pan, zoom */
let dragging = null; // 'origin' | 'pan'
let last = { x: 0, y: 0 };
let downAt = { x: 0, y: 0 }, moved = false;

function nearOrigin(sx, sy) {
  const s = toScreen(state.origin);
  return Math.hypot(sx - s.x, sy - s.y) < 14;
}

// Point-in-polygon (ray casting) on a tile's world-space square.
function pointInPoly(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > pt.y) !== (b.y > pt.y) &&
        pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function tileAt(sx, sy) {
  if (!state.layout) return null;
  const w = toWorld(sx, sy);
  for (const t of state.layout.tiles) if (pointInPoly(w, t.corners)) return t;
  return null;
}

// A tap (not a drag) on a cut tile opens its stock-tile modal.
function handleTap(sx, sy) {
  const t = tileAt(sx, sy);
  if (t && t.cut) openTileModal(t.stock, t.num);
}

function setOriginFromScreen(sx, sy) {
  const w = toWorld(sx, sy);
  const rx = Math.round(w.x * 1000) / 1000, ry = Math.round(w.y * 1000) / 1000;
  $("originX").value = rx;
  $("originY").value = ry;
  recompute(false);
}

canvas.addEventListener("pointerdown", e => {
  const r = canvas.getBoundingClientRect();
  const sx = e.clientX - r.left, sy = e.clientY - r.top;
  if (settingOrigin || (state.layout && nearOrigin(sx, sy))) {
    dragging = "origin";
    setOriginFromScreen(sx, sy);
  } else {
    dragging = "pan";
    canvas.classList.add("panning");
  }
  last = { x: sx, y: sy };
  downAt = { x: sx, y: sy };
  moved = false;
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener("pointermove", e => {
  const r = canvas.getBoundingClientRect();
  const sx = e.clientX - r.left, sy = e.clientY - r.top;
  if (!dragging) {
    // Hover feedback: pointer cursor over a cut tile.
    if (!settingOrigin) {
      const t = tileAt(sx, sy);
      canvas.classList.toggle("hot", !!(t && t.cut));
    }
    return;
  }
  if (Math.hypot(sx - downAt.x, sy - downAt.y) > 4) moved = true;
  if (dragging === "origin") {
    setOriginFromScreen(sx, sy);
  } else {
    view.tx += sx - last.x;
    view.ty += sy - last.y;
    draw();
  }
  last = { x: sx, y: sy };
});

function endDrag(e) {
  if (dragging === "pan" && !moved && e) {
    const r = canvas.getBoundingClientRect();
    handleTap(e.clientX - r.left, e.clientY - r.top);
  }
  if (dragging === "origin" && settingOrigin) {
    settingOrigin = false;
    originBtn.setAttribute("aria-pressed", "false");
    canvas.classList.remove("setting");
  }
  dragging = null;
  canvas.classList.remove("panning");
}
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);

canvas.addEventListener("wheel", e => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  const sx = e.clientX - r.left, sy = e.clientY - r.top;
  const before = toWorld(sx, sy);
  const factor = Math.exp(-e.deltaY * 0.0015);
  view.scale *= factor;
  // Keep the point under the cursor fixed.
  view.tx = sx - before.x * view.scale;
  view.ty = sy + before.y * view.scale;
  draw();
}, { passive: false });

window.addEventListener("resize", () => { resizeCanvas(); draw(); });

/* ---- Stock-tile modal ---------------------------------------------------- */

const modal = $("tileModal");
const tileCtx = $("tileCanvas").getContext("2d");

// Draw one physical stock tile with every piece cut from it nested in place.
function drawStockTile(stock, unit, highlightNum) {
  const cvs = $("tileCanvas");
  const dpr = window.devicePixelRatio || 1;
  const size = 380;
  cvs.width = size * dpr; cvs.height = size * dpr;
  cvs.style.width = cvs.style.height = size + "px";
  tileCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  tileCtx.clearRect(0, 0, size, size);

  const pad = 26;
  const TW = stock.tileW, TH = stock.tileH;
  const scale = Math.min((size - pad * 2) / TW, (size - pad * 2) / TH);
  const offX = (size - TW * scale) / 2, offY = (size - TH * scale) / 2;
  // Grid (y-up) -> canvas.
  const cx = tx => offX + tx * scale;
  const cy = ty => size - offY - ty * scale;

  // Stock tile body = waste/uncut background.
  tileCtx.fillStyle = css("--tile-full");
  tileCtx.strokeStyle = css("--ink");
  tileCtx.lineWidth = 2;
  tileCtx.beginPath();
  tileCtx.rect(cx(0), cy(TH), TW * scale, TH * scale);
  tileCtx.fill();
  tileCtx.stroke();

  // Map a piece-local point (relative to its bbox) into stock-tile coords,
  // honouring a 90° rotation when the piece was turned to fit.
  const place = p => p.place;
  const mapPt = (piece, q) => {
    const pl = piece.place;
    const nx = pl.rot ? q.y : q.x;
    const ny = pl.rot ? (piece.w - q.x) : q.y;
    return { x: pl.x + nx, y: pl.y + ny };
  };

  const cut = css("--cut"), sliverC = css("--sliver");
  for (const piece of stock.pieces) {
    const pl = place(piece);
    const hot = piece.num === highlightNum;
    tileCtx.fillStyle = hot ? css("--accent") : piece.sliver ? sliverC : cut;
    tileCtx.strokeStyle = "rgba(255,255,255,.85)";
    tileCtx.lineWidth = 1.5;
    for (const ring of (piece.shape || [[]])) {
      tileCtx.beginPath();
      ring.forEach((q, i) => {
        const m = mapPt(piece, q);
        const X = cx(m.x), Y = cy(m.y);
        i === 0 ? tileCtx.moveTo(X, Y) : tileCtx.lineTo(X, Y);
      });
      tileCtx.closePath();
      tileCtx.fill();
      tileCtx.stroke();
    }
    // Piece number at the placement-rect centre.
    const mid = { x: pl.x + pl.w / 2, y: pl.y + pl.h / 2 };
    tileCtx.fillStyle = "#fff";
    tileCtx.font = "600 13px " + (css("--mono") || "monospace");
    tileCtx.textAlign = "center";
    tileCtx.textBaseline = "middle";
    tileCtx.fillText("#" + piece.num, cx(mid.x), cy(mid.y));
  }

  // Tile size caption.
  tileCtx.fillStyle = css("--ink-soft");
  tileCtx.font = "11px " + (css("--sans") || "sans-serif");
  tileCtx.textAlign = "center";
  tileCtx.textBaseline = "top";
  tileCtx.fillText(`${fmtLen(TW, unit)} × ${fmtLen(TH, unit)} tile`, size / 2, cy(0) + 6);
}

function openTileModal(stockId, highlightNum) {
  const layout = state.layout;
  if (!layout || !layout.stocks) return;
  const stock = layout.stocks[stockId - 1];
  if (!stock) return;
  const unit = state.units;

  $("modalTitle").textContent =
    `Tile ${stock.id} — ${stock.pieces.length} piece${stock.pieces.length === 1 ? "" : "s"}`;

  const pieces = [...stock.pieces].sort((a, b) => a.num - b.num);
  $("modalPieces").innerHTML = pieces.map(p => {
    const hot = p.num === highlightNum ? " class=\"hot\"" : "";
    return `<li${hot}><span class="mp-num">#${p.num}</span>` +
      `<span class="mp-size">${fmtLen(p.w, unit)} × ${fmtLen(p.h, unit)}</span></li>`;
  }).join("");

  drawStockTile(stock, unit, highlightNum);
  if (!modal.open) modal.showModal();
}

// Cut-sheet piece numbers open the same modal.
$("cutSheet").addEventListener("click", e => {
  const link = e.target.closest(".cs-link");
  if (link) openTileModal(+link.dataset.stock, +link.dataset.num);
});

$("modalClose").addEventListener("click", () => modal.close());
// Click on the backdrop (outside the dialog content) closes it.
modal.addEventListener("click", e => {
  if (e.target === modal) modal.close();
});

/* ---- Shareable links ----------------------------------------------------- */
// Every input is persisted by its element id, so the query string is a
// complete, human-readable snapshot of the specs.
const SHARE_FIELDS = inputs.map(el => el.id);

function loadFromURL() {
  const params = new URLSearchParams(location.search);
  // Back-compat: older links used a single square "tileSize".
  if (params.has("tileSize") && !params.has("tileW")) {
    $("tileW").value = $("tileH").value = params.get("tileSize");
  }
  let found = false;
  for (const id of SHARE_FIELDS) {
    if (!params.has(id)) continue;
    const el = $(id);
    if (el.type === "checkbox") el.checked = params.get(id) === "1";
    else el.value = params.get(id);
    found = true;
  }
  return found;
}

function buildParams() {
  const params = new URLSearchParams();
  for (const id of SHARE_FIELDS) {
    const el = $(id);
    params.set(id, el.type === "checkbox" ? (el.checked ? "1" : "0") : el.value);
  }
  return params.toString();
}

function buildShareURL() {
  return `${location.origin}${location.pathname}?${buildParams()}`;
}

const shareBtn = $("shareBtn");
let shareResetTimer = null;
shareBtn.addEventListener("click", async () => {
  const url = buildShareURL();
  // Reflect the specs in the address bar so a manual copy also works.
  history.replaceState(null, "", url);
  let ok = false;
  try {
    await navigator.clipboard.writeText(url);
    ok = true;
  } catch { ok = false; }
  clearTimeout(shareResetTimer);
  shareBtn.textContent = ok ? "Link copied!" : "Link in address bar";
  shareResetTimer = setTimeout(() => { shareBtn.textContent = "Share link"; }, 1800);
});

// Open the printable cut sheet in a new tab, carrying the specs in the URL.
$("printBtn").addEventListener("click", () => {
  const base = location.pathname.replace(/[^/]*$/, "");
  window.open(`${location.origin}${base}print.html?${buildParams()}`, "_blank");
});

/* ---- Search best origin -------------------------------------------------- */
//
// The tiling repeats every pitch (tile + grout), so shifting the origin by a
// whole pitch reproduces the same layout. The full search space is therefore
// origin offsets within one pitch cell [0, pitch)². We sweep a coarse grid,
// then refine around the best, minimizing tiles required (full + packed cuts).

function tilesForOrigin(cfg, polygons, ox, oy) {
  const layout = computeLayout({ ...cfg, polygons, originX: ox, originY: oy });
  const { stocks } = packCuts(layout.tiles, cfg.tileW, cfg.tileH, cfg.kerf, cfg.reuse);
  return { total: layout.full + stocks.length, cut: layout.cut, slivers: layout.slivers };
}

function searchBestOrigin() {
  const cfg = readConfig();
  if (!(cfg.tileW > 0) || !(cfg.tileH > 0)) return null;
  const polygons = parseRooms($("coords").value);
  const pitchX = cfg.tileW + cfg.grout, pitchY = cfg.tileH + cfg.grout;
  if (!(pitchX > 0) || !(pitchY > 0)) return null;

  let area = 0;
  for (const poly of polygons) area += polygonArea(poly);
  const est = area / (cfg.tileW * cfg.tileH);            // rough tile count
  const N = est > 1500 ? 8 : est > 500 ? 11 : 16;        // coarse resolution
  const M = est > 1500 ? 0 : 6;                          // refine steps

  let best = null;
  const wrapX = v => ((v % pitchX) + pitchX) % pitchX;
  const wrapY = v => ((v % pitchY) + pitchY) % pitchY;
  // Rank by: fewest slivers, then fewest tiles, then fewest cuts, then tidiest origin.
  const better = (r, ox, oy) => {
    if (!best) return true;
    if (r.slivers !== best.slivers) return r.slivers < best.slivers;
    if (r.total !== best.total) return r.total < best.total;
    if (r.cut !== best.cut) return r.cut < best.cut;
    return wrapX(ox) + wrapY(oy) < best.ox + best.oy;
  };
  const consider = (ox, oy) => {
    let r;
    try { r = tilesForOrigin(cfg, polygons, wrapX(ox), wrapY(oy)); } catch { return; }
    if (better(r, ox, oy)) best = { ox: wrapX(ox), oy: wrapY(oy), total: r.total, cut: r.cut, slivers: r.slivers };
  };

  const stepX = pitchX / N, stepY = pitchY / N;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) consider(i * stepX, j * stepY);

  if (M > 0) {                                           // refine around the winner
    const bx = best.ox, by = best.oy, fineX = stepX / M, fineY = stepY / M;
    for (let i = -M; i <= M; i++) for (let j = -M; j <= M; j++) consider(bx + i * fineX, by + j * fineY);
  }
  return best;
}

const searchBtn = $("searchBtn");
searchBtn.addEventListener("click", () => {
  const label = "Search best origin";
  searchBtn.disabled = true;
  searchBtn.textContent = "Searching…";
  // Defer so the "Searching…" label paints before the synchronous sweep.
  setTimeout(() => {
    let msg = label;
    try {
      const before = state.layout ? { total: state.layout.total, slivers: state.layout.slivers } : null;
      const best = searchBestOrigin();
      if (best) {
        $("originX").value = +best.ox.toFixed(4);
        $("originY").value = +best.oy.toFixed(4);
        recompute(false);
        const savedTiles = before ? before.total - state.layout.total : 0;
        const savedSlivers = before ? before.slivers - state.layout.slivers : 0;
        if (savedSlivers > 0) msg = `−${savedSlivers} sliver${savedSlivers === 1 ? "" : "s"}` +
          (savedTiles > 0 ? `, −${savedTiles} tile${savedTiles === 1 ? "" : "s"}` : "");
        else if (savedTiles > 0) msg = `Saved ${savedTiles} tile${savedTiles === 1 ? "" : "s"}`;
        else msg = "Already optimal";
      }
    } catch { /* invalid input — leave origin as-is */ }
    searchBtn.textContent = msg;
    searchBtn.disabled = false;
    setTimeout(() => { searchBtn.textContent = label; }, 2200);
  }, 20);
});

/* Boot */
resizeCanvas();
loadFromURL();
recompute(true);
