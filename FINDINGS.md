# Findings

What the prototype has answered so far, and what it has not. Written against
the questions in `level-editor-design-brief.md`.

Everything here is measured in this repository unless it says otherwise. Where
a question needs the artist or a real GPU, it says that instead of guessing.

**This is a prototype log, not a living document.** It is kept for the
measurements. The open questions it raised have moved to issues, which is where
they are now tracked:

- [#16](https://github.com/Syynth/map-editor/issues/16) — confirm pixel art in perspective on a real GPU
- [#17](https://github.com/Syynth/map-editor/issues/17) — run the template sheet test with Kenney Tiny Town
- [#18](https://github.com/Syynth/map-editor/issues/18) — decide how much gameplay data levels carry
- [#19](https://github.com/Syynth/map-editor/issues/19) — confirm whether bloom-renders-black is SwiftShader-only

Electron vs Tauri, the prefabs and reuse model, and moving the mesher into a
worker are tracked as fog on the wayfinder map,
[#2](https://github.com/Syynth/map-editor/issues/2), rather than as issues.

---

## Answered

### Is TypeScript meshing in a worker fast enough while brushing?

**Yes, and the worker is not needed yet.** Measured with `npm run bench` on the
real mesher, not a stand-in:

| | |
|---|---|
| One chunk (16×16 cells, hilly) | **1.0 ms** |
| A full 128×128 map (64 chunks) | **53 ms** |

The number that matters is a brush tick. Naively dirtying the 3×3 chunk
neighbourhood around the cursor every tick cost **6.9 ms** — 41% of a 60fps
frame, which is too much to spend on meshing alone. Restricting the neighbour
dirtying to cells actually on a chunk border brought the common case down to
**one chunk, ~1 ms**, leaving the 9-chunk worst case for the rare stroke landing
exactly on a chunk corner.

So: main-thread meshing is comfortable at these sizes. The mesher is a pure
function with no three.js import, so moving it into a worker stays a wiring
change rather than a rewrite. Revisit if maps get much past 128×128 or if the
per-cell work grows (a profile strip sweep would roughly double it).

### Can the coverage readout turn "do we want rotation?" into a real trade-off?

**Yes, and it is the most useful thing in the prototype.** On the sample map,
24 objects:

| Camera bounds | Objects reading wrong | Extra images to fix | Cliff faces never visible |
|---|---|---|---|
| Free 360° rotation | 3 of 24 | 3 | 0% (0 of 1210) |
| Narrow (20–70°) | 3 of 24 | 3 | **50%** (605 of 1210) |

Three things fall out of this that were not obvious from the brief:

1. **`auto` display mode does most of the work.** 22 of the 24 objects have a
   single facing, and under free rotation almost none of them read wrong,
   because `auto` resolves them to Y-billboards. The art cost of rotation is
   only paid by objects the artist *deliberately* makes flat planes — signs,
   statues, anything with real sides. That reframes the question: rotation is
   cheap for scenery and expensive for characters and signage.

2. **Narrowing the camera does not fix a flat plane.** This one contradicts
   what I first assumed. The three flagged objects still read wrong at a 50°
   yaw range, because a fixed plane only works if it happens to *face* the
   envelope — and the sample rotates its props freely. Tightening the bounds
   is not a lever on that problem at all; orientation and display mode are.
   An earlier version of this document claimed narrow bounds took the count to
   zero. That was wrong, and the walkthrough capture caught it.

3. **The hidden-surface payoff is real and large.** Under a narrow yaw range
   50% of cliff faces can never be seen from any permitted angle — 605 of 1210.
   That is half the cliff painting the artist never has to do, and geometry the
   mesher could skip. Under free rotation it is 0%. This, not the object count,
   is the quantified argument for constraining the camera.

The readout is in the Camera tab, live, and flags each offending object with a
one-click fix.

### How much of the sky is ever visible?

**Very little, at the pitches this look wants.** At the sample rig (pitch 34°,
30° FOV) the horizon sits near the top edge of the frame and the visible sky is
almost entirely the *horizon* colour — the blue of `skyTop` barely appears at
all. Raising the pitch shows less sky, not more.

The practical consequence matches the brief's suspicion: **fog colour and
backdrop cards matter much more than the skybox.** The gradient sky is nearly
free so it can stay, but effort belongs in the horizon band and in painted
backdrop layers. A full cubemap or HDR sky would be close to invisible.

### Does "paint survives sculpt" work?

**Yes, and it needed no cleanup code at all.** Paint is keyed by cell, side and
*absolute half-tile level*. Lowering a cliff stops those bands being meshed and
leaves their paint untouched in the document; raising it back resolves the same
keys and the work reappears. The mechanism is simply that sculpt operations
never write to the paint layers.

There is a test that lowers a painted cliff, asserts the band is gone from the
mesh, asserts the paint is still in the document, raises it back and asserts the
band returns. The editor shows a live count of dormant paint in the status bar,
so the artist can see preservation rather than being asked to trust it.

Indexing by absolute level — rather than by a row counted from the top, or a row
of a swept profile — is also what will let the section 5 profile strip change a
cliff's cross-section without scrambling paint. That is now a cheap change
rather than a data migration.

---

## Partly answered

### Pixel art in perspective: crisp or soft?

Tiles hold up well at the sample rig, with half-texel UV insets and nearest
filtering plus mipmaps. Screenshots at a range of pitches are in `shots/`.

**But this has not been tested on real hardware.** Everything here rendered
through SwiftShader, a software rasterizer, at 3–7 fps. Shimmering at distance
is exactly the kind of artefact that depends on real mipmap and anisotropy
behaviour, so the honest answer is that the *structure* is in place —
per-map texel density, a resolution profile, nearest/linear switching, mismatch
warnings on sheet load — and the visual judgement still needs a GPU and an
artist looking at it.

### Electron or Tauri?

**Not answered, and deliberately not attempted.** The prototype is a plain Vite
web app, which keeps the decision open at no cost. The brief is right that a
heavy-scene smoke test on the target platforms should decide it, and that test
needs real GPUs — it cannot be run here. There is now a heavy scene to run it
with.

---

## Not yet answered

These need the artist, and no amount of prototyping substitutes:

- **Can the artist understand the template sheets?** The layout is implemented
  and documented, and the generated placeholder sheet draws connection rims on
  each autotile variant so it is its own guide layer. The brief's test — can
  they slot Kenney's Tiny Town in within an hour — is now runnable: Load PNG,
  and the editor checks dimensions against the expected layout and reports texel
  density mismatches. Nobody has run it.
- **How does the artist think about reuse?** Prefabs and styles are not built.
- **How much gameplay data should levels carry?** Engine-defined custom types
  are not built. The export carries collision and walkability flags and nothing
  more, which is the conservative end of the brief's range.

---

## Things found along the way

### The `auto` display mode is doing more work than the brief expected

Section 8 lists `auto` as one option among six. In practice it is the setting
that decides whether camera rotation is affordable, because it silently
converts the long tail of scenery into billboards. Worth promoting to the
default in the UI (it already is) and worth explaining to the artist: on the
sample map every object that reads wrong is one deliberately set to a flat
plane, and every object left on `auto` is fine at any bounds.

### Fog distances are a property of the map, not of the preset

Atmosphere presets author fog in absolute world units. Opening a larger map with
the same preset buries its far half. Presets now declare fog against a
32-tile reference span and scale to the map. Anything else authored in world
units — camera distance bounds especially — will have the same problem.

### The coverage readout was silently stale

The panel memoised its analysis on the document object. The store mutates the
document in place behind a revision counter — deliberately, so a brush stroke
does not clone parallel arrays sixty times a second — so `doc` never changes
identity and the memo never recomputed. The readout froze at whatever the map
looked like when the panel mounted, and changing the camera bounds appeared to
do nothing.

It was caught by the walkthrough capture asserting that narrowing the bounds
changed the numbers. Worth a general note: mutation-plus-revision is the right
trade for a brush loop, but every `useMemo` and `useEffect` downstream of it has
to depend on the revision, never on the document.

### Two rendering bugs the tests could not have caught

- **Degenerate UVs on terrain tops.** Top quads and side faces walk their
  corners along different axes, so a single rectangle-to-corner UV mapping
  collapsed every top quad onto two points and streaked the whole terrain. The
  unit tests all passed — they checked buffer lengths and finiteness, not
  whether the UVs described a rectangle. There is now a test asserting four
  distinct UV corners per quad, plus one pinning the sheet's orientation.
- **Double colour-space conversion in the sky.** The sky shader converted
  linear to sRGB itself while the composer's `OutputPass` did it again, washing
  the sky to near-white.

Both were found by looking at screenshots. The capture script is a CI
workflow now (`.github/workflows/visual.yml`, #56; run by hand with
`gh workflow run visual.yml --ref <branch>` since 2026-09-12, when it left
the per-PR path for taking four minutes to the gate's one): it builds,
drives the app, and fails on a console error, a below-floor whole-canvas
luminance reading, or too few triangles reported in the status bar — see
`scripts/tour.mjs` for the thresholds and the reasoning behind each.

### Bloom renders black under software GL

`UnrealBloomPass` turns the entire frame black on a software rasterizer, while
the same scene rendered directly is correct. Measured by toggling passes live in
one session:

| | mean luminance |
|---|---|
| Composer, bloom on | 23 |
| Composer, bloom off | 208 |
| Direct render, no composer | 204 |

Constructing the pass at the true resolution did not help, and it is not the
tilt-shift pass, the editor overlay, the backdrop cards, fog or camera distance
— each was ruled out separately.

**This is unconfirmed on real hardware**, and it may well be a SwiftShader
limitation rather than a bug in this code. The editor detects a software
renderer and disables post-processing rather than showing a black viewport,
and says so in the status bar. Someone should check bloom on a real GPU before
concluding anything; if it works there, the detection can narrow or go.
