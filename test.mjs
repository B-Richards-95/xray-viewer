// test.mjs — plain node, no dependencies:  node ipad/test.mjs
// Parses the real AP elbow film and cross-checks the ported maths against values
// worked out by hand from src/xray_viewer/measure.py.
import { readFileSync } from "node:fs";
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
const home = XV.orbitPoint([0, 0, 0], 10, 0, 0);
check("orbit_point at elev 0 / azim 0 looks along -Y", near(home[0], 0, 1e-12) && near(home[1], -10, 1e-12));
const inv = XV.invertLut(1.0);
check("invert_lut(1) flips the ramp", inv[0] === 255 && inv[255] === 0);

// -------------------------------------------------- compressed file rejected
let threw = "";
try {
  const fake = new Uint8Array(400);
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

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
