# X-ray viewer (iPad)

Offline web viewer for my own elbow radiographs: 2D windowing with tap-to-measure, plus an
intensity relief. No build step, no framework — `index.html` and `viewer-core.js` are the app.

**Test on the PC.** `node ipad/test.mjs` parses the real AP film and checks the maths against the
desktop app. To see it: `python -m http.server 8765 --directory ipad`, then open
<http://localhost:8765/> and pick the `.dcm` files.

**Get the X-rays onto the iPad.** Plug it in and copy the four `.dcm` files across with the
Apple Devices app, or AirDrop them. They land in Files, which is where the viewer picks them up.

**Install on the iPad.** Open the site's URL in **Safari** (other iOS browsers cannot install),
tap **Share → Add to Home Screen**, then **Open** it from the home screen and tap **Open files**
to pick your `.dcm` files. They are remembered between launches and it works with no signal.

Reads uncompressed Explicit VR Little Endian DICOM only; anything else reports why it was refused.
Measurements are detector-plane millimetres, uncalibrated — not true anatomical distances.
