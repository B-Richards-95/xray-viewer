// test.mjs — plain node, no dependencies:  node ipad/test.mjs
// Parses the real AP elbow film and cross-checks the ported maths against values worked out by
// hand from src/xray_viewer/measure.py, and — for the relief steps — against numbers printed by
// src/xray_viewer/view3d_relief.py itself.
import { readFileSync } from "node:fs";
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// viewer-core.js publishes globalThis.XV; importing it just runs it.
await import("./viewer-core.js");
const XV = globalThis.XV;

let failures = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log(`PASS  ${name}${detail ? "  — " + detail : ""}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${name}${detail ? "  — " + detail : ""}`);
  }
}
function near(a, b, tol = 1e-9) {
  return Math.abs(a - b) <= tol;
}

check("viewer-core loaded", !!XV && typeof XV.parseDicom === "function");

// ---------------------------------------------------------------- real file
const dcm = join(here, "..", "..", "X-rays", "1_Elbow_AP.dcm");
const bytes = readFileSync(dcm);
const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const r = XV.parseDicom(buffer, "1_Elbow_AP.dcm");

check("rows > 1000", r.rows > 1000, `rows=${r.rows}`);
check("cols > 1000", r.cols > 1000, `cols=${r.cols}`);
check("pixel count matches rows*cols", r.pixels.length === r.rows * r.cols, `${r.pixels.length}`);
check(
  "spacing 0.125 isotropic",
  near(r.spacingMm[0], 0.125) && near(r.spacingMm[1], 0.125),
  `[${r.spacingMm.join(", ")}] from ${r.spacingSource}`
);
check("spacing marked valid", r.spacingIsValid === true, `source=${r.spacingSource}`);
check("label is AP", r.label === "AP", `label="${r.label}" series="${r.seriesDescription}" view="${r.viewPosition}"`);
check("photometric MONOCHROME2", r.photometric === "MONOCHROME2", r.photometric);
check(
  "percentile window finite",
  Number.isFinite(r.windowCenter) && Number.isFinite(r.windowWidth) && r.windowWidth > 0,
  `C=${r.windowCenter} W=${r.windowWidth}`
);
check(
  "window range brackets the centre",
  r.windowRange[0] < r.windowCenter && r.windowCenter < r.windowRange[1],
  `[${r.windowRange[0]}, ${r.windowRange[1]}]`
);

// generic labelling leaves a known view alone
const labelled = XV.applyGenericLabels([{ label: r.label }, { label: "" }]);
check("apply_generic_labels keeps AP, numbers the unknown", labelled[0].label === "AP" && labelled[1].label === "Image 2");

// ------------------------------------------------------- measure.py by hand
// distance_mm: dx = (400-100)*0.125 = 37.5, dy = (600-200)*0.125 = 50.0, hypot = 62.5
const d = XV.distanceMm([100, 200], [400, 600], [0.125, 0.125]);
check("distance_mm = 62.5", near(d, 62.5), `${d}`);
check("distance_px = 500", near(XV.distancePx([100, 200], [400, 600]), 500), "hypot(300,400)");
check(
  "format_distance suffix",
  XV.formatDistance([100, 200], [400, 600], [0.125, 0.125], true) === `62.5 ${XV.DISTANCE_SUFFIX}`,
  XV.formatDistance([100, 200], [400, 600], [0.125, 0.125], true)
);
check(
  "format_distance uncalibrated suffix",
  XV.formatDistance([100, 200], [400, 600], [1, 1], false) === `500.0 ${XV.PIXEL_SUFFIX}`
);

// angle_deg: arms (0,-25) and (37.5,0) are perpendicular -> 90.0
const a90 = XV.angleDeg([100, 100], [100, 300], [400, 300], [0.125, 0.125]);
check("angle_deg = 90.0", near(a90, 90.0, 1e-9), `${a90}`);
// arms (-12.5,-12.5) and (25,0): cos = -1/sqrt(2) -> 135.0
const a135 = XV.angleDeg([100, 100], [200, 200], [400, 200], [0.125, 0.125]);
check("angle_deg = 135.0", near(a135, 135.0, 1e-9), `${a135}`);
check("format_angle = 135.0°", XV.formatAngle([100, 100], [200, 200], [400, 200], [0.125, 0.125]) === "135.0°");
check("angle_deg degenerate arm = 0", XV.angleDeg([5, 5], [5, 5], [9, 9], [1, 1]) === 0.0);

// --------------------------------------------------------------- marks 2.6
// Every value below is worked out by hand at spacing 0.125 mm/px isotropic, so a
// distance of n px is n/8 mm.
const sp = [0.125, 0.125];
const mark = (type, pts, meta) => ({ id: "t", type, pts, meta: meta || {} });

