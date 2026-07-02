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

// Area-based centroid; falls back to the vertex average for degenerate polys.
function polygonCentroid(pts) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    const cross = p.x * q.y - q.x * p.y;
    a += cross;
    cx += (p.x + q.x) * cross;
    cy += (p.y + q.y) * cross;
  }
  if (Math.abs(a) < 1e-12) {
    let sx = 0, sy = 0;
    for (const p of pts) { sx += p.x; sy += p.y; }
    return { x: sx / pts.length, y: sy / pts.length };
  }
  return { x: cx / (3 * a), y: cy / (3 * a) };
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

  const tiles = []; // { num, corners:[world], cut, label:{x,y}, w?, h? }
  let full = 0, cut = 0;

  for (let j = jStart; j <= jEnd; j++) {
    // Running/third bond: shift each row by a fraction of the pitch.
    const shift = frac(j * rowOffset) * pitch;
    const ty0 = y0 + j * pitch;
    for (let i = iStart; i <= iEnd; i++) {
      const tx0 = x0 + i * pitch + shift;
      const rxmin = tx0, rxmax = tx0 + tileSize;
      const rymin = ty0, rymax = ty0 + tileSize;

      // Sum coverage across all room polygons, tracking the clipped piece's
      // bounding box (its cut dimensions) and area-weighted centroid.
      let covered = 0;
      let cxmin = Infinity, cymin = Infinity, cxmax = -Infinity, cymax = -Infinity;
      let cenX = 0, cenY = 0, cenW = 0;
      const clips = []; // clipped piece rings, in grid space
      for (const gp of gridPolys) {
        const clipped = clipToRect(gp, rxmin, rymin, rxmax, rymax);
        if (clipped.length >= 3) {
          const a = polygonArea(clipped);
          covered += a;
          clips.push(clipped);
          for (const p of clipped) {
            if (p.x < cxmin) cxmin = p.x; if (p.x > cxmax) cxmax = p.x;
            if (p.y < cymin) cymin = p.y; if (p.y > cymax) cymax = p.y;
          }
          const c = polygonCentroid(clipped);
          cenX += c.x * a; cenY += c.y * a; cenW += a;
        }
      }
      if (covered <= epsArea) continue;

      const isCut = covered < fullArea;
      isCut ? cut++ : full++;

      // Tile square corners back in world space (for drawing).
      const corners = [
        { x: rxmin, y: rymin }, { x: rxmax, y: rymin },
        { x: rxmax, y: rymax }, { x: rxmin, y: rymax },
      ].map(p => rotate(p, originX, originY, icos, isin));

      // Label anchor: centroid of the laid piece, back in world space.
      const gLabel = isCut
        ? { x: cenX / cenW, y: cenY / cenW }
        : { x: (rxmin + rxmax) / 2, y: (rymin + rymax) / 2 };
      const label = rotate(gLabel, originX, originY, icos, isin);

      const tile = { corners, cut: isCut, label };
      if (isCut) {
        tile.w = cxmax - cxmin; tile.h = cymax - cymin;
        // Real piece outline(s), relative to the piece's own bounding box.
        tile.shape = clips.map(ring => ring.map(p => ({ x: p.x - cxmin, y: p.y - cymin })));
      }
      tiles.push(tile);
    }
  }

  // Number tiles in laid order (bottom-to-top, left-to-right).
  tiles.forEach((t, k) => { t.num = k + 1; });

  let area = 0;
  for (const poly of polygons) area += polygonArea(poly);

  return { tiles, full, cut, area, tileSize };
}

/* ---- Offcut reuse (factory-edge-aware guillotine) ------------------------ */
//
// Physical constraint: a tile's factory edges must sit on the grout line and
// every *cut* edge must go against a wall. So a reused piece has to keep the
// original tile's outer edge on each of its grout-facing sides:
//   • an edge strip (full length in one direction) needs the tile's outer edge
//     on 3 sides — it sits as a full-length band against one tile edge;
//   • a corner piece (shorter than a tile on both sides) needs the outer edge
//     on 2 adjacent sides — it sits in one corner of the tile.
// We pack pieces with a guillotine scheme that tracks, for every free region,
// which of its four sides are still on the tile's perimeter (factory). A piece
// may only take factory edges from the region's factory sides; each cut then
// removes those sides from the leftover regions.

