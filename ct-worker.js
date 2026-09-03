/* ct-worker.js — the CT tab's thick-slice projection, off the main thread.
 *
 * Niivue 0.69 has no slab/MIP of its own (the string "MIP" does not occur once in
 * niivue.umd.js), so the projection is arithmetic we do ourselves: XV.slabProject in
 * viewer-core.js, the same call index.html would make, over a 512×512×68 volume — tens of
 * millions of reads, which on the main thread is a frozen tab mid-pinch. The main thread makes
 * the same call itself as the fallback for when a worker cannot be started.
 *
 * in   {id, img, type, dims, axis, half, mode}   img is the raw voxel buffer (transferred)
 * out  {id, img, type}                           the projected buffer (transferred)
 *      {id, error}
 */
/* global XV */
"use strict";

importScripts("viewer-core.js");

var ARRAYS = {
  Int8Array: Int8Array, Uint8Array: Uint8Array, Int16Array: Int16Array,
  Uint16Array: Uint16Array, Int32Array: Int32Array, Uint32Array: Uint32Array,
  Float32Array: Float32Array, Float64Array: Float64Array,
};

self.onmessage = function (ev) {
  var d = ev.data || {};
  try {
    var Ctor = ARRAYS[d.type];
    if (!Ctor) throw new Error("voxels of type " + d.type + " cannot be projected");
    var out = XV.slabProject(new Ctor(d.img), d.dims, d.axis, d.half, d.mode);
    var buffer = out.buffer;
    self.postMessage({ id: d.id, img: buffer, type: d.type }, [buffer]);
  } catch (e) {
    self.postMessage({ id: d.id, error: (e && e.message) || String(e) });
  }
};