// 3.2: every line label carries its tilt too — 300 px across, 400 px down is 53.1° off horizontal
check(
  "describeMark line = 62.5 mm + tilt",
  XV.describeMark(mark("line", [[100, 200], [400, 600]]), sp, true) === `62.5 ${XV.DISTANCE_SUFFIX} · 53.1° from H`,
  XV.describeMark(mark("line", [[100, 200], [400, 600]]), sp, true)
);
check(
  "describeMark line uncalibrated = 500.0 px",
  XV.describeMark(mark("line", [[100, 200], [400, 600]]), sp, false) === `500.0 ${XV.PIXEL_SUFFIX} · 53.1° from H`
);
check(
  "describeMark angle (end→vertex→end) = 90.0°",
  XV.describeMark(mark("angle", [[100, 100], [100, 300], [400, 300]]), sp, true) === "90.0°"
);
// cobb: line 1 is horizontal (0°), line 2 rises 100 px over 100 px (45°) -> 45.0
check(
  "describeMark cobb = 45.0°",
  XV.describeMark(mark("cobb", [[0, 0], [100, 0], [0, 0], [100, 100]]), sp, true) === "45.0° Cobb",
  XV.describeMark(mark("cobb", [[0, 0], [100, 0], [0, 0], [100, 100]]), sp, true)
);
check("cobbAngle perpendicular = 90", near(XV.cobbAngle([[0, 0], [100, 0], [0, 0], [0, 100]], sp), 90));
check("cobbAngle parallel = 0", near(XV.cobbAngle([[0, 0], [100, 0], [50, 50], [150, 50]], sp), 0));
check("cobbAngle ignores which end is first", near(XV.cobbAngle([[100, 0], [0, 0], [0, 0], [100, 100]], sp), 45));
// circle: centre->edge is 80 px = 10 mm radius, 20 mm across
const circ = XV.circleMetrics([[0, 0], [80, 0]], sp, true);
check("circle radius 10 / diameter 20 mm", near(circ.radius, 10) && near(circ.diameter, 20), `${circ.radius}/${circ.diameter}`);
check(
  "describeMark circle",
  XV.describeMark(mark("circle", [[0, 0], [80, 0]]), sp, true) === `⌀ 20.0 · r 10.0 ${XV.DISTANCE_SUFFIX}`,
  XV.describeMark(mark("circle", [[0, 0], [80, 0]]), sp, true)
);
check("circle uncalibrated is px", near(XV.circleMetrics([[0, 0], [80, 0]], sp, false).radius, 80));
// ellipse: corners 80 px across, 40 px down -> 10 mm x 5 mm axes
const ell = XV.ellipseMetrics([[10, 10], [90, 50]], sp, true);
check("ellipse axes 10 x 5 mm", near(ell.major, 10) && near(ell.minor, 5), `${ell.major}/${ell.minor}`);
check("ellipse major is the longer axis whichever way it was dragged", near(XV.ellipseMetrics([[90, 50], [10, 10]], sp, true).major, 10));
check(
  "describeMark ellipse",
  XV.describeMark(mark("ellipse", [[10, 10], [90, 50]]), sp, true) === `axes 10.0 × 5.0 ${XV.DISTANCE_SUFFIX}`,
  XV.describeMark(mark("ellipse", [[10, 10], [90, 50]]), sp, true)
);
check("describeMark point is its number", XV.describeMark(mark("point", [[5, 5]], { n: 3 }), sp, true) === "3");
check("describeMark text is its text", XV.describeMark(mark("text", [[5, 5]], { text: "ulna" }), sp, true) === "ulna");
check("describeMark of an unfinished mark is blank", XV.describeMark(mark("angle", [[0, 0], [1, 1]]), sp, true) === "");

// ------------------------------------------------- calibration maths 3.1
// a 200 px line drawn over something 25 mm long is 0.125 mm/px, isotropic
const cal = XV.spacingFromKnownLength([0, 0], [200, 0], 25, "mm");
check("spacingFromKnownLength 25 mm over 200 px = 0.125", near(cal[0], 0.125) && near(cal[1], 0.125), `${cal}`);
check(
  "spacingFromKnownLength counts a diagonal line by its true length",
  near(XV.spacingFromKnownLength([0, 0], [300, 400], 50, "mm")[0], 0.1),
  `${XV.spacingFromKnownLength([0, 0], [300, 400], 50, "mm")[0]}`
);
check("spacingFromKnownLength cm = 10 mm", near(XV.spacingFromKnownLength([0, 0], [100, 0], 1, "cm")[0], 0.1));
check("spacingFromKnownLength in = 25.4 mm", near(XV.spacingFromKnownLength([0, 0], [254, 0], 1, "in")[0], 0.1));
check("spacingFromKnownLength refuses a zero-length line", XV.spacingFromKnownLength([5, 5], [5, 5], 10, "mm") === null);
check("spacingFromKnownLength refuses a zero length", XV.spacingFromKnownLength([0, 0], [10, 0], 0, "mm") === null);
// a line calibrated at 0.125 mm/px measures 500 px as 62.5 mm
check(
  "a calibrated spacing relabels an old mark",
  XV.describeMark(mark("line", [[100, 200], [400, 600]]), cal, true).startsWith("62.5 "),
  XV.describeMark(mark("line", [[100, 200], [400, 600]]), cal, true)
);

