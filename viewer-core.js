/* viewer-core.js — DICOM reading and the pure maths, shared by index.html and test.mjs.
 *
 * Loaded two ways on purpose:
 *   browser  <script src="viewer-core.js">
 *   node     await import('./viewer-core.js')   (runs the file, reads globalThis.XV)
 * so it deliberately has no `import`/`export` statements and publishes one global.
 *
 * Ports, behaviour-for-behaviour, from the desktop app:
 *   src/xray_viewer/dicom_io.py       identify_view, percentile_window, to_display_grey, _spacing,
 *                                     apply_generic_labels
 *   src/xray_viewer/measure.py        distance/angle formulas and their suffix strings
 *   src/xray_viewer/view2d.py         window_bounds, levels<->window, blend_lut
 *   src/xray_viewer/view3d_relief.py  downsample, normalize, gaussian_blur, crop_to_content,
 *                                     clip_percentiles, RELIEF_HEIGHT, SMOOTH_PRESETS, HOME_*
 */
(function (root) {
  "use strict";

  // ---------------------------------------------------------------- constants

  var SERIES_LABELS = {
    "ELBOW AP": "AP",
    "ELBOW OBL": "Oblique",
    "ELBOW LAT": "Lateral",
  };

  var FILENAME_LABELS = [
    ["lateral_flexed", "Lateral flexed"],
    ["lateral flexed", "Lateral flexed"],
    ["flexed", "Lateral flexed"],
    ["lateral", "Lateral"],
    ["oblique", "Oblique"],
    ["obl", "Oblique"],
    ["ap", "AP"],
  ];

  var KNOWN_VIEWS = ["AP", "Oblique", "Lateral", "Lateral flexed"];

  var SPACING_RATIO_BOUNDS = [0.5, 2.0];
  var SPACING_MISSING = "missing";
  // view2d gesture modes: anything that is not MODE_VIEW places points instead of panning.
  var MODE_VIEW = "none";
  var MONOCHROME1 = "MONOCHROME1";

  var DISTANCE_SUFFIX = "mm (detector plane — uncalibrated)";
  var PIXEL_SUFFIX = "px — uncalibrated (px), no pixel spacing in this file";

  // view3d_relief.py
  var RELIEF_HEIGHT = 60.0;
  var RESOLUTIONS = [512, 1024];
  // 512² builds in a fraction of the time of 1024² and is the safe default on an iPad.
  var RESOLUTION_DEFAULT = 512;
  var CROP_TARGET = 256;
  var CROP_BLUR_SIGMA = 4.0;
  var CROP_THRESHOLD = 0.25;
  var CROP_INSET = 0.06;
  var CLIP_PERCENTILES = [2.0, 98.0];
  var SMOOTH_PRESETS = [["Off", 0], ["Low", 1], ["Med", 2], ["High", 4]];
  var SMOOTH_DEFAULT = 2;
  var INVERT_PRESETS = [["Full", 100], ["Half", 50], ["Subtle", 25]];
  var INVERT_DEFAULT = 100;
  var LUT_SIZE = 256;
  var HOME_ELEVATION_DEG = 38.0;
  var HOME_AZIMUTH_DEG = -35.0;
  var HOME_DISTANCE_FACTOR = 1.6;
  var HOME_ZOOM = 1.6;

  var RELIEF_NOTE = "Intensity relief — summed attenuation, not bone density";

  // ------------------------------------------------------------ small helpers

  function DicomLoadError(message) {
    var err = new Error(message);
    err.name = "DicomLoadError";
    return err;
  }

  /** numpy's np.percentile default ("linear"): virtual index q/100*(n-1), interpolated. */
  function percentileSorted(sorted, q) {
    var n = sorted.length;
    if (n === 0) return NaN;
    var pos = (q / 100.0) * (n - 1);
    var lo = Math.floor(pos);
    var hi = Math.ceil(pos);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  function stemTokens(filename) {
    var stem = String(filename).replace(/\.[^.\/\\]*$/, "");
    stem = stem.replace(/[\/\\]/g, "");
    return stem.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }

  function labelFromFilename(filename) {
    var stem = stemTokens(filename);
    if (stem.indexOf("flex") !== -1) return "Lateral flexed";
    var probe = stem.split("_").join(" ");
    for (var i = 0; i < FILENAME_LABELS.length; i++) {
      if (probe.indexOf(FILENAME_LABELS[i][0]) !== -1) return FILENAME_LABELS[i][1];
    }
    return null;
  }

  /** Port of dicom_io.identify_view: series description first, filename as the tie-break. */
  function identifyView(filename, seriesDescription, viewPosition) {
    var fromName = labelFromFilename(filename);
    var series = String(seriesDescription || "").trim().toUpperCase();
    var base = Object.prototype.hasOwnProperty.call(SERIES_LABELS, series) ? SERIES_LABELS[series] : null;
    if (base === null && viewPosition) {
      var key = "ELBOW " + String(viewPosition).trim().toUpperCase();
      base = Object.prototype.hasOwnProperty.call(SERIES_LABELS, key) ? SERIES_LABELS[key] : null;
    }
    if (base === "Lateral" && (fromName === "Lateral" || fromName === "Lateral flexed")) return fromName;
    if (base !== null) return base;
    if (fromName !== null) return fromName;
    return "";
  }

  /** Port of dicom_io.apply_generic_labels: an unrecognised view gets a plain number, not a guess. */
  function applyGenericLabels(radiographs) {
    for (var i = 0; i < radiographs.length; i++) {
      if (KNOWN_VIEWS.indexOf(radiographs[i].label) === -1) {
        radiographs[i].label = "Image " + (i + 1);
      }
    }
    return radiographs;
  }

  // ------------------------------------------------------------- windowing

  /** Port of dicom_io.percentile_window, including the >4 megapixel strided subsample. */
  function percentileWindow(pixels, rows, cols, low, high) {
    low = low === undefined ? 1.0 : low;
    high = high === undefined ? 99.0 : high;
    var size = rows * cols;
    var step = 1;
    if (size > 4000000) step = Math.ceil(Math.sqrt(size / 4000000));
    var sampleRows = Math.ceil(rows / step);
    var sampleCols = Math.ceil(cols / step);
    var sample = new Float64Array(sampleRows * sampleCols);
    var k = 0;
    for (var r = 0; r < rows; r += step) {
      var base = r * cols;
      for (var c = 0; c < cols; c += step) sample[k++] = pixels[base + c];
    }
    sample = sample.subarray(0, k);
    var sorted = Float64Array.from(sample);
    sorted.sort();
    var lo = percentileSorted(sorted, low);
    var hi = percentileSorted(sorted, high);
    if (hi <= lo) hi = lo + 1.0;
    return { center: (lo + hi) / 2.0, width: hi - lo };
  }

  /** Port of view2d.window_bounds: slider limits taken from this image's own range. */
  function windowBounds(pixels) {
    var min = Infinity;
    var max = -Infinity;
    for (var i = 0; i < pixels.length; i++) {
      var v = pixels[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    var low = Math.floor(min);
    var high = Math.ceil(max);
    var span = Math.max(high - low, 1);
    return { levelMin: low, levelMax: high, widthMin: 1, widthMax: span };
  }

  function levelsFromWindow(center, width) {
    var half = Math.max(width, 1.0) / 2.0;
    return [center - half, center + half];
  }

  function windowFromLevels(levels) {
    return { center: (levels[0] + levels[1]) / 2.0, width: Math.max(levels[1] - levels[0], 1.0) };
  }

  /** Port of view2d.blend_lut: grey ramp cross-faded with its inverse, 256 entries. */
  function blendLut(strength) {
    var s = Math.min(Math.max(strength, 0.0), 1.0);
    var lut = new Uint8Array(256);
    for (var i = 0; i < 256; i++) {
      if (s <= 0.0) lut[i] = i;
      else if (s >= 1.0) lut[i] = 255 - i;
      else lut[i] = Math.round(i * (1.0 - s) + (255 - i) * s);
    }
    return lut;
  }

  // --------------------------------------------------------------- measuring

  function distancePx(a, b) {
    return Math.hypot(b[0] - a[0], b[1] - a[1]);
  }

  function distanceMm(a, b, spacingMm) {
    var dx = (b[0] - a[0]) * spacingMm[1];
    var dy = (b[1] - a[1]) * spacingMm[0];
    return Math.hypot(dx, dy);
  }

  function angleDeg(a, vertex, b, spacingMm) {
    spacingMm = spacingMm || [1.0, 1.0];
    var ax = (a[0] - vertex[0]) * spacingMm[1];
    var ay = (a[1] - vertex[1]) * spacingMm[0];
    var bx = (b[0] - vertex[0]) * spacingMm[1];
    var by = (b[1] - vertex[1]) * spacingMm[0];
    var na = Math.hypot(ax, ay);
    var nb = Math.hypot(bx, by);
    if (na === 0.0 || nb === 0.0) return 0.0;
    var cos = (ax * bx + ay * by) / (na * nb);
    return (Math.acos(Math.max(-1.0, Math.min(1.0, cos))) * 180.0) / Math.PI;
  }

  // ponytail: Number.toFixed rounds half away from zero, Python's format rounds half to even.
  // They can disagree on the last digit of a measurement ending in exactly .x5; upgrade path is
  // a shared round-half-to-even formatter if a cross-check ever lands on that boundary.
  function formatDistance(a, b, spacingMm, calibrated) {
    if (calibrated === false) return distancePx(a, b).toFixed(1) + " " + PIXEL_SUFFIX;
    return distanceMm(a, b, spacingMm).toFixed(1) + " " + DISTANCE_SUFFIX;
  }

  function formatAngle(a, vertex, b, spacingMm) {
    return angleDeg(a, vertex, b, spacingMm).toFixed(1) + "°";
  }

  // ------------------------------------------------------------------ marks
  // A mark is {id, type, pts:[[x, y]...], meta} with every point in image pixels, and no
  // value stored on it: describeMark recomputes the label at draw time, so recalibrating
  // the film relabels marks that were placed before it.

  var POINTS_NEEDED = {
    line: 2, angle: 3, cobb: 4, circle: 2, ellipse: 2, point: 1, text: 1,
    calibrate: 2,
    ink: 2, hilite: 2, arrow: 2, rect: 2, ellipseShape: 2, note: 1,
  };
  // Markup strokes live in the same marks array as measurements but carry no measured
  // value, are never edited by handle, and draw underneath everything measured.
  var MARKUP_TYPES = { ink: 1, hilite: 1, arrow: 1, rect: 1, ellipseShape: 1, note: 1 };
  var MM_PER_UNIT = { mm: 1.0, cm: 10.0, in: 25.4 };
  // Where a mark's label sits relative to its last handle, in screen px. Drawing and
  // hit-testing share it so a tap lands on what the eye sees.
  var LABEL_OFFSET = [16, -28];

  function toMm(p, spacingMm) {
    return [p[0] * spacingMm[1], p[1] * spacingMm[0]];
  }

  /** Direction of a->b measured from screen-right, degrees, in millimetre space. */
  function lineTiltDeg(a, b, spacingMm) {
    spacingMm = spacingMm || [1.0, 1.0];
    var ma = toMm(a, spacingMm), mb = toMm(b, spacingMm);
    return (Math.atan2(mb[1] - ma[1], mb[0] - ma[0]) * 180.0) / Math.PI;
  }

  /** Signed difference between two tilts folded into (-90, 90]: which way line 2 leans. */
  function tiltDifference(t1, t2) {
    var d = (((t2 - t1 + 90) % 180) + 180) % 180;
    return d - 90 === -90 ? 90 : d - 90;
  }

  /** Cobb angle: the acute angle between two lines given as [a1, a2, b1, b2]. */
  function cobbAngle(pts, spacingMm) {
    if (!pts || pts.length < 4) return 0.0;
    return Math.abs(tiltDifference(lineTiltDeg(pts[0], pts[1], spacingMm), lineTiltDeg(pts[2], pts[3], spacingMm)));
  }

  /** Circle from centre + a point on the rim. Millimetres unless calibrated === false. */
  function circleMetrics(pts, spacingMm, calibrated) {
    var r = calibrated === false ? distancePx(pts[0], pts[1]) : distanceMm(pts[0], pts[1], spacingMm);
    return { radius: r, diameter: 2 * r };
  }

  /** Ellipse from two opposite corners of its bounding box: both axes, longer first. */
  function ellipseMetrics(pts, spacingMm, calibrated) {
    var sp = calibrated === false ? [1.0, 1.0] : spacingMm || [1.0, 1.0];
    var w = Math.abs(pts[1][0] - pts[0][0]) * sp[1];
    var h = Math.abs(pts[1][1] - pts[0][1]) * sp[0];
    return { major: Math.max(w, h), minor: Math.min(w, h), width: w, height: h };
  }

  function isMarkup(mark) {
    return !!(mark && Object.prototype.hasOwnProperty.call(MARKUP_TYPES, mark.type));
  }

  /* Manual calibration (Weasis pattern): the user draws a line over something whose real
   * length they know, and that fixes mm-per-pixel. Isotropic on purpose — one drawn line
   * cannot separate row spacing from column spacing.
   */
  function spacingFromKnownLength(a, b, length, unit) {
    var px = distancePx(a, b);
    var mm = Number(length) * (MM_PER_UNIT[unit] || 1.0);
    if (!(px > 0) || !(mm > 0)) return null;
    return [mm / px, mm / px];
  }

  /** How far a->b leans off the horizontal (axis "h") or the vertical ("v"), 0..90. */
  function tiltFromAxis(a, b, spacingMm, axis) {
    var t = ((lineTiltDeg(a, b, spacingMm) % 180) + 180) % 180;
    if (t > 90) t = 180 - t;
    return axis === "v" ? 90 - t : t;
  }

  /** Acute angle between two lines' directions, 0..90 — a line's difference from the reference. */
  function lineDeltaDeg(pts, refPts, spacingMm) {
    return Math.abs(tiltDifference(
      lineTiltDeg(refPts[0], refPts[1], spacingMm),
      lineTiltDeg(pts[0], pts[1], spacingMm)
    ));
  }

  /** The label a mark carries, recomputed from its points. "" while it is incomplete.
   *  `opts.reference` is the mark flagged as the reference line, if any. */
  function describeMark(mark, spacingMm, calibrated, opts) {
    var pts = (mark && mark.pts) || [];
    var meta = (mark && mark.meta) || {};
    var sp = calibrated === false ? [1.0, 1.0] : spacingMm || [1.0, 1.0];
    var suffix = calibrated === false ? PIXEL_SUFFIX : DISTANCE_SUFFIX;
    if (mark.type === "text" || mark.type === "note") return meta.text || "";
    if (mark.type === "point") return meta.n === undefined ? "" : String(meta.n);
    // Markup carries no measurement, so it never draws a label.
    if (isMarkup(mark)) return "";
    if (pts.length < (POINTS_NEEDED[mark.type] || 0)) return "";
    if (mark.type === "calibrate") return distancePx(pts[0], pts[1]).toFixed(0) + " px";
    if (mark.type === "line") {
      var axis = meta.tiltAxis === "v" ? "v" : "h";
      var parts = [
        formatDistance(pts[0], pts[1], sp, calibrated),
        tiltFromAxis(pts[0], pts[1], sp, axis).toFixed(1) + "° from " + (axis === "v" ? "V" : "H"),
      ];
      var ref = opts && opts.reference;
      if (ref && ref.id !== mark.id && (ref.pts || []).length >= 2) {
        parts.push("Δ vs ref " + lineDeltaDeg(pts, ref.pts, sp).toFixed(1) + "°");
      }
      return parts.join(" · ");
    }
    if (mark.type === "angle") return formatAngle(pts[0], pts[1], pts[2], sp);
    if (mark.type === "cobb") return cobbAngle(pts, sp).toFixed(1) + "° Cobb";
    if (mark.type === "circle") {
      var c = circleMetrics(pts, sp, calibrated);
      return "⌀ " + c.diameter.toFixed(1) + " · r " + c.radius.toFixed(1) + " " + suffix;
    }
    if (mark.type === "ellipse") {
      var e = ellipseMetrics(pts, sp, calibrated);
      return "axes " + e.major.toFixed(1) + " × " + e.minor.toFixed(1) + " " + suffix;
    }
    return "";
  }

  /* Nearest grabbable thing to a screen point: a handle, or the mark's label.
   * Topmost mark wins a tie (the list is walked backwards), and nothing outside
   * `radius` screen px is ever returned — pan and pinch must not grab a handle.
   */
  function hitTest(marks, screenPt, toScreen, radius) {
    var best = null, bestD = radius;
    for (var i = (marks || []).length - 1; i >= 0; i--) {
      // Markup has no handles: a stroke is erased whole, never dragged point by point.
      if (isMarkup(marks[i])) continue;
      var pts = marks[i].pts || [];
      for (var j = 0; j < pts.length; j++) {
        var s = toScreen(pts[j]);
        var d = Math.hypot(screenPt[0] - s[0], screenPt[1] - s[1]);
        if (d < bestD) { bestD = d; best = { markIndex: i, ptIndex: j }; }
      }
      if (pts.length) {
        var l = toScreen(pts[pts.length - 1]);
        var dl = Math.hypot(screenPt[0] - l[0] - LABEL_OFFSET[0], screenPt[1] - l[1] - LABEL_OFFSET[1]);
        if (dl < bestD) { bestD = dl; best = { markIndex: i, ptIndex: "label" }; }
      }
    }
    return best;
  }

  function pointSegmentDistance(p, a, b) {
    var vx = b[0] - a[0], vy = b[1] - a[1];
    var len2 = vx * vx + vy * vy;
    var t = len2 > 0 ? ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vy));
  }

  /* Ramer-Douglas-Peucker: a freehand stroke arrives as one point per pointermove, so it is
   * thinned to the points that actually carry its shape before it is stored.
   */
  function simplifyPolyline(pts, tolerance) {
    var copy = function (p) { return p.slice(); };
    if (!pts || pts.length < 3) return (pts || []).map(copy);
    var keep = new Uint8Array(pts.length);
    keep[0] = 1;
    keep[pts.length - 1] = 1;
    var stack = [[0, pts.length - 1]];
    while (stack.length) {
      var seg = stack.pop(), lo = seg[0], hi = seg[1];
      var far = -1, farD = tolerance;
      for (var i = lo + 1; i < hi; i++) {
        var d = pointSegmentDistance(pts[i], pts[lo], pts[hi]);
        if (d > farD) { farD = d; far = i; }
      }
      if (far >= 0) { keep[far] = 1; stack.push([lo, far], [far, hi]); }
    }
    var out = [];
    for (var j = 0; j < pts.length; j++) if (keep[j]) out.push(copy(pts[j]));
    return out;
  }

  /** Shortest distance from a point to a polyline — how the eraser decides what it touched. */
  function polylineDistance(pts, p) {
    if (!pts || !pts.length) return Infinity;
    if (pts.length === 1) return Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]);
    var best = Infinity;
    for (var i = 1; i < pts.length; i++) {
      var d = pointSegmentDistance(p, pts[i - 1], pts[i]);
      if (d < best) best = d;
    }
    return best;
  }

  function snapAngle(deg, step) {
    return step > 0 ? Math.round(deg / step) * step : deg;
  }

  /** Rotate a point about a pivot by `deg`, in millimetre space, back into image px. */
  function rotateAboutMm(pivot, p, deg, spacingMm) {
    var sp = spacingMm || [1.0, 1.0];
    var mp = toMm(pivot, sp), m = toMm(p, sp);
    var a = (deg * Math.PI) / 180.0, cos = Math.cos(a), sin = Math.sin(a);
    var dx = m[0] - mp[0], dy = m[1] - mp[1];
    return [(mp[0] + cos * dx - sin * dy) / sp[1], (mp[1] + sin * dx + cos * dy) / sp[0]];
  }

  /* Set an angle/cobb mark to an exact value by turning its last arm, keeping the arm's
   * length and the side it currently leans (Datum's typed-angle pattern).
   */
  function setMarkAngle(mark, deg, spacingMm) {
    var pts = mark.pts.map(function (p) { return p.slice(); });
    if (mark.type === "angle" && pts.length >= 3) {
      var current = angleDeg(pts[0], pts[1], pts[2], spacingMm);
      var v = toMm(pts[1], spacingMm || [1.0, 1.0]);
      var a = toMm(pts[0], spacingMm || [1.0, 1.0]);
      var b = toMm(pts[2], spacingMm || [1.0, 1.0]);
      var cross = (a[0] - v[0]) * (b[1] - v[1]) - (a[1] - v[1]) * (b[0] - v[0]);
      pts[2] = rotateAboutMm(pts[1], pts[2], (cross < 0 ? -1 : 1) * (deg - current), spacingMm);
      return pts;
    }
    if (mark.type === "cobb" && pts.length >= 4) {
      var t1 = lineTiltDeg(pts[0], pts[1], spacingMm);
      var t2 = lineTiltDeg(pts[2], pts[3], spacingMm);
      var lean = tiltDifference(t1, t2);
      pts[3] = rotateAboutMm(pts[2], pts[3], (lean < 0 ? -1 : 1) * deg - lean, spacingMm);
      return pts;
    }
    return pts;
  }

  /* Set a line/circle mark to an exact length by sliding its last point along the ray it
   * already lies on. `value` is the line's length, or the circle's diameter.
   */
  function setMarkLength(mark, value, spacingMm, calibrated) {
    var pts = mark.pts.map(function (p) { return p.slice(); });
    if (pts.length < 2) return pts;
    var target = mark.type === "circle" ? value / 2 : value;
    var current = calibrated === false
      ? distancePx(pts[0], pts[1])
      : distanceMm(pts[0], pts[1], spacingMm);
    if (!(current > 0) || !(target > 0)) return pts;
    var k = target / current;
    pts[1] = [pts[0][0] + (pts[1][0] - pts[0][0]) * k, pts[0][1] + (pts[1][1] - pts[0][1]) * k];
    return pts;
  }

  // ------------------------------------------------------------ relief maths

  /** Port of view3d_relief.downsample: plain strided decimation, no averaging. */
  function downsample(plane, target) {
    var step = Math.max(1, Math.ceil(Math.max(plane.rows, plane.cols) / target));
    if (step === 1) return { data: plane.data, rows: plane.rows, cols: plane.cols };
    var rows = Math.ceil(plane.rows / step);
    var cols = Math.ceil(plane.cols / step);
    var out = new Float32Array(rows * cols);
    for (var r = 0; r < rows; r++) {
      var src = r * step * plane.cols;
      var dst = r * cols;
      for (var c = 0; c < cols; c++) out[dst + c] = plane.data[src + c * step];
    }
    return { data: out, rows: rows, cols: cols };
  }

  /** Port of view3d_relief.normalize: window range mapped onto 0..1, clipped. */
  function normalize(plane, window) {
    var lo = window[0];
    var hi = window[1];
    if (hi <= lo) hi = lo + 1.0;
    var scale = 1.0 / (hi - lo);
    var out = new Float32Array(plane.data.length);
    for (var i = 0; i < out.length; i++) {
      var v = (plane.data[i] - lo) * scale;
      out[i] = v < 0 ? 0 : v > 1 ? 1 : v;
    }
    return { data: out, rows: plane.rows, cols: plane.cols };
  }

  function gaussianKernel(sigma) {
    var radius = Math.max(1, Math.round(3.0 * sigma));
    var kernel = new Float32Array(2 * radius + 1);
    var sum = 0.0;
    for (var i = -radius; i <= radius; i++) {
      var v = Math.exp(-(i * i) / (2.0 * sigma * sigma));
      kernel[i + radius] = v;
      sum += v;
    }
    for (var j = 0; j < kernel.length; j++) kernel[j] /= sum;
    return kernel;
  }

  /** Port of view3d_relief.gaussian_blur: separable, columns then rows, edge-clamped. */
  function gaussianBlur(plane, sigma) {
    var rows = plane.rows;
    var cols = plane.cols;
    var src = Float32Array.from(plane.data);
    if (sigma <= 0.0) return { data: src, rows: rows, cols: cols };
    var kernel = gaussianKernel(sigma);
    var radius = (kernel.length - 1) / 2;
    var tmp = new Float32Array(rows * cols);
    var r, c, k, acc, idx;
    for (r = 0; r < rows; r++) {
      for (c = 0; c < cols; c++) {
        acc = 0.0;
        for (k = -radius; k <= radius; k++) {
          idx = c + k;
          if (idx < 0) idx = 0;
          else if (idx >= cols) idx = cols - 1;
          acc += src[r * cols + idx] * kernel[k + radius];
        }
        tmp[r * cols + c] = acc;
      }
    }
    var out = new Float32Array(rows * cols);
    for (c = 0; c < cols; c++) {
      for (r = 0; r < rows; r++) {
        acc = 0.0;
        for (k = -radius; k <= radius; k++) {
          idx = r + k;
          if (idx < 0) idx = 0;
          else if (idx >= rows) idx = rows - 1;
          acc += tmp[idx * cols + c] * kernel[k + radius];
        }
        out[r * cols + c] = acc;
      }
    }
    return { data: out, rows: rows, cols: cols };
  }

  /** Port of view3d_relief.content_bounds, inset arithmetic sequenced exactly as the desktop does. */
  function contentBounds(plane) {
    var rows = plane.rows;
    var cols = plane.cols;
    var step = Math.max(1, Math.ceil(Math.max(rows, cols) / CROP_TARGET));
    var small = downsample(plane, CROP_TARGET);
    if (step === 1) small = { data: Float32Array.from(plane.data), rows: rows, cols: cols };
    var blurred = gaussianBlur(small, CROP_BLUR_SIGMA);
    var lo = Infinity;
    var hi = -Infinity;
    var i;
    for (i = 0; i < blurred.data.length; i++) {
      if (blurred.data[i] < lo) lo = blurred.data[i];
      if (blurred.data[i] > hi) hi = blurred.data[i];
    }
    if (hi <= lo) return [0, rows, 0, cols];
    var cut = lo + CROP_THRESHOLD * (hi - lo);
    var firstRow = -1, lastRow = -1, firstCol = -1, lastCol = -1;
    var r, c;
    for (r = 0; r < blurred.rows; r++) {
      for (c = 0; c < blurred.cols; c++) {
        if (blurred.data[r * blurred.cols + c] >= cut) {
          if (firstRow < 0) firstRow = r;
          lastRow = r;
          if (firstCol < 0 || c < firstCol) firstCol = c;
          if (c > lastCol) lastCol = c;
        }
      }
    }
    if (firstRow < 0 || firstCol < 0) return [0, rows, 0, cols];
    var r0 = firstRow * step;
    var r1 = Math.min(rows, (lastRow + 1) * step);
    var c0 = firstCol * step;
    var c1 = Math.min(cols, (lastCol + 1) * step);
    r0 += Math.trunc((r1 - r0) * CROP_INSET);
    r1 -= Math.trunc((r1 - r0) * CROP_INSET);
    c0 += Math.trunc((c1 - c0) * CROP_INSET);
    c1 -= Math.trunc((c1 - c0) * CROP_INSET);
    if (r1 - r0 < 8 || c1 - c0 < 8) return [0, rows, 0, cols];
    return [r0, r1, c0, c1];
  }

  function cropToContent(plane) {
    var b = contentBounds(plane);
    var rows = b[1] - b[0];
    var cols = b[3] - b[2];
    var out = new Float32Array(rows * cols);
    for (var r = 0; r < rows; r++) {
      var src = (b[0] + r) * plane.cols + b[2];
      out.set(plane.data.subarray(src, src + cols), r * cols);
    }
    return { data: out, rows: rows, cols: cols };
  }

  /** Port of view3d_relief.clip_percentiles: 2/98 stretch onto 0..1. */
  function clipPercentiles(plane) {
    var sorted = Float64Array.from(plane.data);
    sorted.sort();
    var lo = percentileSorted(sorted, CLIP_PERCENTILES[0]);
    var hi = percentileSorted(sorted, CLIP_PERCENTILES[1]);
    var out = new Float32Array(plane.data.length);
    if (hi <= lo) return { data: out, rows: plane.rows, cols: plane.cols };
    var scale = 1.0 / (hi - lo);
    for (var i = 0; i < out.length; i++) {
      var v = plane.data[i];
      if (v < lo) v = lo;
      else if (v > hi) v = hi;
      out[i] = (v - lo) * scale;
    }
    return { data: out, rows: plane.rows, cols: plane.cols };
  }

  /** Port of view3d_relief.invert_lut: grey ramp fading to its inverse at full strength. */
  function invertLut(strength) {
    var lut = new Uint8Array(LUT_SIZE);
    for (var i = 0; i < LUT_SIZE; i++) {
      var v = i / (LUT_SIZE - 1);
      var shaded = v * (1.0 - 2.0 * strength) + strength;
      lut[i] = Math.max(0, Math.min(255, Math.round(shaded * 255.0)));
    }
    return lut;
  }

  /** Port of view3d_relief.orbit_point: pyvista's Z-up orbit, elevation/azimuth in degrees. */
  function orbitPoint(center, radius, elevationDeg, azimuthDeg) {
    var e = (elevationDeg * Math.PI) / 180.0;
    var a = (azimuthDeg * Math.PI) / 180.0;
    return [
      center[0] + radius * Math.cos(e) * Math.sin(a),
      center[1] + radius * -Math.cos(e) * Math.cos(a),
      center[2] + radius * Math.sin(e),
    ];
  }

  // ------------------------------------------------- gestures and 2-D xform

  /* One place decides what a pointer is allowed to do, so the canvas handlers never
   * have to reason about it again:
   *   measuring/marking up  1 pointer places a point, it never pans
   *   viewing               1 finger pans, a pen never pans (it would ruin pencil taps)
   *   two pointers          pan + pinch (+ twist), unless the image is locked
   *   locked                nothing moves the image, but taps still place points
   */
  function gestureFor(pointerType, mode, pointerCount, locked) {
    if (!(pointerCount > 0)) return "none";
    if (pointerCount >= 2) return locked ? "none" : "pinch";
    var measuring = !!mode && mode !== MODE_VIEW;
    if (measuring) return "place";
    if (locked) return "none";
    return pointerType === "pen" ? "none" : "pan";
  }

  /** Image px -> screen px for xform {scale, tx, ty, rot} (rot in radians, clockwise on screen). */
  function imageToScreen(p, xform) {
    var rot = xform.rot || 0;
    var cos = Math.cos(rot), sin = Math.sin(rot), s = xform.scale;
    return [
      s * (cos * p[0] - sin * p[1]) + xform.tx,
      s * (sin * p[0] + cos * p[1]) + xform.ty,
    ];
  }

  /** The exact inverse of imageToScreen. */
  function screenToImage(p, xform) {
    var rot = xform.rot || 0;
    var cos = Math.cos(rot), sin = Math.sin(rot), s = xform.scale;
    var dx = (p[0] - xform.tx) / s, dy = (p[1] - xform.ty) / s;
    return [cos * dx + sin * dy, -sin * dx + cos * dy];
  }

  /** Size of the axis-aligned box a cols x rows image fills once rotated by rot. */
  function rotatedExtent(cols, rows, rot) {
    var cos = Math.abs(Math.cos(rot || 0)), sin = Math.abs(Math.sin(rot || 0));
    return { width: cols * cos + rows * sin, height: cols * sin + rows * cos };
  }

  /** The [tx, ty] that pins imagePt to screenPt at this scale and rotation. */
  function translationFixing(imagePt, screenPt, scale, rot) {
    var cos = Math.cos(rot || 0), sin = Math.sin(rot || 0);
    return [
      screenPt[0] - scale * (cos * imagePt[0] - sin * imagePt[1]),
      screenPt[1] - scale * (sin * imagePt[0] + cos * imagePt[1]),
    ];
  }

  // ---------------------------------------------------------- DICOM parsing

  var TRANSFER_SYNTAXES = {
    "1.2.840.10008.1.2": "Implicit VR Little Endian",
    "1.2.840.10008.1.2.1": "Explicit VR Little Endian",
    "1.2.840.10008.1.2.1.99": "Deflated Explicit VR Little Endian",
    "1.2.840.10008.1.2.2": "Explicit VR Big Endian",
    "1.2.840.10008.1.2.4.50": "JPEG Baseline",
    "1.2.840.10008.1.2.4.51": "JPEG Extended",
    "1.2.840.10008.1.2.4.57": "JPEG Lossless",
    "1.2.840.10008.1.2.4.70": "JPEG Lossless SV1",
    "1.2.840.10008.1.2.4.80": "JPEG-LS Lossless",
    "1.2.840.10008.1.2.4.81": "JPEG-LS Near-Lossless",
    "1.2.840.10008.1.2.4.90": "JPEG 2000 Lossless",
    "1.2.840.10008.1.2.4.91": "JPEG 2000",
    "1.2.840.10008.1.2.5": "RLE Lossless",
  };

  var EXPLICIT_VR_LE = "1.2.840.10008.1.2.1";
  var LONG_LENGTH_VRS = { OB: 1, OD: 1, OF: 1, OL: 1, OV: 1, OW: 1, SQ: 1, UC: 1, UN: 1, UR: 1, UT: 1 };
  var UNDEFINED_LENGTH = 0xffffffff;

  function tagKey(group, element) {
    return ((group << 16) >>> 0) + element;
  }

  function readAscii(view, offset, length) {
    var s = "";
    for (var i = 0; i < length; i++) {
      var code = view.getUint8(offset + i);
      if (code === 0) break;
      s += String.fromCharCode(code);
    }
    return s.replace(/[\s ]+$/, "");
  }

  function decimalStrings(text) {
    var parts = String(text).split("\\");
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var v = parseFloat(parts[i]);
      out.push(v);
    }
    return out;
  }

  /* ponytail: Explicit VR Little Endian only, and only the handful of tags the viewer reads.
   * No implicit VR, no big endian, no deflated, no character-set handling, no pixel-data
   * fragments. Upgrade path: swap this reader for dcmjs/dicom-parser if a non-conforming
   * export ever needs opening on the iPad. */
  /** Header of one Explicit VR element, or null when the bytes are not a plausible element. */
  function readHeader(view, offset) {
    var vr = String.fromCharCode(view.getUint8(offset + 4), view.getUint8(offset + 5));
    if (Object.prototype.hasOwnProperty.call(LONG_LENGTH_VRS, vr)) {
      return { vr: vr, length: view.getUint32(offset + 8, true), valueOffset: offset + 12 };
    }
    if (/^[A-Z][A-Z]$/.test(vr)) {
      return { vr: vr, length: view.getUint16(offset + 6, true), valueOffset: offset + 8 };
    }
    return null;
  }

  function isSequenceVr(vr, group) {
    return vr === "SQ" || (vr === "UN" && group !== 0x7fe0);
  }

  /** Walk items of an undefined-length sequence; returns the offset just past (FFFE,E0DD). */
  function skipUndefinedSequence(view, offset, end) {
    while (offset + 8 <= end) {
      var group = view.getUint16(offset, true);
      var element = view.getUint16(offset + 2, true);
      var length = view.getUint32(offset + 4, true);
      offset += 8;
      if (group !== 0xfffe) return end; // malformed nesting — abandon the sequence, don't guess
      if (element === 0xe0dd) return offset;
      if (element !== 0xe000) return end;
      offset = length === UNDEFINED_LENGTH ? skipUndefinedItem(view, offset, end) : offset + length;
    }
    return end;
  }

  /** Walk one undefined-length item's elements; returns the offset just past (FFFE,E00D). */
  function skipUndefinedItem(view, offset, end) {
    while (offset + 8 <= end) {
      var group = view.getUint16(offset, true);
      var element = view.getUint16(offset + 2, true);
      if (group === 0xfffe) {
        var itemLength = view.getUint32(offset + 4, true);
        offset += 8;
        if (element === 0xe00d) return offset;
        if (element === 0xe000 && itemLength !== UNDEFINED_LENGTH) offset += itemLength;
        continue;
      }
      var header = readHeader(view, offset);
      if (header === null) return end;
      if (header.length === UNDEFINED_LENGTH) {
        if (!isSequenceVr(header.vr, group)) return end;
        offset = skipUndefinedSequence(view, header.valueOffset, end);
        continue;
      }
      offset = header.valueOffset + header.length;
    }
    return end;
  }

  function scanElements(view, start, end, wanted, found, metaOnly) {
    var offset = start;
    while (offset + 8 <= end) {
      var group = view.getUint16(offset, true);
      var element = view.getUint16(offset + 2, true);
      if (metaOnly && group !== 0x0002) return;

      if (group === 0xfffe) {
        var itemLength = view.getUint32(offset + 4, true);
        offset += 8;
        if (element === 0xe000 && itemLength !== UNDEFINED_LENGTH) offset += itemLength;
        continue;
      }

      var header = readHeader(view, offset);
      if (header === null) {
        throw DicomLoadError(
          "not a readable DICOM file (unexpected value representation at byte " + offset + ")"
        );
      }
      var key = tagKey(group, element);

      if (header.length === UNDEFINED_LENGTH) {
        if (key === tagKey(0x7fe0, 0x0010)) {
          found.encapsulated = true; // fragmented pixel data means a compressed transfer syntax
          return;
        }
        if (!isSequenceVr(header.vr, group)) return;
        offset = skipUndefinedSequence(view, header.valueOffset, end);
        continue;
      }

      if (header.vr === "SQ") {
        offset = header.valueOffset + header.length;
        continue;
      }

      if (Object.prototype.hasOwnProperty.call(wanted, key)) {
        found[wanted[key]] = { vr: header.vr, offset: header.valueOffset, length: header.length };
      }

      if (key === tagKey(0x7fe0, 0x0010)) return;
      offset = header.valueOffset + header.length;
    }
  }

  var WANTED = {};
  WANTED[tagKey(0x0008, 0x103e)] = "seriesDescription";
  WANTED[tagKey(0x0018, 0x1164)] = "imagerPixelSpacing";
  WANTED[tagKey(0x0018, 0x5101)] = "viewPosition";
  WANTED[tagKey(0x0028, 0x0002)] = "samplesPerPixel";
  WANTED[tagKey(0x0028, 0x0004)] = "photometric";
  WANTED[tagKey(0x0028, 0x0010)] = "rows";
  WANTED[tagKey(0x0028, 0x0011)] = "columns";
  WANTED[tagKey(0x0028, 0x0030)] = "pixelSpacing";
  WANTED[tagKey(0x0028, 0x0100)] = "bitsAllocated";
  WANTED[tagKey(0x0028, 0x0101)] = "bitsStored";
  WANTED[tagKey(0x0028, 0x0103)] = "pixelRepresentation";
  WANTED[tagKey(0x7fe0, 0x0010)] = "pixelData";

  var META_WANTED = {};
  META_WANTED[tagKey(0x0002, 0x0000)] = "groupLength";
  META_WANTED[tagKey(0x0002, 0x0010)] = "transferSyntax";

  /** Port of dicom_io._spacing: an unusable pair is reported missing, never faked as 1 mm. */
  function chooseSpacing(pixelSpacing, imagerPixelSpacing) {
    var candidates = [
      ["PixelSpacing", pixelSpacing],
      ["ImagerPixelSpacing", imagerPixelSpacing],
    ];
    for (var i = 0; i < candidates.length; i++) {
      var name = candidates[i][0];
      var value = candidates[i][1];
      if (!value || value.length !== 2) continue;
      var rows = value[0];
      var cols = value[1];
      if (!isFinite(rows) || !isFinite(cols) || rows <= 0.0 || cols <= 0.0) continue;
      var ratio = rows / cols;
      if (!(SPACING_RATIO_BOUNDS[0] <= ratio && ratio <= SPACING_RATIO_BOUNDS[1])) continue;
      return { spacingMm: [rows, cols], spacingSource: name };
    }
    return { spacingMm: [1.0, 1.0], spacingSource: SPACING_MISSING };
  }

  /** Port of dicom_io.to_display_grey, including the MONOCHROME1 flip to bright-is-high. */
  function toDisplayGrey(samples, rows, cols, samplesPerPixel, photometric, bitsStored) {
    var count = rows * cols;
    var data = new Float32Array(count);
    var i;
    if (samplesPerPixel === 3 || samplesPerPixel === 4) {
      for (i = 0; i < count; i++) {
        var s = i * samplesPerPixel;
        data[i] = (samples[s] + samples[s + 1] + samples[s + 2]) / 3.0;
      }
    } else if (samplesPerPixel === 1) {
      for (i = 0; i < count; i++) data[i] = samples[i];
    } else {
      throw DicomLoadError("unsupported pixel array shape (" + samplesPerPixel + " samples per pixel)");
    }

    var low = Infinity;
    var high = -Infinity;
    for (i = 0; i < count; i++) {
      if (data[i] < low) low = data[i];
      if (data[i] > high) high = data[i];
    }
    if (low < 0.0) {
      for (i = 0; i < count; i++) data[i] -= low;
      high -= low;
    }
    if (high > 65535.0) {
      var scale = 65535.0 / high;
      for (i = 0; i < count; i++) data[i] *= scale;
    }
    var grey = new Uint16Array(count);
    var greyMax = 0;
    for (i = 0; i < count; i++) {
      var v = data[i] | 0;
      grey[i] = v;
      if (v > greyMax) greyMax = v;
    }

    if (String(photometric || "").trim().toUpperCase() === MONOCHROME1) {
      var ceiling = bitsStored > 0 && bitsStored <= 16 ? (1 << bitsStored) - 1 : 0;
      if (greyMax > ceiling) ceiling = greyMax;
      for (i = 0; i < count; i++) grey[i] = ceiling - grey[i];
    }
    return grey;
  }

  /**
   * Turn one file's bytes into a radiograph.
   * @param {ArrayBuffer} buffer raw file contents
   * @param {string} filename used for the view label, exactly as the desktop uses the path stem
   */
  function parseDicom(buffer, filename) {
    var view = new DataView(buffer);
    if (buffer.byteLength < 140) throw DicomLoadError("not a readable DICOM file (too short)");
    if (readAscii(view, 128, 4) !== "DICM") {
      // ponytail: no preamble-less DICOM. Upgrade path: sniff for a group-0008 element at byte 0.
      throw DicomLoadError("not a readable DICOM file (no DICM marker at byte 128)");
    }

    var meta = {};
    scanElements(view, 132, buffer.byteLength, META_WANTED, meta, true);
    var syntax = meta.transferSyntax
      ? readAscii(view, meta.transferSyntax.offset, meta.transferSyntax.length)
      : "";
    if (syntax !== EXPLICIT_VR_LE) {
      var name = TRANSFER_SYNTAXES[syntax] || "unknown transfer syntax";
      throw DicomLoadError(
        "pixel data could not be decoded (" +
          name +
          (syntax ? " " + syntax : "") +
          "). This viewer reads uncompressed Explicit VR Little Endian only."
      );
    }

    var metaEnd = 132;
    if (meta.groupLength) {
      var groupLength = view.getUint32(meta.groupLength.offset, true);
      metaEnd = meta.groupLength.offset + meta.groupLength.length + groupLength;
    }

    var found = {};
    scanElements(view, metaEnd, buffer.byteLength, WANTED, found, false);

    if (found.encapsulated) {
      throw DicomLoadError(
        "pixel data could not be decoded (encapsulated/compressed pixel data). " +
          "This viewer reads uncompressed Explicit VR Little Endian only."
      );
    }
    if (!found.pixelData) throw DicomLoadError("pixel data could not be decoded (no PixelData element)");
    if (!found.rows || !found.columns) throw DicomLoadError("not a readable DICOM file (no Rows/Columns)");

    var rows = view.getUint16(found.rows.offset, true);
    var cols = view.getUint16(found.columns.offset, true);
    var samplesPerPixel = found.samplesPerPixel ? view.getUint16(found.samplesPerPixel.offset, true) : 1;
    var bitsAllocated = found.bitsAllocated ? view.getUint16(found.bitsAllocated.offset, true) : 16;
    var bitsStored = found.bitsStored ? view.getUint16(found.bitsStored.offset, true) : 0;
    var signed = found.pixelRepresentation ? view.getUint16(found.pixelRepresentation.offset, true) : 0;
    var photometric = found.photometric ? readAscii(view, found.photometric.offset, found.photometric.length) : "";
    var seriesDescription = found.seriesDescription
      ? readAscii(view, found.seriesDescription.offset, found.seriesDescription.length)
      : "";
    var viewPosition = found.viewPosition
      ? readAscii(view, found.viewPosition.offset, found.viewPosition.length)
      : "";

    var expected = rows * cols * samplesPerPixel;
    var samples;
    if (bitsAllocated === 16) {
      if (found.pixelData.length < expected * 2) {
        throw DicomLoadError("pixel data could not be decoded (truncated pixel data)");
      }
      samples = signed
        ? new Int16Array(buffer.slice(found.pixelData.offset, found.pixelData.offset + expected * 2))
        : new Uint16Array(buffer.slice(found.pixelData.offset, found.pixelData.offset + expected * 2));
    } else if (bitsAllocated === 8) {
      if (found.pixelData.length < expected) {
        throw DicomLoadError("pixel data could not be decoded (truncated pixel data)");
      }
      samples = signed
        ? new Int8Array(buffer.slice(found.pixelData.offset, found.pixelData.offset + expected))
        : new Uint8Array(buffer.slice(found.pixelData.offset, found.pixelData.offset + expected));
    } else {
      // ponytail: 8- and 16-bit only. Upgrade path: unpack BitsAllocated 1 and 32 here.
      throw DicomLoadError("pixel data could not be decoded (BitsAllocated " + bitsAllocated + ")");
    }

    var pixels = toDisplayGrey(samples, rows, cols, samplesPerPixel, photometric, bitsStored);
    var window = percentileWindow(pixels, rows, cols);
    var spacing = chooseSpacing(
      found.pixelSpacing ? decimalStrings(readAscii(view, found.pixelSpacing.offset, found.pixelSpacing.length)) : null,
      found.imagerPixelSpacing
        ? decimalStrings(readAscii(view, found.imagerPixelSpacing.offset, found.imagerPixelSpacing.length))
        : null
    );

    var half = window.width / 2.0;
    return {
      name: filename,
      label: identifyView(filename, seriesDescription, viewPosition),
      pixels: pixels,
      rows: rows,
      cols: cols,
      spacingMm: spacing.spacingMm,
      spacingSource: spacing.spacingSource,
      spacingIsValid: spacing.spacingSource !== SPACING_MISSING,
      windowCenter: window.center,
      windowWidth: window.width,
      windowRange: [window.center - half, window.center + half],
      seriesDescription: seriesDescription,
      viewPosition: viewPosition,
      photometric: photometric,
      bitsStored: bitsStored,
    };
  }

  root.XV = {
    DicomLoadError: DicomLoadError,
    parseDicom: parseDicom,
    toDisplayGrey: toDisplayGrey,
    identifyView: identifyView,
    applyGenericLabels: applyGenericLabels,
    percentileWindow: percentileWindow,
    chooseSpacing: chooseSpacing,
    windowBounds: windowBounds,
    levelsFromWindow: levelsFromWindow,
    windowFromLevels: windowFromLevels,
    blendLut: blendLut,
    distancePx: distancePx,
    distanceMm: distanceMm,
    angleDeg: angleDeg,
    formatDistance: formatDistance,
    formatAngle: formatAngle,
    lineTiltDeg: lineTiltDeg,
    cobbAngle: cobbAngle,
    circleMetrics: circleMetrics,
    ellipseMetrics: ellipseMetrics,
    describeMark: describeMark,
    isMarkup: isMarkup,
    spacingFromKnownLength: spacingFromKnownLength,
    tiltFromAxis: tiltFromAxis,
    lineDeltaDeg: lineDeltaDeg,
    simplifyPolyline: simplifyPolyline,
    polylineDistance: polylineDistance,
    hitTest: hitTest,
    snapAngle: snapAngle,
    setMarkAngle: setMarkAngle,
    setMarkLength: setMarkLength,
    POINTS_NEEDED: POINTS_NEEDED,
    MARKUP_TYPES: MARKUP_TYPES,
    MM_PER_UNIT: MM_PER_UNIT,
    LABEL_OFFSET: LABEL_OFFSET,
    downsample: downsample,
    normalize: normalize,
    gaussianBlur: gaussianBlur,
    cropToContent: cropToContent,
    contentBounds: contentBounds,
    clipPercentiles: clipPercentiles,
    invertLut: invertLut,
    orbitPoint: orbitPoint,
    gestureFor: gestureFor,
    imageToScreen: imageToScreen,
    screenToImage: screenToImage,
    rotatedExtent: rotatedExtent,
    translationFixing: translationFixing,
    MODE_VIEW: MODE_VIEW,
    DISTANCE_SUFFIX: DISTANCE_SUFFIX,
    PIXEL_SUFFIX: PIXEL_SUFFIX,
    KNOWN_VIEWS: KNOWN_VIEWS,
    SPACING_MISSING: SPACING_MISSING,
    RELIEF_HEIGHT: RELIEF_HEIGHT,
    RELIEF_NOTE: RELIEF_NOTE,
    RESOLUTIONS: RESOLUTIONS,
    RESOLUTION_DEFAULT: RESOLUTION_DEFAULT,
    SMOOTH_PRESETS: SMOOTH_PRESETS,
    SMOOTH_DEFAULT: SMOOTH_DEFAULT,
    INVERT_PRESETS: INVERT_PRESETS,
    INVERT_DEFAULT: INVERT_DEFAULT,
    CLIP_PERCENTILES: CLIP_PERCENTILES,
    HOME_ELEVATION_DEG: HOME_ELEVATION_DEG,
    HOME_AZIMUTH_DEG: HOME_AZIMUTH_DEG,
    HOME_DISTANCE_FACTOR: HOME_DISTANCE_FACTOR,
    HOME_ZOOM: HOME_ZOOM,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
