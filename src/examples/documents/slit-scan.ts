import { settings, node, edge, graph, document, drivenSlot } from "./builders.ts";

/**
 * E8 — Slit Scan (T321, T237).
 *
 * Per-pixel time: a 48-frame history of a disc travelling on two LFOs, read back through a
 * vertical ramp so every ROW shows a different moment — the classic slit-scan smear,
 * newest at the black end of the ramp, 0.8 seconds ago at the white end.
 *
 * T518 — THE SUBJECT CHANGED, and that was the whole fix. This used to smear a `perlin4d`
 * field, and §V427 says why that could not work: a slit scan reveals the HISTORY of
 * something that has identity, and noise is smooth at every scale, so smearing it produces
 * more smoothness. The shipped frame lived entirely between 0.35 and 0.61 in linear — a
 * pastel wash with no edge in it anywhere — and the owner reported that you could not see
 * what the node did. A disc on a path has identity: its history draws a ribbon whose shape
 * IS its path, and the per-row time quantisation appears as a visible staircase along the
 * ribbon's edge. That staircase is the mechanism, drawn.
 *
 * The live source is composited back over the scan (`now`), which also cures a real
 * first-impression defect: before the ring has archived anything there is no oldest frame
 * for §V229's clamp to hold, so frame 0 rendered COMPLETELY BLACK — and frame 0 is what a
 * gallery thumbnail shows.
 *
 * This is the file that fails if the temporal stack regresses: the ring's
 * copy-on-rotate (V276 — archive at frame entry, never mid-encode), the
 * `texture_2d_array` binding and its per-frame head uniforms, and §V229's clamp while
 * the ring fills (the first two seconds are a growing smear, not a flash of black).
 * The memory is the parameter (§V228): 48 frames at 720p rgba16float ≈ 169 MiB, and
 * the frames knob says so where it is set.
 */
export const slitScanDocument = document(
  "e8-slit-scan",
  "E8 Slit Scan",
  settings({ randomSeed: 21 }),
  graph(
    [
      /**
       * T518 — A SLIT SCAN NEEDS A SUBJECT WITH IDENTITY, and noise has none.
       *
       * The source here was a `perlin4d` field, and §V427 is exactly why that could never
       * read: a slit scan SMEARS an image through time, and noise is smooth at every
       * scale, so smearing it produces more smoothness. Measured, the shipped frame lived
       * entirely between 0.35 and 0.61 in linear — a pastel wash with no edge anywhere in
       * it — and the owner's report was that you could not see what the node did.
       *
       * A disc on a path has identity. Every ROW of the output is a different moment, so
       * the disc's history is drawn as a ribbon whose shape IS its path, and the per-row
       * time quantisation shows up as visible stair-steps along the ribbon's edge. That
       * staircase is the node's mechanism made literal, and it is the thing that was
       * missing.
       *
       * The frequencies are chosen against the ring's DEPTH, not by feel: 48 frames at 60
       * fps is 0.8 s of history, and 0.62 Hz puts about half a swing inside that window,
       * which is the longest ribbon that still reads as one gesture.
       */
      node(
        "body",
        "circle",
        [-900, -120],
        {
          mode: "fill",
          center: [0.5, 0.5],
          radius: [0.15, 0.15],
          softness: 0.1,
          fillcolor: [1, 0.8, 0.42, 1],
          bgcolor: [0.05, 0.045, 0.14, 1],
          aspectcorrect: true,
        },
        {
          label: "body1",
          parameters: {
            "center.x": drivenSlot("swingx1", 0.5),
            "center.y": drivenSlot("swingy1", 0.5),
          },
        },
      ),
      // Free-running (§V453), and incommensurate so the path never repeats exactly.
      node(
        "swingx",
        "lfo",
        [-1160, -240],
        { shape: "sine", frequency: 0.62, amplitude: 0.36, offset: 0.5, phase: 0 },
        { label: "swingx1" },
      ),
      node(
        "swingy",
        "lfo",
        [-1160, -20],
        { shape: "sine", frequency: 0.4, amplitude: 0.3, offset: 0.5, phase: 0.25 },
        { label: "swingy1" },
      ),
      node("gradient", "ramp", [-900, 160], { type: "vertical" }, { label: "ramp1", definitionVersion: 2 }),
      node("scan", "slitScan", [-560, 0], { frames: 48, depth: 1 }, { label: "slitscan1" }),
      /**
       * THE PRESENT, ON TOP OF ITS OWN PAST — and it also fixes a real first-impression
       * defect. At frame 0 the ring holds nothing: §V229's clamp holds the OLDEST RECORDED
       * frame, and before the first archive there is no recorded frame to hold, so the
       * shipped file opened on a completely black picture. A gallery thumbnail is usually
       * frame 0. Adding the live source back over the scan means the disc is there from
       * the first frame, and the composition gains the thing that makes a slit scan
       * legible at a glance: you can see the subject AND the trail it is leaving.
       */
      node("now", "add", [-260, -60], { opacity: 0.55 }, { label: "add1" }),
      node("out", "output", [40, -60], {}, { label: "out1" }),
    ],
    [
      edge("e-body-scan", ["body", "out"], ["scan", "input"]),
      edge("e-gradient-scan", ["gradient", "out"], ["scan", "map"]),
      // ONE generator, TWO consumers (§V6): the disc is rendered once per frame.
      edge("e-body-now", ["body", "out"], ["now", "in1"]),
      edge("e-scan-now", ["scan", "out"], ["now", "in2"]),
      edge("e-now-out", ["now", "out"], ["out", "input"]),
    ],
  ),
);