// ------------------------------------------------------ tilt + Δ vs ref 3.2
check("tiltFromAxis horizontal line = 0 from H", near(XV.tiltFromAxis([0, 0], [10, 0], sp, "h"), 0));
check("tiltFromAxis horizontal line = 90 from V", near(XV.tiltFromAxis([0, 0], [10, 0], sp, "v"), 90));
check("tiltFromAxis vertical line = 90 from H", near(XV.tiltFromAxis([0, 0], [0, 10], sp, "h"), 90));
check("tiltFromAxis vertical line = 0 from V", near(XV.tiltFromAxis([0, 0], [0, 10], sp, "v"), 0));
check("tiltFromAxis 45° stays 45 either way", near(XV.tiltFromAxis([0, 0], [10, 10], sp, "h"), 45) && near(XV.tiltFromAxis([0, 0], [10, 10], sp, "v"), 45));
check("tiltFromAxis ignores which end is first", near(XV.tiltFromAxis([10, 10], [0, 0], sp, "h"), 45));
check("tiltFromAxis stays in 0..90 for an upward line", near(XV.tiltFromAxis([0, 100], [100, 0], sp, "h"), 45));
check(
  "describeMark line with tiltAxis v reads from V",
  XV.describeMark(mark("line", [[0, 0], [100, 0]], { tiltAxis: "v" }), sp, true).endsWith("90.0° from V"),
  XV.describeMark(mark("line", [[0, 0], [100, 0]], { tiltAxis: "v" }), sp, true)
);
check("lineDeltaDeg perpendicular = 90", near(XV.lineDeltaDeg([[0, 0], [0, 100]], [[0, 0], [100, 0]], sp), 90));
check("lineDeltaDeg parallel = 0", near(XV.lineDeltaDeg([[5, 5], [105, 5]], [[0, 0], [100, 0]], sp), 0));
check("lineDeltaDeg is the acute angle whichever way each line was drawn", near(XV.lineDeltaDeg([[100, 100], [0, 0]], [[0, 0], [100, 0]], sp), 45));
const refLine = { id: "ref", type: "line", pts: [[0, 0], [100, 0]], meta: { reference: true } };
const other = { id: "other", type: "line", pts: [[0, 0], [100, 100]], meta: {} };
check(
  "a reference line adds Δ vs ref to every other line",
  XV.describeMark(other, sp, true, { reference: refLine }).endsWith("Δ vs ref 45.0°"),
  XV.describeMark(other, sp, true, { reference: refLine })
);
check(
  "the reference line does not label a Δ against itself",
  XV.describeMark(refLine, sp, true, { reference: refLine }).indexOf("Δ") === -1,
  XV.describeMark(refLine, sp, true, { reference: refLine })
);
check(
  "an angle mark gains no Δ vs ref",
  XV.describeMark(mark("angle", [[100, 100], [100, 300], [400, 300]]), sp, true, { reference: refLine }) === "90.0°"
);

// ------------------------------------------------------------- markup 4.1
check("isMarkup knows ink from a line", XV.isMarkup({ type: "ink" }) && !XV.isMarkup({ type: "line" }));
check("markup marks carry no measurement label", XV.describeMark(mark("ink", [[0, 0], [5, 5]], { color: "#f00" }), sp, true) === "");
check("a markup note shows its text", XV.describeMark(mark("note", [[0, 0]], { text: "chip" }), sp, true) === "chip");
// hit-testing must walk past markup: a stroke's points are not draggable handles
check("hitTest ignores markup strokes", XV.hitTest([mark("ink", [[0, 0], [10, 0]])], [0, 0], (p) => p, 36) === null);
// RDP: a straight run collapses to its ends, a real corner survives
const straight = XV.simplifyPolyline([[0, 0], [1, 0.2], [2, 0], [3, 0.3], [4, 0]], 1.5);
check("simplifyPolyline drops points inside the tolerance", straight.length === 2, JSON.stringify(straight));
const corner = XV.simplifyPolyline([[0, 0], [5, 0], [10, 0], [10, 5], [10, 10]], 1.5);
check("simplifyPolyline keeps a corner", corner.length === 3 && corner[1][0] === 10 && corner[1][1] === 0, JSON.stringify(corner));
check("simplifyPolyline keeps the ends", straight[0][0] === 0 && straight[1][0] === 4);
check("simplifyPolyline leaves a 2-point stroke alone", XV.simplifyPolyline([[0, 0], [9, 9]], 1.5).length === 2);
check("simplifyPolyline copies its points", XV.simplifyPolyline([[0, 0], [9, 9]], 1.5)[0] !== undefined && XV.simplifyPolyline([[0, 0], [9, 9]], 1.5)[0][0] === 0);
const spike = XV.simplifyPolyline([[0, 0], [50, 10], [100, 0]], 1.5);
check("simplifyPolyline keeps a bulge bigger than the tolerance", spike.length === 3);
// polyline distance: the eraser's hit test
check("polylineDistance on the line is 0", near(XV.polylineDistance([[0, 0], [100, 0]], [50, 0]), 0));
check("polylineDistance measures perpendicular", near(XV.polylineDistance([[0, 0], [100, 0]], [50, 7]), 7));
check("polylineDistance clamps past the end", near(XV.polylineDistance([[0, 0], [100, 0]], [103, 4]), 5));
check("polylineDistance takes the nearest segment", near(XV.polylineDistance([[0, 0], [100, 0], [100, 100]], [97, 50]), 3));
check("polylineDistance of a single point is the gap to it", near(XV.polylineDistance([[3, 4]], [0, 0]), 5));
check("polylineDistance of nothing is Infinity", XV.polylineDistance([], [0, 0]) === Infinity);

// ------------------------------------------------------------- hit-testing
// identity transform, so screen px == image px and the sums are readable
const idt = (p) => [p[0], p[1]];
const hitMarks = [
  mark("line", [[0, 0], [100, 0]]),
  mark("line", [[300, 300], [400, 300]]),
];
const h1 = XV.hitTest(hitMarks, [104, 3], idt, 36);
check("hitTest grabs the nearest handle", h1 && h1.markIndex === 0 && h1.ptIndex === 1, JSON.stringify(h1));
const h2 = XV.hitTest(hitMarks, [8, -6], idt, 36);
check("hitTest picks the nearer of two handles", h2 && h2.markIndex === 0 && h2.ptIndex === 0, JSON.stringify(h2));
check("hitTest misses outside the radius", XV.hitTest(hitMarks, [200, 200], idt, 36) === null);
check("hitTest at mouse radius 8 misses a 20 px gap", XV.hitTest(hitMarks, [120, 0], idt, 8) === null);
// the label sits at the last handle + LABEL_OFFSET, so a tap on it beats the handle
const labelPt = [400 + XV.LABEL_OFFSET[0], 300 + XV.LABEL_OFFSET[1]];
const h3 = XV.hitTest(hitMarks, labelPt, idt, 36);
check("hitTest finds the label", h3 && h3.markIndex === 1 && h3.ptIndex === "label", JSON.stringify(h3));
check("hitTest on empty list is null", XV.hitTest([], [0, 0], idt, 36) === null);

