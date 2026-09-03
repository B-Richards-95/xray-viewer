/* relief-worker.js — the relief height field and its texture source, off the main thread.
 *
 * The passes below are the same ones index.html's reliefFields() runs; on a multi-megapixel
 * film they are seconds of arithmetic, and on the main thread that is a frozen tab. The main
 * thread keeps its own copy of the code as the fallback for when a worker cannot be started.
 *
 * In:  { pixels: ArrayBuffer(Float32), rows, cols, resolution, sigma, windowRange }  (pixels transferred)
 * Out: { ok: true, rows, cols, detail: ArrayBuffer, height: ArrayBuffer }            (both transferred)
 *      { ok: false, error: string }
 */
importScripts("viewer-core.js");

self.onmessage = function (ev) {
  var d = ev.data || {};
  try {
    var full = { data: new Float32Array(d.pixels), rows: d.rows, cols: d.cols };
    var small = XV.downsample(XV.cropToContent(full), d.resolution);
    var detail = XV.normalize(small, d.windowRange);
    var height = XV.gaussianBlur(XV.clipPercentiles(detail), d.sigma);
    self.postMessage(
      {
        ok: true,
        rows: detail.rows,
        cols: detail.cols,
        detail: detail.data.buffer,
        height: height.data.buffer,
      },
      [detail.data.buffer, height.data.buffer]
    );
  } catch (e) {
    self.postMessage({ ok: false, error: e && e.message ? e.message : String(e) });
  }
};
