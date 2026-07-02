"use strict";

/* ============================================================================
 * Tiler — ceramic tile layout planner
 *
 * Pipeline:
 *   1. Parse the room outline into one or more polygons (world coordinates).
 *   2. Build an axis-aligned tile grid in a frame rotated around the origin.
 *   3. Clip the room against each tile square (Sutherland–Hodgman) to decide
 *      whether a tile is needed and whether it is full or cut.
 *   4. Draw the plan and report the counts.
 * ==========================================================================*/

const EPS_RATIO = 1e-4; // fraction of a tile considered "no coverage"

/* ---- Geometry helpers ---------------------------------------------------- */

function polygonArea(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

// Clip a (possibly concave) subject polygon against an axis-aligned rectangle.
// Sutherland–Hodgman is valid here because the *clip window* is convex.
function clipToRect(subject, xmin, ymin, xmax, ymax) {
  const clipEdge = (poly, inside, intersect) => {
    if (poly.length === 0) return poly;
    const out = [];
    let prev = poly[poly.length - 1];
    let prevIn = inside(prev);
    for (const cur of poly) {
      const curIn = inside(cur);
      if (curIn) {
        if (!prevIn) out.push(intersect(prev, cur));
        out.push(cur);
      } else if (prevIn) {
        out.push(intersect(prev, cur));
      }
      prev = cur; prevIn = curIn;
    }
    return out;
  };

  const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

  let poly = subject;
  // left  x >= xmin
  poly = clipEdge(poly, p => p.x >= xmin, (a, b) => lerp(a, b, (xmin - a.x) / (b.x - a.x)));
  // right x <= xmax
  poly = clipEdge(poly, p => p.x <= xmax, (a, b) => lerp(a, b, (xmax - a.x) / (b.x - a.x)));
  // bottom y >= ymin
  poly = clipEdge(poly, p => p.y >= ymin, (a, b) => lerp(a, b, (ymin - a.y) / (b.y - a.y)));
  // top y <= ymax
  poly = clipEdge(poly, p => p.y <= ymax, (a, b) => lerp(a, b, (ymax - a.y) / (b.y - a.y)));
  return poly;
}

function rotate(p, cx, cy, cos, sin) {
  const dx = p.x - cx, dy = p.y - cy;
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
}

/* ---- Input parsing ------------------------------------------------------- */

// Returns { polygons: [[{x,y}...], ...] } or throws with a readable message.
function parseRooms(text) {
  const blocks = text.split(/\n\s*\n/);
  const polygons = [];
  for (const block of blocks) {
    const pts = [];
    for (const raw of block.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      const parts = line.split(/[,\s]+/).map(Number);
      if (parts.length < 2 || parts.some(v => !Number.isFinite(v))) {
        throw new Error(`Can't read coordinate: "${line}"`);
      }
      pts.push({ x: parts[0], y: parts[1] });
    }
    if (pts.length === 0) continue;
    if (pts.length < 3) throw new Error("Each room needs at least 3 corners.");
    polygons.push(pts);
  }
  if (polygons.length === 0) throw new Error("Enter at least one room outline.");
  return polygons;
}

/* ---- Layout computation -------------------------------------------------- */

const MAX_TILES = 250000; // safety cap against absurd tile/room ratios

// Compute the tile layout. All maths happen in "grid space" — the world
// rotated by -rotation around the origin, so tiles are axis-aligned there.
function computeLayout(cfg) {
  const { polygons, tileSize, grout, rotationDeg, originX, originY, align, rowOffset } = cfg;

  const pitch = tileSize + grout;
  if (pitch <= 0) throw new Error("Tile size must be positive.");

  const theta = (-rotationDeg * Math.PI) / 180; // world -> grid
  const cos = Math.cos(theta), sin = Math.sin(theta);
  const icos = Math.cos(-theta), isin = Math.sin(-theta); // grid -> world

  // Room polygons in grid space, and their combined bounding box.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const gridPolys = polygons.map(poly =>
    poly.map(p => {
      const g = rotate(p, originX, originY, cos, sin);
      if (g.x < minX) minX = g.x; if (g.x > maxX) maxX = g.x;
      if (g.y < minY) minY = g.y; if (g.y > maxY) maxY = g.y;
      return g;
    })
  );

  // Base offset so a tile edge (corner mode) or centre (center mode) lands on origin.
  const base = align === "center" ? tileSize / 2 : 0;
  const x0 = originX - base; // grid-space x of tile column 0's left edge
  const y0 = originY - base;

  const iStart = Math.floor((minX - x0) / pitch) - 1;
  const iEnd   = Math.ceil((maxX - x0) / pitch) + 1;
  const jStart = Math.floor((minY - y0) / pitch) - 1;
  const jEnd   = Math.ceil((maxY - y0) / pitch) + 1;

  const estimate = (iEnd - iStart + 1) * (jEnd - jStart + 1);
  if (estimate > MAX_TILES) {
    throw new Error("Tile is tiny relative to the room — increase tile size.");
  }

  const frac = v => v - Math.floor(v);
  const tileArea = tileSize * tileSize;
  const epsArea = tileArea * EPS_RATIO;
  const fullArea = tileArea * (1 - 1e-6);

  const tiles = []; // { corners: [world pts...], cut: bool }
  let full = 0, cut = 0;

  for (let j = jStart; j <= jEnd; j++) {
    // Running/third bond: shift each row by a fraction of the pitch.
    const shift = frac(j * rowOffset) * pitch;
    const ty0 = y0 + j * pitch;
    for (let i = iStart; i <= iEnd; i++) {
      const tx0 = x0 + i * pitch + shift;
      const rxmin = tx0, rxmax = tx0 + tileSize;
      const rymin = ty0, rymax = ty0 + tileSize;

      // Sum coverage across all room polygons.
      let covered = 0;
      for (const gp of gridPolys) {
        const clipped = clipToRect(gp, rxmin, rymin, rxmax, rymax);
        if (clipped.length >= 3) covered += polygonArea(clipped);
      }
      if (covered <= epsArea) continue;

      const isCut = covered < fullArea;
      isCut ? cut++ : full++;

      // Tile square corners back in world space (for drawing).
      const corners = [
        { x: rxmin, y: rymin }, { x: rxmax, y: rymin },
        { x: rxmax, y: rymax }, { x: rxmin, y: rymax },
      ].map(p => rotate(p, originX, originY, icos, isin));
      tiles.push({ corners, cut: isCut });
    }
  }

  let area = 0;
  for (const poly of polygons) area += polygonArea(poly);

  return { tiles, full, cut, total: full + cut, area };
}

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

  const full = css("--tile-full"), fullLine = css("--tile-full-line"), cut = css("--cut");
  ctx.lineWidth = 1;
  for (const t of state.layout.tiles) {
    ctx.beginPath();
    t.corners.forEach((p, i) => {
      const s = toScreen(p);
      i === 0 ? ctx.moveTo(s.x, s.y) : ctx.lineTo(s.x, s.y);
    });
    ctx.closePath();
    ctx.fillStyle = t.cut ? cut : full;
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

  drawOrigin();
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

/* ---- Units & formatting -------------------------------------------------- */

const UNIT = { m: "m", cm: "cm", mm: "mm", ft: "ft", in: "in" };

function fmtArea(v, unit) {
  const u = UNIT[unit] || unit;
  return `${v.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${u}²`;
}

/* ---- Wiring -------------------------------------------------------------- */

const $ = id => document.getElementById(id);
const inputs = ["units", "coords", "tileSize", "grout", "pattern", "rotation",
  "originX", "originY", "align", "waste"].map($);
const errorEl = $("error");

function readConfig() {
  return {
    units: $("units").value,
    tileSize: parseFloat($("tileSize").value),
    grout: parseFloat($("grout").value) || 0,
    rotationDeg: parseFloat($("rotation").value) || 0,
    originX: parseFloat($("originX").value) || 0,
    originY: parseFloat($("originY").value) || 0,
    align: $("align").value,
    rowOffset: parseFloat($("pattern").value) || 0,
    waste: parseFloat($("waste").value) || 0,
  };
}

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.hidden = false;
  state.layout = null;
  ["stTotal", "stFull", "stCut", "stArea", "stBuy"].forEach(id => ($(id).textContent = "–"));
  draw();
}