// -------------------------------------------------- exact-value setters
const angleMark = mark("angle", [[100, 100], [100, 300], [400, 300]]);   // 90.0°
const turned = XV.setMarkAngle(angleMark, 45, sp);
check("setMarkAngle rotates the last arm to 45", near(XV.angleDeg(turned[0], turned[1], turned[2], sp), 45, 1e-9), `${XV.angleDeg(turned[0], turned[1], turned[2], sp)}`);
check(
  "setMarkAngle keeps the arm length",
  near(XV.distanceMm(turned[1], turned[2], sp), XV.distanceMm(angleMark.pts[1], angleMark.pts[2], sp), 1e-9)
);
check("setMarkAngle leaves the first arm alone", turned[0][0] === 100 && turned[1][1] === 300);
const cobbMark = mark("cobb", [[0, 0], [100, 0], [0, 0], [100, 100]]);   // 45.0°
check("setMarkAngle on a cobb sets the inter-line angle", near(XV.cobbAngle(XV.setMarkAngle(cobbMark, 30, sp), sp), 30, 1e-9));
check("snapAngle 47 -> 45 at 5°", XV.snapAngle(47, 5) === 45);
check("snapAngle 47.4 -> 47 at 1°", XV.snapAngle(47.4, 1) === 47);
const scaled = XV.setMarkLength(mark("line", [[100, 200], [400, 600]]), 125, sp, true);   // was 62.5 mm
check("setMarkLength doubles the line to 125 mm", near(XV.distanceMm(scaled[0], scaled[1], sp), 125, 1e-9));
check("setMarkLength slides along the same ray", near(scaled[1][0], 700, 1e-9) && near(scaled[1][1], 1000, 1e-9), `${scaled[1]}`);
const shrunk = XV.setMarkLength(mark("circle", [[0, 0], [80, 0]]), 10, sp, true);   // diameter 10 mm -> r 5 mm
check("setMarkLength on a circle takes the diameter", near(XV.circleMetrics(shrunk, sp, true).diameter, 10, 1e-9));
check("setMarkLength in px when uncalibrated", near(XV.distancePx(...XV.setMarkLength(mark("line", [[0, 0], [100, 0]]), 250, sp, false)), 250, 1e-9));
check("setMarkLength refuses a zero-length ray", XV.setMarkLength(mark("line", [[7, 7], [7, 7]]), 10, sp, true)[1][0] === 7);

// ------------------------------------------------------------- view2d maths
const bounds = XV.windowBounds(r.pixels);
check(
  "window_bounds spans the image",
  bounds.levelMin <= r.windowRange[0] && bounds.levelMax >= r.windowRange[1] && bounds.widthMin === 1,
  `L ${bounds.levelMin}..${bounds.levelMax}, W ${bounds.widthMin}..${bounds.widthMax}`
);
const lv = XV.levelsFromWindow(1000, 400);
check("levels_from_window", lv[0] === 800 && lv[1] === 1200);
const wl = XV.windowFromLevels([800, 1200]);
check("window_from_levels round-trips", wl.center === 1000 && wl.width === 400);
const lut0 = XV.blendLut(0);
const lut1 = XV.blendLut(1);
const lutH = XV.blendLut(0.5);
check("blend_lut(0) is identity", lut0[0] === 0 && lut0[255] === 255);
check("blend_lut(1) is inverted", lut1[0] === 255 && lut1[255] === 0);
check("blend_lut(0.5) is flat mid grey", lutH[0] === 128 && lutH[255] === 128);

// -------------------------------------------------------- gesture rules
// pointerType, mode, pointerCount, locked -> expected gesture
const gestureTable = [
  ["pen", "none", 1, false, "none"],       // a pen must never pan, or pencil taps drift
  ["touch", "none", 1, false, "pan"],
  ["mouse", "none", 1, false, "pan"],
  ["pen", "distance", 1, false, "place"],
  ["touch", "distance", 1, false, "place"], // measuring never pans on one pointer
  ["touch", "angle", 1, false, "place"],
  ["touch", "none", 2, false, "pinch"],
  ["touch", "distance", 2, false, "pinch"],
  ["touch", "none", 3, false, "pinch"],
  ["touch", "none", 1, true, "none"],       // locked: the image does not move
  ["touch", "none", 2, true, "none"],
  ["pen", "distance", 1, true, "place"],    // locked still places points
  ["touch", "none", 0, false, "none"],
];
let gestureOk = true;
let gestureBad = "";
for (const [type, m, n, locked, want] of gestureTable) {
  const got = XV.gestureFor(type, m, n, locked);
  if (got !== want) {
    gestureOk = false;
    gestureBad += ` ${type}/${m}/${n}/${locked}: ${got}!=${want}`;
  }
}
check("gesture_for table", gestureOk, gestureBad || `${gestureTable.length} rows`);

// ------------------------------------------------------- 2-D transform
for (const rot of [0, Math.PI / 2, Math.PI, -Math.PI / 2, 0.37]) {
  const xf = { scale: 2.5, tx: 130, ty: -40, rot };
  let rtOk = true;
  for (const p of [[0, 0], [1000, 250], [-13.5, 7.25]]) {
    const back = XV.screenToImage(XV.imageToScreen(p, xf), xf);
    if (!near(back[0], p[0], 1e-9) || !near(back[1], p[1], 1e-9)) rtOk = false;
  }
  check(`image<->screen round-trip at rot=${rot.toFixed(2)}`, rtOk);
}
// a quarter turn sends +x to +y on screen (canvas y is down, so this is clockwise)
const q = XV.imageToScreen([10, 0], { scale: 1, tx: 0, ty: 0, rot: Math.PI / 2 });
check("rot 90 sends +x to +y", near(q[0], 0, 1e-9) && near(q[1], 10, 1e-9), `[${q}]`);
const ext = XV.rotatedExtent(400, 300, Math.PI / 2);
check("rotated_extent swaps at 90", near(ext.width, 300, 1e-9) && near(ext.height, 400, 1e-9));
const t = XV.translationFixing([50, 60], [800, 900], 3, 0.4);
const pinned = XV.imageToScreen([50, 60], { scale: 3, tx: t[0], ty: t[1], rot: 0.4 });
check("translation_fixing pins the point", near(pinned[0], 800, 1e-9) && near(pinned[1], 900, 1e-9));

