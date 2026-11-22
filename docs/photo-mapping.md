# Photo projection mapping

Open **File → Map from photo…**, or **Settings → Output → Map from photo…**.
Photograph a stationary surface from beside the projector lens.

1. Choose a reference photo and, optionally, a night photo for preview.
2. Load depth and mask EXRs, generate them, or leave their inputs for later.
3. Inspect the selected effect and calibration chart, then create the network.

**Save all and create** saves any required unsaved maps in order before creating the
network. Already saved files are reused. Cancel a save dialog to stop without creating
or partially changing a network; completed file saves remain available.

## Depth, refinement and range

Depth Anything V2 Small and Large have explicit precision, download size and CPU/GPU
selection. GPU inputs reach 1288 × 1288. Large CPU preparation offers the verified
266 and 518 sizes. Large weights carry a non-commercial license; see
[model verification](models/photo-depth-verification-2026-10-09.md).

Depth Pro 2 S (FP32, 94 MB) and B (FP16, 190 MB) are metric. They save inverse metres
(1/m, 0 for the sky) instead of a relative map, and refinement keeps that unit. Each model
takes a fixed box, 640 × 480 or 672 × 384, and the photo is letterboxed into it: a 16:9
photo fills 75 % of the first box and 98 % of the second. Set the horizontal field of
view: the model scales its metres by the focal length, so a wider view reads nearer. A
JPEG that records a 35 mm equivalent focal length fills it in. S runs on the GPU or the
CPU; B needs WebGPU. The weights are licensed for research use only; see
[Depth Pro 2](models/depth-pro-2.md).

Marigold V2 uses the local quantized Swift/MLX worker in Electron on macOS/Apple Silicon
with at least 36 GiB unified memory. Select 512, 768, 1024, 1280 or 1536 pixels on the
long edge, and a reproducible seed. First Run downloads and verifies 15.3 GB; subsequent
runs use the disk cache. Browser users see the platform indicators and can load saved
Marigold EXRs without native inference. Restart Electron after native-handler updates;
renderer refresh alone cannot change a running main process's supported sizes.

**Guided depth refinement is optional.** It reuses the original native prediction,
smooths noise and aligns edges using the photo. Choose source size, 2K or 4K, then Run
refinement. An output may exceed the photo resolution, within project/device limits.
Upscaling does not recover measured geometry. **Use native depth · skip refinement**
returns to the original prediction without rerunning the model.

Native depth is the original prediction: save it once. If using a refined result,
save that as a separate file too. Refinement records and verifies the original file's
SHA-256 identity, including when an external EXR contains additional attributes.

**Depth range and cutoff** updates native/refined inspection and the effect live.
Far is 0 and near is 1. Original samples remain unchanged; the network stores the
working range. **Depth range** as a mask method creates float32 coverage for the selected
band, with adjustable softness and no model download. Changing its depth or cutoff
settings makes only that dependent mask out of date until an explicit rerun.

## Inspection and mask editing

All inspection tabs support Fit, 100%, button/wheel zoom and pan. Native/refined views
also offer raw samples, pinned points and a comparison divider. Grayscale, Ocean, Heat
and Spectrum palettes affect display copies only. Click any small photo/depth/mask
preview to inspect it in a larger dialog.

Paint in the large **Surface mask** view: Erase, Restore, Pan, brush radius, Undo and
Redo. The cursor follows the brush's native mask-pixel footprint. Editing an existing
mask preserves its pixels until you paint; entering manual editing does not clear it.
Closing and reopening preparation retains the latest draft, maps and edits while the
project stays open. Active work is retired on close.

**Facade walls and openings** combines semantic coverage with photo-guided detail.
Check shaded walls and painted glass before excluding blue reflections. **Object
background removal** is a separate model option. Mask detail offers 1024 or 1536.
Rerunning replaces brush edits; rerunning depth preserves independent mask corrections.

