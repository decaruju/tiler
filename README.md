# Tiler — ceramic tile layout planner

A single-page web app for planning square-tile floor/wall layouts. Enter a
room outline, a tile size and an origin point, and Tiler computes the **exact
number of tiles required** and draws how they'll be laid out across the room.

No build step, no dependencies — just static HTML/CSS/JS.

**Live:** https://decaruju.github.io/tiler/

## Using it

1. **Room** — list the room's corner coordinates, one `x, y` vertex per line,
   walking around the perimeter. Concave shapes (L-shapes, alcoves) work.
   Separate multiple rooms with a blank line. Pick the unit that all length
   inputs use.
2. **Tiles** — set the tile **width** and **height** (they can differ, for
   rectangular tiles or planks), the grout/joint width, an optional rotation
   angle, and the laying pattern: stacked grid, running ½ bond, third ⅓ bond,
   or **running seam** for planks — each row is offset by the previous row's
   end-offcut, giving the continuous staggered seam of vinyl/laminate floors
   (and that end offcut is reused to start the next row).
3. **Cutting** — set the saw blade width (kerf) — the material lost on each
   cut — and choose whether to reuse offcuts. With reuse on, one tile is used
   for two edge cuts wherever they fit side by side (see below), lowering the
   number of tiles you actually buy. Set a **max aspect ratio** to flag
   elongated cut pieces (slivers) — any cut whose long side exceeds this many
   times its short side, so both thin strips and thin-sided corner pieces are
   caught. Slivers show in dark red on the plan and are counted; the origin
   search then avoids them first.
4. **Origin** — the point the first tile is laid from. Type coordinates,
   click **Set origin** and click on the plan, or just drag the ✛ marker.
   Choose whether a tile *corner* or *centre* sits on the origin. **Search best
   origin** sweeps every distinct origin offset (the tiling repeats every tile
   pitch) and picks the best one — fewest slivers first, then fewest tiles.
5. **Purchasing** — set a waste/breakage margin, the number of **tiles per
   box** (tiles are sold in packs, so the purchase rounds up to whole boxes),
   and a price per tile to get boxes needed and total cost.

Every laid tile is numbered on the plan (zoom in if they're hidden). The
**cut sheet** below the plan lists each cut piece by number and bounding-box
size, grouped by the physical tile it's cut from. **Click any cut tile on the
plan** (or a number in the cut sheet) to open a diagram of that whole tile with
every piece nested in place, showing the cuts and the leftover waste.

Results update live: tiles required, full vs. cut counts, room area, quantity
to buy with margin, boxes needed and total cost. Scroll to zoom, drag to pan.

**Share link** encodes every spec into the URL query string (and copies it to
your clipboard) so you can send a fully pre-filled plan to someone else.

**Generate cut sheet** opens a printable page (`print.html`) — the room plan,
every per-tile cut diagram, and all the specs — with the parameters carried in
its URL, so it recomputes from the URL and can be printed or saved to PDF.

## How the count works

Tiles are generated on an axis-aligned grid (tile width × height, per-row
X offset by the pattern) in a frame rotated around the origin. Each candidate
tile rectangle is intersected with the room polygon using Sutherland–Hodgman
clipping (valid for concave rooms because the clip window — the tile — is
convex). A tile counts if any of its area falls inside the room; it's **full**
when the whole rectangle is covered and **cut** otherwise.

Cut pieces are then packed into as few whole tiles as possible, subject to a
real-world constraint: a tile's factory edges must sit on the grout line and
every *cut* edge must go against a wall. So a reused piece has to keep the
original tile's outer edge on each of its grout-facing sides — an edge strip
(full length in one direction) needs the outer edge on 3 sides and sits as a
band against one tile edge; a corner piece (shorter than a tile on both sides)
needs it on 2 adjacent sides and sits in one corner of the tile. The packer is
a guillotine bin-packer that tracks, for every leftover region, which of its
four sides are still on the tile's perimeter, so it will fit multiple strips
and corner pieces into a single tile (e.g. all four corner cuts of a room can
come from one tile) as long as each piece's grout-facing edges land on a
factory edge. Pieces may be rotated 90° to fit a fresh tile or an offcut. "Tiles required" is the full tiles plus the tiles consumed by
that packing, and the purchase is then rounded up to whole boxes.

## Deploying to GitHub Pages

Pages is served straight from the branch. In the repository settings, set
**Pages → Build and deployment → Source** to **Deploy from a branch** and pick
`main` / root. The `.nojekyll` file keeps Pages from mangling the static assets.

To run locally, just open `index.html`, or serve the folder:

```sh
python3 -m http.server
```