// ------------------------------------------------------------ relief maths
const plane = { data: Float32Array.from(r.pixels), rows: r.rows, cols: r.cols };
const cropped = XV.cropToContent(plane);
check(
  "crop_to_content shrinks and stays sane",
  cropped.rows > 8 && cropped.cols > 8 && cropped.rows <= r.rows && cropped.cols <= r.cols,
  `${cropped.rows}x${cropped.cols} from ${r.rows}x${r.cols}`
);
const small = XV.downsample(cropped, 512);
check("downsample to <= 512", Math.max(small.rows, small.cols) <= 512, `${small.rows}x${small.cols}`);
const norm = XV.normalize(small, r.windowRange);
let normOk = true;
for (let i = 0; i < norm.data.length; i++) if (!(norm.data[i] >= 0 && norm.data[i] <= 1)) normOk = false;
check("normalize stays in 0..1", normOk);
const clipped = XV.clipPercentiles(norm);
let clipMin = Infinity;
let clipMax = -Infinity;
for (let i = 0; i < clipped.data.length; i++) {
  if (clipped.data[i] < clipMin) clipMin = clipped.data[i];
  if (clipped.data[i] > clipMax) clipMax = clipped.data[i];
}
check("clip_percentiles stretches to 0..1", near(clipMin, 0, 1e-6) && near(clipMax, 1, 1e-6), `${clipMin}..${clipMax}`);
const blurred = XV.gaussianBlur(clipped, 2);
check("gaussian_blur keeps shape", blurred.rows === clipped.rows && blurred.cols === clipped.cols);
// a blur of a constant field must return that constant (kernel sums to 1)
const flat = XV.gaussianBlur({ data: Float32Array.from({ length: 64 }, () => 0.25), rows: 8, cols: 8 }, 2);
let flatOk = true;
for (let i = 0; i < flat.data.length; i++) if (Math.abs(flat.data[i] - 0.25) > 1e-6) flatOk = false;
check("gaussian_blur preserves a constant field", flatOk);
// ------------------------------------------- relief steps vs the desktop's own numbers
/* A 32x32 synthetic limb: a bright shaft with a darker canal down the middle of it, which is
 * exactly the shape that makes a real humerus render as a trough between two cortical rims.
 * The expected values below came out of the desktop code itself, on this same array:
 *   uv run --project xray-viewer python -c "...view3d_relief..."   (numpy 2.5.2, 2026-09-03)
 * They are sampled every 97th pixel, so a wrong pass shows up wherever it went wrong. */
const SYNTH = 32;
const synth = { data: new Float32Array(SYNTH * SYNTH), rows: SYNTH, cols: SYNTH };
for (let r = 0; r < SYNTH; r++) {
  for (let c = 0; c < SYNTH; c++) {
    let v = 0.05 + 0.02 * Math.sin(r * 0.7) * Math.cos(c * 0.9);
    if (c >= 8 && c < 24 && r >= 3 && r < 29) v = 0.85;
    if (c >= 13 && c < 19 && r >= 5 && r < 27) v = 0.45;
    synth.data[r * SYNTH + c] = v;
  }
}
const desktop = {
  otsu: 0.0703125,
  greyClose: [0.0697089955, 0.0697089955, 0.0697633624, 0.850000024, 0.850000024, 0.850000024, 0.850000024, 0.850000024, 0.850000024, 0.850000024, 0.850000024],
  closingLift: [0.169002652, 0.142769903, 0.111689858, 0.0899246782, 0.0769093186, 0.0720195249, 0.0757028684, 0.0846706256, 0.0933169648, 0.114159197, 0.152080849],
  domeField: [0.000115158517, 0.0104340147, 0.0685930848, 0.196020603, 0.373193979, 0.54123044, 0.669752896, 0.753202498, 0.730576515, 0.503949165, 0.393556744],
  unsharp: [0.0245802067, 0.00343257189, 0, 0.975691855, 0.956773698, 0.943401873, 0.934759438, 0.933578432, 0.428605407, 0.987702131, 0.00213430449],
  roundHeight: [0.0435953736, 0.0481579378, 0.0799750909, 0.407799304, 0.533509374, 0.655276954, 0.750198841, 0.814172208, 0.677929282, 0.64629221, 0.33703661],
  filledTexture: [0.24638097, 0.244811445, 0.196061045, 0.986419141, 0.963028014, 0.947307646, 0.942414939, 0.951072276, 0.580493689, 1, 0.249623239],
  probes: [37, 134, 231, 328, 425, 522, 619, 716, 813, 910, 1007],
};
function matchesDesktop(name, got) {
  let worst = 0;
  let at = -1;
  desktop.probes.forEach((index, n) => {
    const diff = Math.abs(got.data[index] - desktop[name][n]);
    if (diff > worst) { worst = diff; at = index; }
  });
  check(`${name} matches view3d_relief.py`, worst <= 1e-4, `max diff ${worst.toExponential(2)} at pixel ${at}`);
}
check("otsu_threshold matches view3d_relief.py", near(XV.otsuThreshold(synth.data), desktop.otsu, 1e-9));
matchesDesktop("greyClose", XV.greyClose(synth, 5));
matchesDesktop("closingLift", XV.closingLift(synth));
matchesDesktop("domeField", XV.domeField(synth));
const synthUnsharp = XV.unsharpMask(synth, 2.0, 0.3);
matchesDesktop("unsharp", synthUnsharp);
matchesDesktop("roundHeight", XV.roundHeight(synthUnsharp, synth, 0.75));
matchesDesktop("filledTexture", XV.filledTexture(synth, synth));

