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
2. **Tiles** — set the square tile side, the grout/joint width, the laying
   pattern (stacked grid, running ½ bond, third ⅓ bond) and an optional
   rotation angle.
3. **Origin** — the point the first tile is laid from. Type coordinates,
   click **Set origin** and click on the plan, or just drag the ✛ marker.
   Choose whether a tile *corner* or *centre* sits on the origin.
4. **Purchasing** — set a waste/breakage margin to get a recommended
   purchase quantity.

Results update live: total tiles, full vs. cut tiles, room area, and the
quantity to buy with margin. Scroll to zoom and drag to pan the plan.

**Share link** encodes every spec into the URL query string (and copies it to
your clipboard) so you can send a fully pre-filled plan to someone else.

## How the count works

Tiles are generated on an axis-aligned grid in a frame rotated around the
origin. Each candidate tile square is intersected with the room polygon using
Sutherland–Hodgman clipping (valid for concave rooms because the clip window —
the tile — is convex). A tile counts if any of its area falls inside the room;
it's **full** when the whole square is covered and **cut** otherwise.

## Deploying to GitHub Pages

The included workflow (`.github/workflows/deploy.yml`) publishes the repo root
on every push to `main`. In the repository settings, set **Pages → Build and
deployment → Source** to **GitHub Actions**. The `.nojekyll` file keeps Pages
from mangling the static assets.

To run locally, just open `index.html`, or serve the folder:

```sh
python3 -m http.server
```
