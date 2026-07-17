"use strict";

/* Printable cut sheet. Reads the specs from the URL query string, recomputes
 * the layout with the shared core.js functions, and renders the whole-room
 * plan plus a per-tile diagram of every cut. */

const PAL = {
  ink: "#23201b", inkSoft: "#6b6357", line: "#ded7c9",
  full: "#d9e2df", fullLine: "#8ba39c", cut: "#e58a5f", sliver: "#8a1e1e", accent: "#b5502e",
  mono: 'ui-monospace, Menlo, Consolas, monospace',
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
};

function paramsToCfg() {
  const q = new URLSearchParams(location.search);
  const num = (k, d) => { const v = parseFloat(q.get(k)); return Number.isFinite(v) ? v : d; };
  const patt = q.get("pattern");
  const legacy = num("tileSize", 0); // older links used a single square size
  return {
    units: q.get("units") || "m",
    coords: q.get("coords") || "",
    tileW: num("tileW", legacy),
    tileH: num("tileH", legacy),
    grout: num("grout", 0),
    rowOffset: patt === "seam" ? 0 : (parseFloat(patt) || 0),
    seam: patt === "seam",
    rotationDeg: num("rotation", 0),
    originX: num("originX", 0),
    originY: num("originY", 0),
    align: q.get("align") || "corner",
    kerf: num("kerf", 0),
    maxAspect: num("maxAspect", 0),
    reuse: q.get("reuse") !== "0",
    rollWidth: num("rollWidth", 0),
    waste: num("waste", 0),
    box: Math.max(1, Math.floor(num("box", 1))),
    price: num("price", 0),
    query: q.toString(),
  };
}

const PATTERN_NAME = { "0": "Grid (stacked)", "0.5": "Running bond ½", "0.3333333": "Third bond ⅓", "seam": "Running seam (plank offcut)" };

function hi(dpr, cvs, wCss, hCss) {
  cvs.width = wCss * dpr; cvs.height = hCss * dpr;
  cvs.style.width = wCss + "px"; cvs.style.height = hCss + "px";
  const c = cvs.getContext("2d");
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  return c;
}

function bounds(polys) {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const p of polys) for (const q of p) {
    if (q.x < a) a = q.x; if (q.x > c) c = q.x;
    if (q.y < b) b = q.y; if (q.y > d) d = q.y;
  }
  return { minX: a, minY: b, maxX: c, maxY: d };
}

// Whole-room plan.
function drawPlan(cvs, layout, polygons, origin, unit) {
  const dpr = window.devicePixelRatio || 1;
  const b = bounds(polygons);
  const pad = 30;
  const wW = Math.max(b.maxX - b.minX, 1e-6), wH = Math.max(b.maxY - b.minY, 1e-6);
  const W = 940, H = Math.max(260, Math.min(680, W * wH / wW + pad * 2));
  const ctx = hi(dpr, cvs, W, H);
  ctx.clearRect(0, 0, W, H);

  const scale = Math.min((W - pad * 2) / wW, (H - pad * 2) / wH);
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  const tx = W / 2 - cx * scale, ty = H / 2 + cy * scale;
  const S = p => ({ x: p.x * scale + tx, y: -p.y * scale + ty });

  const pathP = () => {
    ctx.beginPath();
    for (const poly of polygons) {
      poly.forEach((p, i) => { const s = S(p); i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y); });
      ctx.closePath();
    }
  };

  ctx.fillStyle = "#fff"; pathP(); ctx.fill("evenodd");
  ctx.save(); pathP(); ctx.clip("evenodd");
  ctx.lineWidth = 1;
  for (const t of layout.tiles) {
    ctx.beginPath();
    t.corners.forEach((p, i) => { const s = S(p); i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y); });
    ctx.closePath();
    ctx.fillStyle = t.sliver ? PAL.sliver : t.cut ? PAL.cut : PAL.full;
    ctx.fill();
    ctx.strokeStyle = t.cut ? "rgba(255,255,255,.6)" : PAL.fullLine;
    ctx.stroke();
  }
  ctx.restore();

  ctx.lineJoin = "round"; ctx.lineWidth = 2; ctx.strokeStyle = PAL.ink; pathP(); ctx.stroke();

  const px = scale * Math.min(layout.tileW, layout.tileH);
  if (px >= 16) {
    ctx.font = `600 ${Math.min(12, px * 0.26)}px ${PAL.mono}`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = "rgba(35,32,27,.6)";
    for (const t of layout.tiles) { const s = S(t.label); ctx.fillText(t.num, s.x, s.y); }
  }

  const o = S(origin);
  ctx.strokeStyle = PAL.accent; ctx.fillStyle = PAL.accent; ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(o.x - 10, o.y); ctx.lineTo(o.x + 10, o.y);
  ctx.moveTo(o.x, o.y - 10); ctx.lineTo(o.x, o.y + 10); ctx.stroke();
  ctx.beginPath(); ctx.arc(o.x, o.y, 3.5, 0, Math.PI * 2); ctx.fill();
}