// the point of the whole thing: the canal is a valley, and closing_lift lifts it and not the rims
const lift = XV.closingLift(synth);
const canalMid = lift.data[16 * SYNTH + 16];
const rimMid = lift.data[16 * SYNTH + 10];
let liftHigh = 0;
for (let i = 0; i < lift.data.length; i++) if (lift.data[i] > liftHigh) liftHigh = lift.data[i];
// The 14 px closing radius is wider than this 32 px toy, so its bone support covers the whole
// frame and the background lifts too; what the toy can still show is the canal outrunning the rim.
check(
  "closing_lift raises the canal above the cortical rim, and never past CLOSE_MAX_LIFT",
  canalMid > 0.05 && canalMid > rimMid && liftHigh <= 0.18 + 1e-6,
  `canal ${canalMid.toFixed(4)}, rim ${rimMid.toFixed(4)}, peak ${liftHigh.toFixed(4)}`
);

// ------------------------------------------------- the whole pipeline on the real film
const started = Date.now();
const fields = XV.reliefFields(plane, r.windowRange, 1024, XV.SMOOTH_DEFAULT, XV.DETAIL_DEFAULT / 100, XV.ROUNDING_DEFAULT / 100);
const elapsed = Date.now() - started;
let heightOk = true;
let heightHigh = 0;
for (let i = 0; i < fields.height.data.length; i++) {
  const v = fields.height.data[i];
  if (!(Number.isFinite(v) && v >= 0 && v <= 1)) heightOk = false;
  if (v > heightHigh) heightHigh = v;
}
check(
  "relief_fields at 1024² is finite in 0..1",
  heightOk && heightHigh > 0.5,
  `${fields.height.rows}x${fields.height.cols}, peak ${heightHigh.toFixed(3)}, ${elapsed} ms`
);
let textureOk = true;
for (let i = 0; i < fields.detail.data.length; i++) {
  const v = fields.detail.data[i];
  if (!(Number.isFinite(v) && v >= 0 && v <= 1)) textureOk = false;
}
check("filled_texture stays in 0..1 on the real film", textureOk);
const picks = XV.autoPresets(plane, r.windowRange);
check(
  "auto_presets picks from the preset tables",
  XV.SMOOTH_PRESETS.some(([, v]) => v === picks.smooth) &&
    XV.DETAIL_PRESETS.some(([, v]) => v === picks.detail) &&
    XV.ROUNDING_PRESETS.some(([, v]) => v === picks.rounding),
  `smooth=${picks.smooth} detail=${picks.detail} rounding=${picks.rounding}`
);

const home = XV.orbitPoint([0, 0, 0], 10, 0, 0);
check("orbit_point at elev 0 / azim 0 looks along -Y", near(home[0], 0, 1e-12) && near(home[1], -10, 1e-12));
const inv = XV.invertLut(1.0);
check("invert_lut(1) flips the ramp", inv[0] === 255 && inv[255] === 0);

// -------------------------------------------------- compressed file rejected
let threw = "";
let fake;                 // the tolerant parse below reads it again
try {
  fake = new Uint8Array(400);
  fake.set([68, 73, 67, 77], 128); // "DICM"
  // (0002,0000) UL 4  groupLength
  const dv = new DataView(fake.buffer);
  let o = 132;
  dv.setUint16(o, 0x0002, true); dv.setUint16(o + 2, 0x0000, true);
  fake[o + 4] = 85; fake[o + 5] = 76; dv.setUint16(o + 6, 4, true); dv.setUint32(o + 8, 26, true);
  o += 12;
  // (0002,0010) UI 22  "1.2.840.10008.1.2.4.90"
  dv.setUint16(o, 0x0002, true); dv.setUint16(o + 2, 0x0010, true);
  fake[o + 4] = 85; fake[o + 5] = 73; dv.setUint16(o + 6, 22, true);
  const uid = "1.2.840.10008.1.2.4.90";
  for (let i = 0; i < uid.length; i++) fake[o + 8 + i] = uid.charCodeAt(i);
  XV.parseDicom(fake.buffer, "compressed.dcm");
} catch (e) {
  threw = e.message;
}
check("compressed transfer syntax gives a clear error", threw.includes("JPEG 2000 Lossless"), threw);

