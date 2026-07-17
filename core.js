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
  const { polygons, grout, rotationDeg, originX, originY, align, rowOffset, seam } = cfg;
  // Rectangular tiles / planks: separate width (X) and height (Y).
  const tileW = cfg.tileW, tileH = cfg.tileH;
  // Flag cut pieces more elongated than this (long side / short side). Applies
  // to strips and corner pieces alike, so no piece has a too-thin side.
  const maxAspect = cfg.maxAspect > 1 ? cfg.maxAspect : 0;

  const pitchX = tileW + grout, pitchY = tileH + grout;
  if (pitchX <= 0 || pitchY <= 0) throw new Error("Tile size must be positive.");

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
  const baseX = align === "center" ? tileW / 2 : 0;
  const baseY = align === "center" ? tileH / 2 : 0;
  const x0 = originX - baseX; // grid-space x of tile column 0's left edge
  const y0 = originY - baseY;

  const iStart = Math.floor((minX - x0) / pitchX) - 1;
  const iEnd   = Math.ceil((maxX - x0) / pitchX) + 1;
  const jStart = Math.floor((minY - y0) / pitchY) - 1;
  const jEnd   = Math.ceil((maxY - y0) / pitchY) + 1;

  const estimate = (iEnd - iStart + 1) * (jEnd - jStart + 1);
  if (estimate > MAX_TILES) {
    throw new Error("Tile is tiny relative to the room — increase tile size.");
  }

  const frac = v => v - Math.floor(v);
  const tileArea = tileW * tileH;
  const epsArea = tileArea * EPS_RATIO;
  const fullArea = tileArea * (1 - 1e-6);

  // Running seam: each row is offset by the previous row's end-offcut. For a
  // rectangular room that offcut is constant, so the offset steps by
  // (−roomWidth) mod pitch each row — a continuous staggered seam.
  const roomW = maxX - minX;
  const seamStep = seam ? (((-roomW) % pitchX) + pitchX) % pitchX : 0;

  const tiles = []; // { num, corners:[world], cut, label:{x,y}, w?, h?, sliver? }
  let full = 0, cut = 0, slivers = 0;

  for (let j = jStart; j <= jEnd; j++) {
    // Per-row X shift: running seam, running/third bond, or none.
    const shift = seam
      ? (((j * seamStep) % pitchX) + pitchX) % pitchX
      : frac(j * rowOffset) * pitchX;
    const ty0 = y0 + j * pitchY;
    for (let i = iStart; i <= iEnd; i++) {
      const tx0 = x0 + i * pitchX + shift;
      const rxmin = tx0, rxmax = tx0 + tileW;
      const rymin = ty0, rymax = ty0 + tileH;

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
        // Sliver: a cut piece too elongated (long side / short side).
        if (maxAspect > 0) {
          const lo = Math.min(tile.w, tile.h), hi = Math.max(tile.w, tile.h);
          if (lo <= 1e-9 || hi / lo > maxAspect) { tile.sliver = true; slivers++; }
        }
      }
      tiles.push(tile);
    }
  }

  // Number tiles in laid order (bottom-to-top, left-to-right).
  tiles.forEach((t, k) => { t.num = k + 1; });

  let area = 0;
  for (const poly of polygons) area += polygonArea(poly);

  return { tiles, full, cut, slivers, area, tileW, tileH };
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

