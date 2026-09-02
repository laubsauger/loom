import { settings, node, edge, graph, document, drivenSlot } from "./builders.ts";

/**
 * E44 — Sounding (T755). DEPTH AS GEOMETRY — the first example of the inference arc.
 *
 * Named for the nautical sense: throwing a line to find how deep the water is. `E27 Relief`
 * already carries the sculptural word, and this is the measurement rather than the carving.
 *
 *   bed1(noise, nearly still) ─┐              pivot1(lfo) ┄drives┄► draw1.eye.x
 *   orb1(circle) ← 2 LFOs ─────┴─► stand1(add) ─┬─► pick1(switch) ─► depth1(depth)
 *   clip1(movieFileIn) ────────────── order 1 ─┘             │           │
 *                                                pick1 ┄colour┄► tint1    ▼
 *   out1 ◄── draw1(renderInstances, 6912 boxes ◄ tint1(textureToAttribute) ◄ cloud1(GRID)
 *
 * ## What the picture is
 *
 * A monocular depth model turns a flat image into a distance map; `pointsFromTexture` in
 * GRID mode reads that map on a 96x72 lattice and lifts each point by what it finds. Then
 * `tint1` samples the SOURCE at each point (T830), so every box carries the video's own
 * colour and the cloud is the video STANDING UP in depth — the depth-camera look, from a
 * source that never carried depth. Without that tint the boxes were a grey lattice and the
 * relief said nothing about the picture, which is what the owner reported.
 *
 * ## It opens FLAT, on purpose, and that is the design rather than a shortfall
 *
 * A 94 MB model does not download because a document was opened (§V721). Until it is
 * acquired, `depth1` publishes flat mid-grey — the value `displace` defines as no
 * displacement — so this cloud is a FLAT SHEET and the document renders. Press Download in
 * the notice strip and the same sheet lifts into relief. No example had ever exercised
 * that path, and `sounding-claims.gpu.test.ts` asserts both ends of it: mid-grey in gives a
 * cloud with no measurable relief, a known ramp in gives relief in the known direction.
 *
 * ## The understudy moves, and that is load-bearing (§V687)
 *
 * The subject is depth over TIME, so the synthetic performer is an orb on two free-running
 * LFOs above a nearly-still perlin bed: the bed gives the model something to place, the orb
 * gives it something that moves. Point `clip1` at real footage (pick1.index = 1) and the
 * same lattice reads whatever the video contains.
 *
 * ## The update rate is visible, and the doc says so rather than hiding it
 *
 * Measured: depth is 2599 ms per inference under wasm on one thread (T382). Off the frame
 * loop the picture stays at 60fps, but the RELIEF only changes about every 2.6 seconds,
 * and the node info popup reports the age in frames. The orb is deliberately fast enough
 * that the lag is plain to see. An example that hid it by choosing a slow subject would be
 * flattering the number instead of reporting it.
 *
 * ## The camera PIVOTS, and the sway is the depth cue rather than a garnish (B156)
 *
 * A relief seen from a fixed eye is a picture of a relief: the geometry carries the depth
 * and nothing reveals it. E34 Lidar reached this the hard way and wrote it down — under no
 * light, PARALLAX is what remains. It matters more here than there, for two reasons E34
 * did not have:
 *
 *   - THE RELIEF ONLY CHANGES EVERY 2.6 SECONDS (T752), so the one thing moving at 60fps
 *     has to be the viewpoint. The pivot does not hide the update rate — the orb still
 *     makes the lag plain — it stops the rate from being the ONLY motion in the frame.
 *   - IT READS THE NO-MODEL STATE HONESTLY. A flat lattice standing still is ambiguous;
 *     the owner read it as the example doing nothing (§B156). A flat sheet SWINGING in
 *     perspective is visibly a flat sheet, and the same swing over a real relief is
 *     visibly not. The pivot is what makes the two states tell themselves apart in the
 *     picture, the way the notice strip now does in words.
 *
 * `eye.x` swings +/-0.85 at an xz distance of 3.0 — +/-16 degrees, E34's measured figure
 * for the same problem — at 0.035 Hz, a 28-second round trip. A drift, not a turntable.
 * The sway only ever INCREASES the eye's distance from `lookAt` (3.31 to 3.42 at the
 * extremes), so it cannot push the cloud out of frame; the framing is safe by margin at
 * the near plane in both axes. The plate underneath is a 2D composite and holds still, so
 * the cloud slides against its own image — the parallax made explicit.
 */
