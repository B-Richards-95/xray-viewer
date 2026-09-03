/* unzip-worker.js — a zip of DICOM files, inflated off the main thread.
 *
 * iOS Files hands over a CT study as one .zip far more easily than as 300 loose files, so the
 * CT tab accepts a zip. The directory parse is XV.zipEntries in viewer-core.js (tested in
 * test.mjs); the inflate is the browser's own DecompressionStream, so there is no library.
 *
 * in   {id, name, buffer}                     the zip's bytes (transferred)
 * out  {id, name, files: [{name, buffer}], skipped, problems}   or {id, name, error}
 */
/* global XV */
"use strict";

importScripts("viewer-core.js");

// The disc index, not an image: it parses as DICOM but has no pixels, so it would only
// ever show up as an error line.
var INDEX_NAMES = { DICOMDIR: 1, "DICOMDIR.": 1 };

function inflateRaw(bytes) {
  if (typeof DecompressionStream === "undefined") {
    return Promise.reject(new Error("this browser cannot unzip — unzip on the computer first"));
  }
  var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Response(stream).arrayBuffer().then(function (out) { return new Uint8Array(out); });
}

function entryBytes(buffer, entry) {
  var raw = new Uint8Array(buffer, entry.dataOffset, entry.compressedSize);
  if (entry.method === XV.ZIP_STORED) return Promise.resolve(raw);
  if (entry.method === XV.ZIP_DEFLATED) return inflateRaw(raw);
  return Promise.reject(new Error("compression method " + entry.method + " is not supported"));
}

self.onmessage = function (event) {
  var job = event.data || {};
  var buffer = job.buffer;
  var entries;
  try {
    entries = XV.zipEntries(buffer);
  } catch (e) {
    self.postMessage({ id: job.id, name: job.name, error: String((e && e.message) || e) });
    return;
  }

  var files = [], problems = [], skipped = 0;
  var wanted = entries.filter(function (entry) {
    if (XV.zipEntryIsJunk(entry.name)) return false;
    var base = entry.name.split("/").pop();
    return !Object.prototype.hasOwnProperty.call(INDEX_NAMES, base.toUpperCase());
  });

  // One entry at a time: a 300-slice study inflated in parallel is 300 copies live at once.
  var chain = Promise.resolve();
  wanted.forEach(function (entry) {
    chain = chain.then(function () {
      return entryBytes(buffer, entry).then(function (bytes) {
        if (!XV.looksLikeDicom(bytes)) { skipped += 1; return; }
        var copy = bytes.buffer.byteLength === bytes.byteLength
          ? bytes.buffer
          : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        files.push({ name: entry.name, buffer: copy });
      }).catch(function (e) {
        problems.push(entry.name + ": " + String((e && e.message) || e));
      });
    });
  });

  chain.then(function () {
    var transfer = files.map(function (f) { return f.buffer; });
    self.postMessage(
      { id: job.id, name: job.name, files: files, skipped: skipped, problems: problems },
      transfer
    );
  }).catch(function (e) {
    self.postMessage({ id: job.id, name: job.name, error: String((e && e.message) || e) });
  });
};