function packCuts(tiles, tileSize, kerf, reuse) {
  const ts = tileSize;
  const E = ts * 1e-4;                       // "full length" tolerance
  const isFull = d => d >= ts - Math.max(1e-9, E);
  const stocks = [];
  const free = []; // { stock, x, y, w, h, fL, fR, fB, fT }

  const openStock = (withFree) => {
    const s = { id: stocks.length + 1, tileSize: ts, pieces: [] };
    stocks.push(s);
    if (withFree) free.push({ stock: s.id, x: 0, y: 0, w: ts, h: ts, fL: true, fR: true, fB: true, fT: true });
    return s;
  };

  // Try to place `piece` in region R. Returns { place, leftovers, waste } or null.
  function tryPlace(R, piece) {
    const gap = 1e-9;
    const wF = isFull(piece.w), hF = isFull(piece.h);

    // Edge strip: a full-length band against a factory side (laid vertically).
    if (wF || hF) {
      if (!(R.fT && R.fB) || R.h < ts - E) return null;   // needs full-height region
      const c = hF ? piece.w : piece.h;                    // across-wall width
      if (c > R.w + gap) return null;
      const rot = !hF;                                     // rotate a full-width strip upright
      const leftW = R.w - c - kerf;
      if (R.fL) {
        const leftovers = leftW > gap
          ? [{ stock: R.stock, x: R.x + c + kerf, y: R.y, w: leftW, h: ts, fL: false, fR: R.fR, fB: true, fT: true }] : [];
        return { place: { x: R.x, y: R.y, w: c, h: ts, rot }, leftovers, waste: (R.w - c) * ts };
      }
      if (R.fR) {
        const leftovers = leftW > gap
          ? [{ stock: R.stock, x: R.x, y: R.y, w: leftW, h: ts, fL: R.fL, fR: false, fB: true, fT: true }] : [];
        return { place: { x: R.x + R.w - c, y: R.y, w: c, h: ts, rot }, leftovers, waste: (R.w - c) * ts };
      }
      return null;
    }

    // Corner piece: one corner of the region with two adjacent factory sides.
    const pw = piece.w, ph = piece.h;
    if (pw > R.w + gap || ph > R.h + gap) return null;
    const topH = R.h - ph - kerf, sideW = R.w - pw - kerf;
    const waste = R.w * R.h - pw * ph;
    const rowRight = () => sideW > gap;
    const colTop = () => topH > gap;
    if (R.fB && R.fL) {                                    // bottom-left
      const lo = [];
      if (colTop()) lo.push({ stock: R.stock, x: R.x, y: R.y + ph + kerf, w: R.w, h: topH, fL: R.fL, fR: R.fR, fB: false, fT: R.fT });
      if (rowRight()) lo.push({ stock: R.stock, x: R.x + pw + kerf, y: R.y, w: sideW, h: ph, fL: false, fR: R.fR, fB: R.fB, fT: false });
      return { place: { x: R.x, y: R.y, w: pw, h: ph, rot: false }, leftovers: lo, waste };
    }
    if (R.fB && R.fR) {                                    // bottom-right
      const lo = [];
      if (colTop()) lo.push({ stock: R.stock, x: R.x, y: R.y + ph + kerf, w: R.w, h: topH, fL: R.fL, fR: R.fR, fB: false, fT: R.fT });
      if (rowRight()) lo.push({ stock: R.stock, x: R.x, y: R.y, w: sideW, h: ph, fL: R.fL, fR: false, fB: R.fB, fT: false });
      return { place: { x: R.x + R.w - pw, y: R.y, w: pw, h: ph, rot: false }, leftovers: lo, waste };
    }
    if (R.fT && R.fL) {                                    // top-left
      const lo = [];
      if (colTop()) lo.push({ stock: R.stock, x: R.x, y: R.y, w: R.w, h: topH, fL: R.fL, fR: R.fR, fB: R.fB, fT: false });
      if (rowRight()) lo.push({ stock: R.stock, x: R.x + pw + kerf, y: R.y + R.h - ph, w: sideW, h: ph, fL: false, fR: R.fR, fB: false, fT: R.fT });
      return { place: { x: R.x, y: R.y + R.h - ph, w: pw, h: ph, rot: false }, leftovers: lo, waste };
    }
    if (R.fT && R.fR) {                                    // top-right
      const lo = [];
      if (colTop()) lo.push({ stock: R.stock, x: R.x, y: R.y, w: R.w, h: topH, fL: R.fL, fR: R.fR, fB: R.fB, fT: false });
      if (rowRight()) lo.push({ stock: R.stock, x: R.x, y: R.y + R.h - ph, w: sideW, h: ph, fL: R.fL, fR: false, fB: false, fT: R.fT });
      return { place: { x: R.x + R.w - pw, y: R.y + R.h - ph, w: pw, h: ph, rot: false }, leftovers: lo, waste };
    }
    return null;
  }

  // Hardest pieces first (biggest area), so small offcuts fill the gaps.
  const order = tiles.filter(t => t.cut)
    .sort((a, b) => (b.w * b.h) - (a.w * a.h) || Math.max(b.w, b.h) - Math.max(a.w, a.h));

  for (const piece of order) {
    // A near-full tile (both sides full) can only come from a whole tile.
    if (!reuse || (isFull(piece.w) && isFull(piece.h))) {
      const s = openStock(false);
      piece.stock = s.id;
      piece.place = { x: 0, y: 0, w: piece.w, h: piece.h, rot: false };
      s.pieces.push(piece);
      continue;
    }
    // Best-fit across existing offcuts; otherwise open a fresh tile.
    let best = null;
    for (const R of free) {
      const res = tryPlace(R, piece);
      if (res && (!best || res.waste < best.res.waste)) best = { R, res };
    }
    if (!best) {
      openStock(true);
      const R = free[free.length - 1];
      best = { R, res: tryPlace(R, piece) };
    }
    const { R, res } = best;
    piece.stock = R.stock;
    piece.place = res.place;
    stocks[R.stock - 1].pieces.push(piece);
    free.splice(free.indexOf(R), 1);
    for (const lo of res.leftovers) free.push(lo);
  }
  return { stocks };
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

  drawNumbers();
  drawOrigin();
}

