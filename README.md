# X-ray viewer (iPad)

Offline web viewer for my own elbow radiographs: 2D windowing, measuring, markup, plus an
intensity relief. No build step, no framework — `index.html`, `viewer-core.js` and
`relief-worker.js` are the app.

**Test on the PC.** `node ipad/test.mjs` parses the real AP film and checks the maths against the
desktop app. To see it: `python -m http.server 8765 --directory ipad`, then open
<http://localhost:8765/> and pick the `.dcm` files.

**The files must be DICOM.** That is the medical image format (`.dcm`) a hospital or imaging
centre exports; a JPEG, PNG, or PDF of an X-ray will not open. Ask for "DICOM files" or "the
DICOM disc" if you only have pictures.

**Get the X-rays onto the iPad.** Plug it in and copy the four `.dcm` files across with the
Apple Devices app, or AirDrop them. They land in Files, which is where the viewer picks them up.

**Install on the iPad.** Open the site's URL in **Safari** (other iOS browsers cannot install),
tap **Share → Add to Home Screen**, then **Open** it from the home screen and tap **Open files**
to pick your `.dcm` files. They are remembered between launches and it works with no signal.

**Moving the image.** Two fingers pan, pinch and twist. One finger pans only when no tool is
armed; the Pencil never pans. **Lock** freezes the image, **Fit** refits it, **Rotate L/R** turn it.

**Measuring.** Line, Angle (end → corner → end), Cobb (two lines), Circle, Ellipse, Point, Text.
Tap points with a finger, or draw with the Pencil — one slide makes a whole line or shape. The
value updates live while placing. Drag any dot to move it; drag the label to move the whole
mark; tap the label for Delete, angle snap, exact value, or Set as reference. Undo / Redo /
Undo point / Clear are in the same row.

**Calibrate.** DICOM pixel spacing is used when present. Otherwise (or to override it) tap
**Calibrate**, draw over something of known size, type its length; the status reads
"calibrated (manual)" and every mark re-labels. Lines also show their tilt from horizontal (tap
the label to switch to vertical) and, once a reference line is set, the angle to that reference.

**Markup.** Tap **Markup** for pen, highlighter, arrow, rect, circle, text and eraser with six
colours and three widths — same undo stack. **Save PNG** exports the film with everything drawn
on it (Share sheet on iPad). Marks and calibration are saved per film and come back on reopen.

Reads uncompressed Explicit VR Little Endian DICOM only; anything else reports why it was refused.
Uncalibrated measurements are detector-plane millimetres — not true anatomical distances.