// ------------------------------------------------------------------- zips
// A CT study arrives as one zip from the iPad's Files app; XV.zipEntries reads the central
// directory and the browser (node here) does the inflating. The zip is built right here so the
// test owns every byte of it.
function zipBlob(files) {
  const locals = [], directory = [];
  let offset = 0;
  for (const file of files) {
    const body = file.deflate ? deflateRawSync(Buffer.from(file.bytes)) : Buffer.from(file.bytes);
    const name = Buffer.from(file.name, "utf8");
    const extra = Buffer.alloc(file.localExtra || 0);
    const crc = crc32(Buffer.from(file.bytes));
    const local = Buffer.alloc(30 + name.length + extra.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(file.deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(file.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(extra.length, 28);
    name.copy(local, 30);
    extra.copy(local, 30 + name.length);

    const entry = Buffer.alloc(46 + name.length);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(file.deflate ? 8 : 0, 10);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(file.bytes.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    name.copy(entry, 46);

    locals.push(local, body);
    directory.push(entry);
    offset += local.length + body.length;
  }
  const centre = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centre.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centre, end]);
}

function dicomish(fill) {
  const bytes = new Uint8Array(200);
  bytes.fill(fill);
  bytes.set([68, 73, 67, 77], 128);   // "DICM" at byte 128
  return bytes;
}

const zip = zipBlob([
  { name: "study/I0001", bytes: dicomish(7), deflate: true, localExtra: 9 },  // extra field: local header only
  { name: "study/notes.txt", bytes: new TextEncoder().encode("not a scan"), deflate: false },
  { name: "__MACOSX/._I0001", bytes: new Uint8Array([1, 2, 3]), deflate: false },
  { name: "study/", bytes: new Uint8Array(0), deflate: false },
]);
const zipBuffer = zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength);
const zipped = XV.zipEntries(zipBuffer);
check("zip directory lists every entry", zipped.length === 4, zipped.map((e) => e.name).join(", "));
check(
  "zip entry keeps its method and sizes",
  zipped[0].method === XV.ZIP_DEFLATED && zipped[0].uncompressedSize === 200 &&
    zipped[1].method === XV.ZIP_STORED,
  `${zipped[0].method}/${zipped[0].uncompressedSize}, ${zipped[1].method}`
);
const inflated = new Uint8Array(inflateRawSync(
  Buffer.from(zipBuffer, zipped[0].dataOffset, zipped[0].compressedSize)
));
check(
  "data offset clears the local header's own extra field",
  inflated.length === 200 && XV.looksLikeDicom(inflated),
  `${inflated.length} bytes, DICM=${XV.looksLikeDicom(inflated)}`
);
const stored = new Uint8Array(zipBuffer, zipped[1].dataOffset, zipped[1].compressedSize);
check("stored entry reads straight through", new TextDecoder().decode(stored) === "not a scan");
check("a text file is not mistaken for DICOM", XV.looksLikeDicom(stored) === false);
check(
  "resource forks, dotfiles and directory records are junk",
  !XV.zipEntryIsJunk("study/I0001") && XV.zipEntryIsJunk("__MACOSX/._I0001") &&
    XV.zipEntryIsJunk("study/")
);
let zipRefused = "";
try { XV.zipEntries(new Uint8Array(500).buffer); } catch (e) { zipRefused = e.message; }
check("a file that is not a zip is refused by name", zipRefused.includes("end-of-directory"), zipRefused);

// -------------------------------------------------------- series grouping
function instance(name, uid, modality, extra) {
  return Object.assign({
    name, seriesInstanceUid: uid, modality,
    seriesDescription: "", bodyPartExamined: "", instanceNumber: null, imagePositionPatient: null,
    pixels: new Uint16Array(4),
  }, extra || {});
}

const grouped = XV.groupSeries([
  instance("c", "1.2.3", "CT", { instanceNumber: 3, seriesDescription: "Abdomen 3.0" }),
  instance("a", "1.2.3", "CT", { instanceNumber: 1 }),
  instance("b", "1.2.3", "CT", { instanceNumber: 2 }),
  instance("scout", "1.2.9", "CT", { bodyPartExamined: "ABDOMEN" }),
  instance("elbow_ap.dcm", "9.9.9", "DX"),
  instance("no_uid.dcm", "", ""),
]);
check("a multi-slice group becomes a series", grouped.series.length === 2, grouped.series.map((s) => s.label).join(" | "));
check("a single DX film stays on the 2-D tab", grouped.films.length === 2, grouped.films.map((f) => f.name).join(", "));
check(
  "a one-slice CT scout is still a series",
  grouped.series[1].instances.length === 1 && grouped.series[1].modality === "CT",
  grouped.series[1].label
);
check(
  "slices sort by InstanceNumber",
  grouped.series[0].instances.map((i) => i.name).join("") === "abc",
  grouped.series[0].instances.map((i) => i.name).join("")
);
check(
  "the series label names the study and counts it",
  grouped.series[0].label === "Abdomen 3.0 \u2014 3 images" && grouped.series[1].label === "ABDOMEN \u2014 1 image",
  `${grouped.series[0].label} | ${grouped.series[1].label}`
);
const byPosition = XV.groupSeries([
  instance("top", "5.5", "MR", { imagePositionPatient: [0, 0, 9] }),
  instance("bottom", "5.5", "MR", { imagePositionPatient: [0, 0, -4] }),
]);
check(
  "no InstanceNumber falls back to the slice position",
  byPosition.series[0].instances.map((i) => i.name).join(",") === "bottom,top",
  byPosition.series[0].instances.map((i) => i.name).join(",")
);

// -------------------------------------------------- the file's own window
// WindowCenter is quoted in Hounsfield units while the pixels are stored values: 45 HU with a
// -1024 intercept is stored value 1069, and drawing 45 instead would be a black slice.
const ctWindow = XV.displayWindow(45, 315, 1, -1024, { offset: 0, scale: 1, ceiling: 0 });
check(
  "a CT window goes back through the rescale",
  near(ctWindow.center, 1069) && near(ctWindow.width, 315) && ctWindow.fromFile === true,
  `C=${ctWindow.center} W=${ctWindow.width}`
);
const shifted = XV.displayWindow(NaN, NaN, 1, -1024, { offset: -200, scale: 0.5, ceiling: 0 });
check(
  "no window tags falls back to soft tissue, on the shifted grey scale",
  near(shifted.center, (40 + 1024 + 200) * 0.5) && near(shifted.width, 200) && shifted.fromFile === false,
  `C=${shifted.center} W=${shifted.width}`
);

// ------------------------------- a slice whose pixels cannot be read, kept anyway
const tolerated = XV.parseDicom(fake.buffer, "compressed.dcm", { allowUndecodable: true });
check(
  "allowUndecodable keeps the file instead of throwing",
  tolerated.pixels === null && tolerated.undecodable.includes("JPEG 2000 Lossless"),
  tolerated.undecodable
);
const withStub = XV.groupSeries([tolerated]);
check("an unreadable file is still listed", withStub.films.length === 1 && withStub.series.length === 0);

// the real film carries the identity tags the CT tab groups on
check(
  "the real film reports its series UID and modality",
  typeof r.seriesInstanceUid === "string" && r.seriesInstanceUid.length > 0 && r.modality.length > 0,
  `${r.modality} ${r.seriesInstanceUid}`
);

// ------------------------------------------------- CT memory guard (Phase 2.2)
// Nobody publishes an iPad ceiling, so the guard is what decides; these cases pin its edges.
const fits = XV.ctBudget([512, 512, 68], 2, 2048, 8);
check(
  "a 68-slice 512² CT is uploaded as it is",
  fits.ok === true && fits.factor === 1 && fits.reason === "",
  JSON.stringify(fits)
);
const tall = XV.ctBudget([512, 512, 600], 2, 2048, 8);
check(
  "512×512×600 Int16 trips the guard and halves in-plane",
  tall.ok === true && tall.factor === 2 && tall.reason.includes("million voxels"),
  JSON.stringify(tall)
);
const wide = XV.ctBudget([1024, 1024, 200], 2, 256, 8);
check(
  "a volume wider than MAX_3D_TEXTURE_SIZE shrinks until it fits",
  wide.ok === true && wide.factor === 4 && wide.reason.includes("texture limit of 256"),
  JSON.stringify(wide)
);
const thin = XV.ctBudget([512, 512, 700], 2, 512, 8);
check(
  "too many slices is refused, not silently downsampled",
  thin.ok === false && thin.reason.includes("700 slices"),
  JSON.stringify(thin)
);
const poor = XV.ctBudget([512, 512, 400], 2, 4096, 0.5);
check(
  "a small-memory device gets a smaller volume (default 4 GB when unreported)",
  poor.factor > 1 && poor.reason.includes("0.5 GB"),
  JSON.stringify(poor)
);

// ------------------------------------------- NIfTI decimation (Phase 2.2)
function fakeNifti(nx, ny, nz, fill) {
  const bytes = new ArrayBuffer(352 + nx * ny * nz * 2);
  const h = new DataView(bytes);
  h.setInt32(0, 348, true);
  h.setInt16(40, 3, true);
  h.setInt16(42, nx, true);
  h.setInt16(44, ny, true);
  h.setInt16(46, nz, true);
  h.setInt16(70, 4, true);            // DT_INT16
  h.setInt16(72, 16, true);
  for (let i = 0; i < 4; i++) h.setFloat32(76 + i * 4, i === 0 ? 1 : 0.5, true);
  h.setFloat32(108, 352, true);
  h.setInt16(252, 1, true);           // qform present, so the decimator must drop it
  h.setInt16(254, 1, true);
  h.setFloat32(280, 0.5, true); h.setFloat32(292, -10, true);   // srow_x = [0.5,0,0,-10]
  h.setFloat32(300, 0.5, true); h.setFloat32(308, -20, true);   // srow_y = [0,0.5,0,-20]
  h.setFloat32(320, 3.0, true); h.setFloat32(324, 5, true);     // srow_z = [0,0,3,5]
  const img = new Int16Array(bytes, 352, nx * ny * nz);
  for (let i = 0; i < img.length; i++) img[i] = fill(i);
  return bytes;
}
const niiHead = XV.niftiHeader(fakeNifti(8, 6, 4, () => 7));
check(
  "a NIfTI header reads its dims and voxel size",
  niiHead.dims.join(",") === "8,6,4" && niiHead.bytesPerVoxel === 2 && niiHead.frames === 1,
  JSON.stringify(niiHead.dims)
);
// A ramp along x: averaging 2×2 must give the mean of each pair of columns.
const ramp = fakeNifti(8, 6, 2, (i) => i % 8);
const halved = XV.decimateNiftiInPlane(ramp, 2);
const halvedHead = XV.niftiHeader(halved);
const halvedImg = new Int16Array(halved, 352, 4 * 3 * 2);
check(
  "2× in-plane decimation halves the columns and rows, keeps the slices",
  halvedHead.dims.join(",") === "4,3,2",
  JSON.stringify(halvedHead.dims)
);
check(
  "the decimated voxels are the 2×2 means",
  [0, 1, 2, 3].every((x) => halvedImg[x] === Math.round((2 * x + 2 * x + 1) / 2)),
  Array.from(halvedImg.slice(0, 4)).join(",")
);
check(
  "pixdim doubles in-plane and the slice thickness is untouched",
  near(halvedHead.pixdim[1], 1) && near(halvedHead.pixdim[2], 1) && near(halvedHead.pixdim[3], 0.5),
  halvedHead.pixdim.slice(1, 4).join(",")
);
const sm = new DataView(halved);
check(
  "the sform scales and slides by half a block, and the quaternion is dropped",
  near(sm.getFloat32(280, true), 1, 1e-6) && near(sm.getFloat32(292, true), -9.75, 1e-5) &&
    near(sm.getFloat32(320, true), 3, 1e-6) && halvedHead.qformCode === 0,
  `${sm.getFloat32(280, true)} ${sm.getFloat32(292, true)} qform=${halvedHead.qformCode}`
);
let noSform = "";
const bare = fakeNifti(8, 6, 2, () => 1);
new DataView(bare).setInt16(254, 0, true);
try { XV.decimateNiftiInPlane(bare, 2); } catch (e) { noSform = e.message; }
check("a volume with no sform is refused rather than mis-oriented", noSform.includes("sform"), noSform);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