// Number every tile — only when tiles are large enough on screen to read.
function drawNumbers() {
  const px = view.scale * (state.layout.tileSize || 0);
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

/* ---- Units & formatting -------------------------------------------------- */

const UNIT = { m: "m", cm: "cm", mm: "mm", ft: "ft", in: "in" };

function fmtArea(v, unit) {
  const u = UNIT[unit] || unit;
  return `${v.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${u}²`;
}

function fmtLen(v, unit) {
  const u = UNIT[unit] || unit;
  return `${v.toLocaleString(undefined, { maximumFractionDigits: 3 })} ${u}`;
}

/* ---- Wiring -------------------------------------------------------------- */

const $ = id => document.getElementById(id);
const inputs = ["units", "coords", "tileSize", "grout", "pattern", "rotation",
  "originX", "originY", "align", "kerf", "reuse", "waste", "box", "price"].map($);
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
    kerf: parseFloat($("kerf").value) || 0,
    reuse: $("reuse").checked,
    waste: parseFloat($("waste").value) || 0,
    box: Math.max(1, Math.floor(parseFloat($("box").value) || 1)),
    price: parseFloat($("price").value) || 0,
  };
}

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.hidden = false;
  state.layout = null;
  ["stTotal", "stFull", "stCut", "stArea", "stBuy", "stBoxes", "stCost"].forEach(id => ($(id).textContent = "–"));
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
    if (!(cfg.tileSize > 0)) throw new Error("Tile size must be a positive number.");
    if (cfg.kerf < 0) throw new Error("Saw kerf can't be negative.");
    const polygons = parseRooms($("coords").value);
    const layout = computeLayout({ ...cfg, polygons });

    // Reuse offcuts to work out how many physical tiles the cuts really need.
    const { stocks } = packCuts(layout.tiles, cfg.tileSize, cfg.kerf, cfg.reuse);
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
    $("stArea").textContent = fmtArea(layout.area, cfg.units);
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
  const ts = stock.tileSize;
  const scale = (size - pad * 2) / ts;
  // Grid (y-up) -> canvas. tileX/tileY in [0, ts].
  const cx = tx => pad + tx * scale;
  const cy = ty => size - pad - ty * scale;

  // Stock tile body = waste/uncut background.
  tileCtx.fillStyle = css("--tile-full");
  tileCtx.strokeStyle = css("--ink");
  tileCtx.lineWidth = 2;
  tileCtx.beginPath();
  tileCtx.rect(cx(0), cy(ts), ts * scale, ts * scale);
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

  const cut = css("--cut");
  for (const piece of stock.pieces) {
    const pl = place(piece);
    const hot = piece.num === highlightNum;
    tileCtx.fillStyle = hot ? css("--accent") : cut;
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
  tileCtx.fillText(`${fmtLen(ts, unit)} × ${fmtLen(ts, unit)} tile`, size / 2, cy(0) + 6);
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

function buildShareURL() {
  const params = new URLSearchParams();
  for (const id of SHARE_FIELDS) {
    const el = $(id);
    params.set(id, el.type === "checkbox" ? (el.checked ? "1" : "0") : el.value);
  }
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
