/* relief-worker.js — the relief height field and its texture source, off the main thread.
 *
 * The pass below is XV.reliefFields, the same call index.html makes; on a multi-megapixel
 * film it is seconds of arithmetic, and on the main thread that is a frozen tab. The main
 * thread makes the same call itself as the fallback for when a worker cannot be started.
 *
 * In:  { pixels: ArrayBuffer(Float32), rows, cols, resolution, sigma, detail, rounding, auto,
 *        windowRange }                                                          (pixels transferred)
 * Out: { ok: true, rows, cols, detail: ArrayBuffer, height: ArrayBuffer, picks }  (both transferred)
 *      { ok: false, error: string }
 *
 * With auto set the presets in the message are ignored and the film picks its own; the picks come
 * back so the tab can show them on its selects.
 */
importScripts("viewer-core.js");

self.onmessage = function (ev) {
  var d = ev.data || {};
  try {
    var full = { data: new Float32Array(d.pixels), rows: d.rows, cols: d.cols };
    var sigma = d.sigma;
    var detailStrength = d.detail;
    var rounding = d.rounding;
    var picks = null;
    if (d.auto) {
      picks = XV.autoPresets(full, d.windowRange);
      sigma = picks.smooth;
      detailStrength = picks.detail;
      rounding = picks.rounding;
    }
    var fields = XV.reliefFields(
      full,
      d.windowRange,
      d.resolution,
      sigma,
      detailStrength / 100.0,
      rounding / 100.0
    );
    var detail = fields.detail;
    var height = fields.height;
    self.postMessage(
      {
        ok: true,
        rows: detail.rows,
        cols: detail.cols,
        detail: detail.data.buffer,
        height: height.data.buffer,
        picks: picks && { smooth: picks.smooth, detail: picks.detail, rounding: picks.rounding },
      },
      [detail.data.buffer, height.data.buffer]
    );
  } catch (e) {
    self.postMessage({ ok: false, error: e && e.message ? e.message : String(e) });
  }
};