function recompute(refit) {
  let cfg;
  try {
    cfg = readConfig();
    if (!(cfg.tileSize > 0)) throw new Error("Tile size must be a positive number.");
    const polygons = parseRooms($("coords").value);
    const layout = computeLayout({ ...cfg, polygons });

    state.polygons = polygons;
    state.layout = layout;
    state.origin = { x: cfg.originX, y: cfg.originY };
    errorEl.hidden = true;

    const u = UNIT[cfg.units];
    $("stTotal").textContent = layout.total.toLocaleString();
    $("stFull").textContent = layout.full.toLocaleString();
    $("stCut").textContent = layout.cut.toLocaleString();
    $("stArea").textContent = fmtArea(layout.area, cfg.units);
    const buy = Math.ceil(layout.total * (1 + cfg.waste / 100));
    $("stBuy").textContent = buy.toLocaleString();

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

function nearOrigin(sx, sy) {
  const s = toScreen(state.origin);
  return Math.hypot(sx - s.x, sy - s.y) < 14;
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
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener("pointermove", e => {
  if (!dragging) return;
  const r = canvas.getBoundingClientRect();
  const sx = e.clientX - r.left, sy = e.clientY - r.top;
  if (dragging === "origin") {
    setOriginFromScreen(sx, sy);
  } else {
    view.tx += sx - last.x;
    view.ty += sy - last.y;
    draw();
  }
  last = { x: sx, y: sy };
});

function endDrag() {
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

/* ---- Shareable links ----------------------------------------------------- */
// Every input is persisted by its element id, so the query string is a
// complete, human-readable snapshot of the specs.
const SHARE_FIELDS = inputs.map(el => el.id);

function loadFromURL() {
  const params = new URLSearchParams(location.search);
  let found = false;
  for (const id of SHARE_FIELDS) {
    if (params.has(id)) { $(id).value = params.get(id); found = true; }
  }
  return found;
}

function buildShareURL() {
  const params = new URLSearchParams();
  for (const id of SHARE_FIELDS) params.set(id, $(id).value);
  return `${location.origin}${location.pathname}?${params.toString()}`;
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

/* Boot */
resizeCanvas();
loadFromURL();
recompute(true);