export const soundingDocument = document(
  "e44-sounding",
  "E44 Sounding",
  settings({ randomSeed: 44 }),
  graph(
    [
      // ---- the source and its understudy (E41's rig, reused deliberately) ----------
      node("bed", "noise", [-2220, -420], {
        type: "perlin4d", seed: 7, period: 0.16, harmon: 3, spread: 2, gain: 0.5,
        rough: 0.5, exp: 1.3, amp: 1.2, offset: 0.35, mono: true, aspectcorrect: true,
        speed: 0.03, t4d: 0.37, s4d: 1, // T786: off the 4D lattice plane (T535) — t4d=0 collapses perlin4d's amplitude, so frame 0, which is the gallery card, was systematically flatter than every frame after it
      }, { label: "bed1" }),
      node("orb", "circle", [-2220, -140], {
        mode: "fill", center: [0.5, 0.5], radius: [0.13, 0.13], softness: 0.07,
        fillcolor: [1, 0.93, 0.82, 1], bgcolor: [0, 0, 0, 0], aspectcorrect: true,
      }, { label: "orb1", parameters: { "center.x": drivenSlot("pathx1", 0.5), "center.y": drivenSlot("pathy1", 0.5) } }),
      node("pathx", "lfo", [-2220, 420], { shape: "sine", frequency: 0.31, amplitude: 0.3, offset: 0.5, phase: 0 }, { label: "pathx1" }),
      node("pathy", "lfo", [-2220, 700], { shape: "sine", frequency: 0.223, amplitude: 0.26, offset: 0.5, phase: 0.25 }, { label: "pathy1" }),
      node("clip", "movieFileIn", [-2220, 140], { file: "", playMode: "freeRun", speed: 1 }, { label: "clip1" }),
      node("stand", "add", [-1920, -280], { opacity: 1 }, { label: "stand1" }),
      node("pick", "switch", [-1920, 20], { index: 0 }, { label: "pick1" }),

      // ---- the inference, and the lattice that reads it ----------------------------
      node("depth", "depth", [-1620, -60], { model: "accurate" }, { label: "depth1" }),
      node("cloud", "pointsFromTexture", [-1320, -60], {
        // T830: sizeX = sizeY = 2 puts each point's XY on the clip square [-1,1], which is
        // the coordinate `textureToAttribute` reads back as a UV — so `tint1` below samples
        // the SOURCE at the very texel that set this point's height, and the colour lands on
        // the right box. At 2.6×1.95 the bridge (which assumes clip) squished the image into
        // the middle columns and smeared the edges, so the cloud could not carry the picture.
        mode: "grid", cols: 96, rows: 72, sizeX: 2.0, sizeY: 2.0, depth: 1.9, threshold: 0.02,
      }, { label: "cloud1" }),
      // T830 — the fix the owner's report demanded: the boxes carried NOTHING from the video
      // but their height, so the picture was a grey lattice in front of a dimmed plate. This
      // bridge samples the source at each point (pointsFromTexture writes only position —
      // colour is textureToAttribute's job by composition) and hands `draw1` a per-point
      // colour, so the cloud IS the video standing up in depth — E27's lesson, its own path.
      node("tint", "textureToAttribute", [-1170, -60], { count: 6912 }, { label: "tint1" }),

      // ---- the look: a dense box cloud, lit, seen from off-axis so relief reads -----
      node("draw", "renderInstances", [-1020, -60], {
        /*
         * 6912 = cols x rows exactly, and `scale` is HALF the lattice spacing (2.6/96 =
         * 0.027) on purpose: at the spacing itself the boxes touch and the cloud fuses
         * into an opaque slab with the relief showing only as faint contour lines. It has
         * to read as points for the depth to read at all.
         */
        count: 6912, shape: "box", scale: 0.006,
        // T830: the colour is MAPPED from the `sample` attribute tint1 wrote — the source's
        // own colour per box (T369). The static [1,1,1,1] is the fallback a host with no
        // attribute attached resolves to (§V108): white, so the lit box shows plain rather
        // than the old tan slab, and the examples gate frames a legible cloud either way.
        color: [1, 1, 1, 1],
        eye: [0, 1.35, 3.0], lookAt: [0, -0.05, 0], fov: 44,
      }, {
        label: "draw1",
        parameters: {
          "eye.x": drivenSlot("pivot1", 0),
          color: { mode: "map", bindings: { static: { kind: "static", value: [1, 1, 1, 1] }, map: { kind: "map", attribute: "sample" } } },
        },
      }),
      // The retained value is 0 — the authored `eye.x` — so the structural compile in the
      // examples gate, which attaches no channels (§V108), frames exactly the shot this
      // document was tuned against. A retained value that was not a sane picture on its
      // own would make every gate here judge a camera nobody chose.
      node("pivot", "lfo", [-1020, -400], {
        shape: "sine", frequency: 0.035, amplitude: 0.85, offset: 0, phase: 0,
      }, { label: "pivot1" }),
      // The source is ADDED under the cloud, not composited over it: `renderInstances`
      // clears to OPAQUE black, so an `over` would simply hide the plate. Additive suits
      // it anyway — the scan reads as light standing off its own image. Both states are
      // then a picture: flat, the grid lies on the plate; with depth, it lifts (§V471).
      node("plate", "add", [-720, -60], { opacity: 1 }, { label: "plate1" }),
      node("dim", "level", [-1320, 300], {
        /*
         * LINEAR, and the number looks wrong until you remember that (§V587/§V56). The
         * output display-encodes, so linear 0.15 arrives on screen as about 0.44 grey —
         * which is why an earlier pass at "dim" made the plate LIGHTER. 0.035 linear is
         * the roughly 0.2 the picture wants.
         */
        blacklevel: 0, whitelevel: 1, gamma1: 1, contrast: 1, brightness: 0.035, invert: 0, opacity: 1,
      }, { label: "dim1" }),
      node("out", "output", [-420, -60], {}, { label: "out1" }),
    ],
    [
      edge("e-bed-stand", ["bed", "out"], ["stand", "in1"]),
      edge("e-orb-stand", ["orb", "out"], ["stand", "in2"]),
      // BRANCH 0 is the understudy, BRANCH 1 is the footage, and the ORDER SAYS SO (§V131).
      edge("e-stand-pick", ["stand", "out"], ["pick", "inputs"], 0),
      edge("e-clip-pick", ["clip", "out"], ["pick", "inputs"], 1),
      edge("e-pick-depth", ["pick", "out"], ["depth", "input"]),
      edge("e-depth-cloud", ["depth", "out"], ["cloud", "texture"]),
      // T830: the cloud's positions go through tint1, which also samples the SOURCE (pick1,
      // the undimmed picture) to give each point the video's own colour before the draw.
      edge("e-cloud-tint", ["cloud", "out"], ["tint", "points"]),
      edge("e-pick-tint", ["pick", "out"], ["tint", "texture"]),
      edge("e-tint-draw", ["tint", "out"], ["draw", "points"]),
      edge("e-pick-dim", ["pick", "out"], ["dim", "input"]),
      edge("e-draw-plate", ["draw", "out"], ["plate", "in1"]),
      edge("e-dim-plate", ["dim", "out"], ["plate", "in2"]),
      edge("e-plate-out", ["plate", "out"], ["out", "input"]),
    ],
  ),
);