// One physical stock tile with its pieces nested in place.
function drawStock(cvs, stock, unit) {
  const dpr = window.devicePixelRatio || 1;
  const size = 168, pad = 12;
  const ctx = hi(dpr, cvs, size, size);
  ctx.clearRect(0, 0, size, size);
  const TW = stock.tileW, TH = stock.tileH;
  const scale = Math.min((size - pad * 2) / TW, (size - pad * 2) / TH);
  const offX = (size - TW * scale) / 2, offY = (size - TH * scale) / 2;
  const cx = tx => offX + tx * scale, cy = ty => size - offY - ty * scale;

  ctx.fillStyle = PAL.full; ctx.strokeStyle = PAL.ink; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.rect(cx(0), cy(TH), TW * scale, TH * scale); ctx.fill(); ctx.stroke();

  for (const piece of stock.pieces) {
    const pl = piece.place;
    ctx.fillStyle = piece.sliver ? PAL.sliver : PAL.cut; ctx.strokeStyle = "rgba(255,255,255,.85)"; ctx.lineWidth = 1.3;
    for (const ring of (piece.shape || [[]])) {
      ctx.beginPath();
      ring.forEach((q, i) => {
        const nx = pl.rot ? q.y : q.x, ny = pl.rot ? (piece.w - q.x) : q.y;
        const X = cx(pl.x + nx), Y = cy(pl.y + ny);
        i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y);
      });
      ctx.closePath(); ctx.fill(); ctx.stroke();
    }
    ctx.fillStyle = "#fff"; ctx.font = `600 11px ${PAL.mono}`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("#" + piece.num, cx(pl.x + pl.w / 2), cy(pl.y + pl.h / 2));
  }
}

function esc(s) { return String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }

