# Scan viewer (iPad)

Formerly “X-ray viewer” — the repo and the URL keep the old name.

Offline web viewer for my own scans: 2D windowing, measuring, markup on X-rays, plus an
intensity relief with **Smooth**, **Detail** and **Rounding** presets and an **Auto** button that
reads all three off the film itself (Rounding is what stops a bone shaft reading as a trough
between its two bright edges), plus a CT tab. No build step, no framework — `index.html`,
`viewer-core.js` and the three workers are the app.

**Relief.** Tap Build, or tap the empty black stage. **Mesh** is the grid size (512² default,
1024² for detail), **Smooth / Detail / Rounding** match the desktop presets, **Auto** picks all
three from the film and switches itself off when you change one by hand. One finger orbits, two
fingers zoom and pan, **Home** resets the view, **Invert** flips the shading.

**CT.** The CT tab opens a whole series — a folder of `.dcm` files or one `.zip` — and renders it
with Niivue. **Window** buttons set the grey range in plain words (**Bone** for cortex and
fractures, **Soft tissue** for muscle and fluid, **Lung**, **Brain**), or use the Window / Level
sliders; **Auto** reads the choice off what the series says was scanned and hangs it the
radiological way round. **Slices** shows all three planes plus the 3-D render, **Axial /
Coronal / Sagittal** blow one up on its own, **3-D** shows the render alone — with **Bone** on it
drops everything softer than 300 HU so only bone is left, and one finger turns it. **Slab** adds
3–20 mm of slices into one image (**MIP** keeps the brightest voxel, **MinIP** the darkest,
**Mean** averages), **Cine** plays the slices at 8 a second, **Home** puts the view back. Hold a
finger still on the image for a moment and it reads out the Hounsfield number under the crosshair
plus the mean and spread over a 5 mm disc. The measuring and markup tools work on CT too: a mark
is placed in millimetres on the pane you drew it on, so it stays on that slice (a small hollow dot
shows where it passes through the other two planes), and **Save PNG** writes out the pane you are
looking at. The window you leave a series on comes back next time, and so do its marks.

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
armed; the Pencil never pans. **Lock** freezes the image, **Fit** refits it, **Rotate L/R** turn it,
and **Clear marks** (same row, always on screen) wipes every measurement and markup on this film —
Undo brings them back.

**Measuring.** Line, Angle (end → corner → end), Cobb (two lines), Circle, Ellipse, Point, Text.
Tap points with a finger, or draw with the Pencil — one slide makes a whole line or shape. The
value updates live while placing. Drag any dot to move it; drag the label to move the whole
mark; tap the label for Delete, angle snap, exact value, or Set as reference. Undo / Redo /
Undo point are in the same row.

**Calibrate.** DICOM pixel spacing is used when present. Otherwise (or to override it) tap
**Calibrate**, draw over something of known size, type its length; the status reads
"calibrated (manual)" and every mark re-labels. Lines also show their tilt from horizontal (tap
the label to switch to vertical) and, once a reference line is set, the angle to that reference.

**Markup.** Tap **Markup** for pen, highlighter, arrow, rect, circle, text and eraser with six
colours and three widths — same undo stack. **Save PNG** exports the film with everything drawn
on it (Share sheet on iPad). Marks and calibration are saved per film and come back on reopen.

Reads uncompressed Explicit VR Little Endian DICOM only; anything else reports why it was refused.
Uncalibrated measurements are detector-plane millimetres — not true anatomical distances.