function packCuts(tiles, tileW, tileH, kerf, reuse) {
  const TW = tileW, TH = tileH;
  const EW = TW * 1e-4, EH = TH * 1e-4;      // "full length" tolerances
  const isFullW = d => d >= TW - Math.max(1e-9, EW);
  const isFullH = d => d >= TH - Math.max(1e-9, EH);
  const squareTile = Math.abs(TW - TH) < Math.min(EW, EH) + 1e-9; // rotation only for squares
  const stocks = [];
  const free = []; // { stock, x, y, w, h, fL, fR, fB, fT }

  const openStock = (withFree) => {
    const s = { id: stocks.length + 1, tileW: TW, tileH: TH, pieces: [] };
    stocks.push(s);
    if (withFree) free.push({ stock: s.id, x: 0, y: 0, w: TW, h: TH, fL: true, fR: true, fB: true, fT: true });
    return s;
  };

  // Place a footprint (fw × fh) in region R; `rot` records whether the piece's
  // stored shape is turned 90°. Returns { place, leftovers, waste } or null.
  function placeFootprint(R, fw, fh, rot) {
    const gap = Math.max(TW, TH) * 1e-6; // fit tolerance (absorbs clip round-off)
    const fwFull = isFullW(fw), fhFull = isFullH(fh);
    const waste = R.w * R.h - fw * fh;

    // Whole tile: only a pristine full region.
    if (fwFull && fhFull) {
      if (R.w < TW - EW || R.h < TH - EH || !(R.fL && R.fR && R.fB && R.fT)) return null;
      return { place: { x: R.x, y: R.y, w: TW, h: TH, rot }, leftovers: [], waste: 0 };
    }

    // Vertical strip: full-height band against a vertical factory side.
    if (fhFull) {
      if (!(R.fT && R.fB) || R.h < TH - EH || fw > R.w + gap) return null;
      const leftW = R.w - fw - kerf;
      if (R.fL) return { place: { x: R.x, y: R.y, w: fw, h: TH, rot },
        leftovers: leftW > gap ? [{ stock: R.stock, x: R.x + fw + kerf, y: R.y, w: leftW, h: TH, fL: false, fR: R.fR, fB: true, fT: true }] : [], waste };
      if (R.fR) return { place: { x: R.x + R.w - fw, y: R.y, w: fw, h: TH, rot },
        leftovers: leftW > gap ? [{ stock: R.stock, x: R.x, y: R.y, w: leftW, h: TH, fL: R.fL, fR: false, fB: true, fT: true }] : [], waste };
      return null;
    }

    // Horizontal strip: full-width band against a horizontal factory side.
    if (fwFull) {
      if (!(R.fL && R.fR) || R.w < TW - EW || fh > R.h + gap) return null;
      const leftH = R.h - fh - kerf;
      if (R.fB) return { place: { x: R.x, y: R.y, w: TW, h: fh, rot },
        leftovers: leftH > gap ? [{ stock: R.stock, x: R.x, y: R.y + fh + kerf, w: TW, h: leftH, fL: R.fL, fR: R.fR, fB: false, fT: R.fT }] : [], waste };
      if (R.fT) return { place: { x: R.x, y: R.y + R.h - fh, w: TW, h: fh, rot },
        leftovers: leftH > gap ? [{ stock: R.stock, x: R.x, y: R.y, w: TW, h: leftH, fL: R.fL, fR: R.fR, fB: R.fB, fT: false }] : [], waste };
      return null;
    }

    // Corner piece: one region corner with two adjacent factory sides.
    const pw = fw, ph = fh;
    if (pw > R.w + gap || ph > R.h + gap) return null;
    const topH = R.h - ph - kerf, sideW = R.w - pw - kerf;
    const colTop = topH > gap, rowRight = sideW > gap;
    if (R.fB && R.fL) {                                    // bottom-left
      const lo = [];
      if (colTop) lo.push({ stock: R.stock, x: R.x, y: R.y + ph + kerf, w: R.w, h: topH, fL: R.fL, fR: R.fR, fB: false, fT: R.fT });
      if (rowRight) lo.push({ stock: R.stock, x: R.x + pw + kerf, y: R.y, w: sideW, h: ph, fL: false, fR: R.fR, fB: R.fB, fT: false });
      return { place: { x: R.x, y: R.y, w: pw, h: ph, rot }, leftovers: lo, waste };
    }
    if (R.fB && R.fR) {                                    // bottom-right
      const lo = [];
      if (colTop) lo.push({ stock: R.stock, x: R.x, y: R.y + ph + kerf, w: R.w, h: topH, fL: R.fL, fR: R.fR, fB: false, fT: R.fT });
      if (rowRight) lo.push({ stock: R.stock, x: R.x, y: R.y, w: sideW, h: ph, fL: R.fL, fR: false, fB: R.fB, fT: false });
      return { place: { x: R.x + R.w - pw, y: R.y, w: pw, h: ph, rot }, leftovers: lo, waste };
    }
    if (R.fT && R.fL) {                                    // top-left
      const lo = [];
      if (colTop) lo.push({ stock: R.stock, x: R.x, y: R.y, w: R.w, h: topH, fL: R.fL, fR: R.fR, fB: R.fB, fT: false });
      if (rowRight) lo.push({ stock: R.stock, x: R.x + pw + kerf, y: R.y + R.h - ph, w: sideW, h: ph, fL: false, fR: R.fR, fB: false, fT: R.fT });
      return { place: { x: R.x, y: R.y + R.h - ph, w: pw, h: ph, rot }, leftovers: lo, waste };
    }
    if (R.fT && R.fR) {                                    // top-right
      const lo = [];
      if (colTop) lo.push({ stock: R.stock, x: R.x, y: R.y, w: R.w, h: topH, fL: R.fL, fR: R.fR, fB: R.fB, fT: false });
      if (rowRight) lo.push({ stock: R.stock, x: R.x, y: R.y + R.h - ph, w: sideW, h: ph, fL: R.fL, fR: false, fB: false, fT: R.fT });
      return { place: { x: R.x + R.w - pw, y: R.y + R.h - ph, w: pw, h: ph, rot }, leftovers: lo, waste };
    }
    return null;
  }

  // Try both orientations when the tile is square (a rotated piece can fill an
  // offcut); for rectangular tiles/planks the orientation is fixed by the grid.
  function tryPlace(R, piece) {
    const a = placeFootprint(R, piece.w, piece.h, false);
    if (!squareTile || Math.abs(piece.w - piece.h) < 1e-12) return a;
    const b = placeFootprint(R, piece.h, piece.w, true);
    if (!a) return b;
    if (!b) return a;
    return b.waste < a.waste ? b : a;
  }

  // Hardest pieces first (biggest area), so small offcuts fill the gaps.
  const order = tiles.filter(t => t.cut)
    .sort((a, b) => (b.w * b.h) - (a.w * a.h) || Math.max(b.w, b.h) - Math.max(a.w, a.h));

  for (const piece of order) {
    // A near-full tile (both sides full) can only come from a whole tile.
    if (!reuse || (isFullW(piece.w) && isFullH(piece.h))) {
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

/* ---- Underlayment membrane (rolls, e.g. Ditra) --------------------------- */
//
// Membrane is butt-jointed and laid in parallel strips of a fixed roll width.
// The roll length needed is the total run of those strips. We lay bands of
// `rollWidth` across the room, clip the room to each band, and sum each band's
// span in the strip direction — so L-shaped rooms only count where they exist.
// Both orientations are tried; the one needing less roll length wins.

function membraneRoll(polygons, rollWidth) {
  if (!(rollWidth > 0)) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const poly of polygons) for (const p of poly) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }

  const run = (alongX) => {
    const lo0 = alongX ? minY : minX, hi0 = alongX ? maxY : maxX;
    const nb = Math.max(1, Math.ceil((hi0 - lo0) / rollWidth - 1e-9));
    let length = 0, strips = 0;
    for (let k = 0; k < nb; k++) {
      const a = lo0 + k * rollWidth, b = a + rollWidth;
      let lo = Infinity, hi = -Infinity;
      for (const poly of polygons) {
        const clip = alongX
          ? clipToRect(poly, minX - 1, a, maxX + 1, b)   // horizontal band
          : clipToRect(poly, a, minY - 1, b, maxY + 1);  // vertical band
        for (const p of clip) {
          const v = alongX ? p.x : p.y;
          if (v < lo) lo = v; if (v > hi) hi = v;
        }
      }
      if (hi > lo) { length += hi - lo; strips++; }
    }
    return { length, strips };
  };

  const h = run(true), v = run(false);
  return h.length <= v.length
    ? { length: h.length, strips: h.strips, direction: "horizontal", rollWidth }
    : { length: v.length, strips: v.strips, direction: "vertical", rollWidth };
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