Turn off **Use surface mask** for full-frame coverage, or **Use depth map** for neutral
depth. Both editable Float Map In nodes remain in the created network, ready to load
an EXR later. Assigned missing or corrupt assets remain explicit errors.

## EXR files

Prepared depth and mask artifacts use **`.loom.exr`**: ordinary single-channel FLOAT32
OpenEXR with Loom's source, convention, recipe and parent metadata. No proprietary
numerical container is retained. Raw depth bits, signed zero and mask confidence remain
unchanged; previews may use 8-bit colour. NONE, ZIP and ZIPS scanline FLOAT32 imports
are supported. Other EXR profiles report a specific unsupported-format diagnostic.

Keep the EXRs and photos beside the `.loom.json` project. Relink moved files through
its asset fields. If another tool strips the metadata, preparation asks you to confirm
the depth convention and full-frame registration before saving a new Loom EXR.

Optional grayscale **16-bit PNG/TIFF** exports store 65,536 normalized levels and retain
range/convention metadata for round trips. They never contain the viewer palette.
PNG/TIFF imports read numerical samples directly, without sRGB or gamma conversion.

Suggested filenames include the photo, model, input size, seed and processing settings,
plus a fingerprint of the complete artifact. Different cutoffs, brush corrections and
source bytes produce distinct suggestions. The save dialog remains editable.

## Effects, calibration and video

The default **Photo point cloud** look creates real photo-coloured 3D points through
Point Grid, depth unprojection, photographic paint, Geometry, Camera and Render. A lateral
camera LFO reveals parallax. The default grid samples 768 points along the long edge
(393,216 points for a 3:2 photograph). Point density, point size, colour gain, camera and exposure
remain independent nodes. The reference underlay starts dark so the geometry is clear;
raise its Level brightness to compare against the photograph. Relative depth and assumed
FOV/range describe display geometry, not metric reconstruction.

**Grazing light · modular**, **Contour engraving · modular** and **Depth slices · modular**
separate a float32 range stage, a small depth-processing shader, ordinary motion controls,
colour/compositing and grading. Replace any stage or input using ordinary graph wiring.
The dialogue preview evaluates the same graph controls, including LFOs and camera motion.

The earlier nine editable looks cover neon contours, prismatic sweeps, chromatic relief, surface
tracing, depth reveals, moonlit stone, liquid strata, depth constellations and thermal
scanning. **Projection effect** renders the actual network shader with depth and mask,
including when coverage is full-frame. The image boundary is not a fake glowing frame.

Toggle **Alignment test pattern** for a regular chart with axes and corner markers.
Each new network has an ordinary calibration Switch: effect at index 0, chart at 1.
Both pass through the same surface mask, Grid Warp, Corner Pin and Window Out.

**Mapped video** accepts a local video texture through Movie File In and the same
mapping path. An unassigned video input remains editable for loading later. The dialog
shows decoded video frames; decoding/playback failures are explicit. Reduced motion
shows a still preview. The main Output overlays light on the reference photo; Window
Out carries projector content independently of preview light.

Try [Moonlit Stone](../examples/E83-Photo-Mapping-Moonlit-Stone.md),
[Contour Engraving](../examples/E84-Photo-Mapping-Contour-Engraving.md),
[Video](../examples/E85-Photo-Mapping-Video.md) and
[Point Cloud](../examples/E86-Photo-Mapping-Point-Cloud.md). Their matching synthetic facade/depth/mask
fields demonstrate the mapping controls without assets or model downloads; they do not
claim model accuracy. Video has an explicit procedural-demo/local-clip switch.

Developer setup: **`pnpm native:marigold:build`**, requiring Xcode/Swift 6.3 and Apple
Silicon. Runtime and weights live under `.cache/marigold-v2/`; an explicit absolute
`LOOM_MARIGOLD_DIRECTORY` selects another trusted owner directory. Startup does not build,
download or infer. No helper or cloud is required. See
[native memory and timing evidence](models/marigold-v2-mlx-verification-2026-10-09.md).
Separate normal prediction and calibrated relief remain later stages.