function render() {
  const cfg = paramsToCfg();
  const report = document.getElementById("report");
  document.getElementById("editLink").href = "index.html?" + cfg.query;

  let polygons, layout;
  try {
    if (!(cfg.tileW > 0) || !(cfg.tileH > 0)) throw new Error("Missing or invalid tile size.");
    polygons = parseRooms(cfg.coords);
    layout = computeLayout({ ...cfg, polygons });
    const { stocks } = packCuts(layout.tiles, cfg.tileW, cfg.tileH, cfg.kerf, cfg.reuse);
    layout.stocks = stocks; layout.cutStock = stocks.length; layout.total = layout.full + stocks.length;
  } catch (e) {
    report.innerHTML = `<p class="err">Can't build the cut sheet: ${esc(e.message || e)}</p>`;
    return;
  }

  const u = cfg.units;
  const buy = Math.ceil(layout.total * (1 + cfg.waste / 100));
  const boxes = Math.ceil(buy / cfg.box);
  const tilesBought = boxes * cfg.box;
  const cost = tilesBought * cfg.price;
  const cutCount = layout.tiles.filter(t => t.cut).length;
  const membrane = membraneRoll(polygons, cfg.rollWidth);

  const spec = (k, v) => `<div class="spec"><span class="k">${k}</span><span class="v">${v}</span></div>`;
  const tot = (k, v, big) => `<div class="tot${big ? " big" : ""}"><div class="k">${k}</div><div class="v">${v}</div></div>`;

  const specsHTML = [
    spec("Units", u),
    spec("Tile size", `${fmtLen(cfg.tileW, u)} × ${fmtLen(cfg.tileH, u)}`),
    spec("Grout / joint", fmtLen(cfg.grout, u)),
    spec("Pattern", PATTERN_NAME[cfg.seam ? "seam" : String(cfg.rowOffset)] || `offset ${cfg.rowOffset}`),
    spec("Rotation", `${cfg.rotationDeg}°`),
    spec("Origin", `${cfg.originX}, ${cfg.originY} (${cfg.align})`),
    spec("Saw kerf", fmtLen(cfg.kerf, u)),
    spec("Max aspect ratio", cfg.maxAspect > 1 ? `${cfg.maxAspect}:1` : "—"),
    spec("Reuse offcuts", cfg.reuse ? "yes" : "no"),
    membrane ? spec("Membrane roll", `${fmtLen(cfg.rollWidth, u)} wide → ${membrane.strips} strips`) : "",
    spec("Waste margin", `${cfg.waste}%`),
    spec("Tiles per box", cfg.box),
    spec("Price per tile", cfg.price || "—"),
  ].join("");

  const totalsHTML = [
    tot("Tiles required", layout.total.toLocaleString(), true),
    tot("Full tiles", layout.full.toLocaleString()),
    tot("Cut pieces", cutCount.toLocaleString()),
    cfg.maxAspect > 1 ? tot("Slivers", layout.slivers.toLocaleString()) : "",
    tot("Room area", fmtArea(layout.area, u)),
    membrane ? tot("Membrane roll", fmtLen(membrane.length, u)) : "",
    tot("Buy w/ margin", buy.toLocaleString()),
    tot("Boxes", cfg.box > 1 ? `${boxes} (${tilesBought})` : boxes),
    cfg.price > 0 ? tot("Total cost", cost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })) : "",
  ].join("");

  const saved = cutCount - layout.cutStock;
  const cutsIntro = cutCount === 0
    ? `<p class="sub">No cuts needed — every tile is laid whole.</p>`
    : `<p class="sub"><strong>${cutCount}</strong> cut piece${cutCount === 1 ? "" : "s"} from ` +
      `<strong>${layout.cutStock}</strong> tile${layout.cutStock === 1 ? "" : "s"}` +
      (saved > 0 ? ` — reusing offcuts saves <strong>${saved}</strong> tile${saved === 1 ? "" : "s"}` : "") +
      `. Each diagram shows one whole tile; # matches the plan.</p>`;

  report.innerHTML =
    `<h1>Tiler — Cut Sheet</h1>
     <p class="sub">Generated from the specs in this page's URL.</p>
     <h2>Specifications</h2>
     <div class="specs">${specsHTML}</div>
     <h2>Totals</h2>
     <div class="totals">${totalsHTML}</div>
     <h2>Room plan</h2>
     <canvas id="plan"></canvas>
     <h2>Cuts</h2>
     ${cutsIntro}
     <div class="stocks" id="stocks"></div>`;

  drawPlan(document.getElementById("plan"), layout, polygons, { x: cfg.originX, y: cfg.originY }, u);

  const wrap = document.getElementById("stocks");
  for (const s of layout.stocks) {
    const pieces = [...s.pieces].sort((a, b) => a.num - b.num);
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML =
      `<canvas></canvas>
       <h3>Tile ${s.id} — ${pieces.length} piece${pieces.length === 1 ? "" : "s"}</h3>
       <ul>${pieces.map(p => `<li><span class="n">#${p.num}</span><span class="s">${fmtLen(p.w, u)} × ${fmtLen(p.h, u)}</span></li>`).join("")}</ul>`;
    wrap.appendChild(card);
    drawStock(card.querySelector("canvas"), s, u);
  }

  document.title = `Tiler Cut Sheet — ${layout.total} tiles`;
}

render();
