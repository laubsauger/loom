import { settings, node, edge, graph, document, drivenSlot } from "./builders.ts";

/**
 * E40 — Wake (T729).
 *
 *   bed1(noise 4d, nearly still) ─┐
 *   orb1(circle ┄ pathx1/pathy1) ─┴─► stand1(add) ─┐ order 0
 *                                                   ├─► pick1(switch) ─┬─► past1(cache, 6 back)
 *   clip1(movieFileIn) ─────────────────────────────┘ order 1          │        │
 *                                                                      ▼        ▼
 *                                              under1(level) ◄─┐   moved1(difference)
 *                                                              │        │
 *   gain1(level, whitelevel ┄ bite1) ◄────────────────────────────────── ┘
 *        │
 *        ├─► shiftr1(transform ┄ tear1) ─► fuser1(reorder) ─┐
 *        └─► shiftb1(transform ┄ tearn1) ─► fuseb1(reorder) ┴─► born1(add) ◄─ loop1(feedback)
 *                                                                  │
 *                             born1 ─► paint1(lookup ◄─ palette1) ─┴─► lay1(add) ─► trim1 ─► out1
 *
 * ## What a Cache is FOR, other than a delay line
 *
 * E24 reads three cache taps as an RGB delay, which uses the ring as an echo. This uses it
 * as an INSTRUMENT: the difference between now and six frames ago is a motion field, and
 * everything downstream is a reading of that field rather than of the picture. It is the
 * one operation in the set that cannot be evaluated on a single frame — the subject of the
 * example is change itself, which is why its claims are asserted across FRAME PAIRS and not
 * from a still (§V681).
 *
 * ## The understudy has to MOVE, and that is not decoration (§V687)
 *
 * §V363 says a demo demonstrates itself. An example whose subject is change has no null
 * state that looks like anything: the first version of this graph used a `perlin3d` with no
 * driver, and since `speed` advances the FOURTH dimension and a 3D noise has none (T518,
 * §V624), the field never changed and the whole file rendered PURE BLACK. Not dim — black,
 * with every structural test green about it. So `bed1` is `perlin4d` with a real `speed`,
 * and the subject is `orb1` on two LFOs. The bed is nearly still ON PURPOSE: a bed evolving
 * as fast as the subject travels makes the detector see motion everywhere and the subject
 * never stands out. Something has to hold still for a wake to be a wake ON.
 *
 * ## Grade AFTER the accumulator, so the palette axis is AGE
 *
 * The obvious wiring puts the Lookup before the loop, and it is wrong: the loop then sums
 * GRADED colour, the head pins white, and the tail carries no hue at all. Feeding the raw
 * motion into the accumulator and grading what comes OUT makes the ramp a map of how long
 * ago a pixel moved — fresh reads warm, old reads cool — which is the picture this example
 * is for. So the loop closes on `born1`, not on the final output: §V471.5's shape inverted
 * for the same reason E34 inverts it, because a loop closing on the finished frame would
 * smear the bed along with the wake.
 *
 * ## NO subtractive offset inside a float loop (§V694)
 *
 * This graph had a Level in the loop with `blacklevel: 0.008`, copying E1's idiom for
 * terminating a trail. E1's docstring says blacklevel "crushes the dimmest survivors to
 * zero", which is true in a unorm format and FALSE in the `rgba16float` we ship: an empty
 * pixel goes to -0.008, the loop drives it further down every frame, and the downstream Add
 * then came out DARKER than its own base layer — the bed vanished completely and it read as
 * the compositor being broken. Persistence is already the decay and it cannot go negative,
 * so the node is gone rather than fixed.
 *
 * ## §V703 — the guard found two of these in this very file
 *
 * The structural claim "no Level on the feedback path carries a positive blacklevel" went
 * red on this document within an hour of §V694 being written. `gain1` had 0.02, which sent
 * a zero pixel to -0.00917 and compounded to a -0.1835 floor in the accumulator; `under1`
 * had 0.06, which sent a BLACK source pixel to -0.064 and subtracted it from the wake.
 *
 * They are not equally bad, and the difference is worth knowing. `gain1`'s negative was
 * CONTAINED — `paint1` is a Lookup, and a Lookup clamps by indexing, so a negative index
 * reads the first stop and the value never escapes `born1`. `under1`'s was not contained:
 * it feeds `lay1` directly, so it darkened the finished frame. And it was invisible here
 * because the synthetic bed sits near 0.6 luma; it would have appeared the moment someone
 * pointed `clip1` at footage with real blacks, as a wake that thins over the dark parts of
 * their video for no visible reason. Both are 0 now, and `whitelevel` and `brightness`
 * already carried the range each was nominally buying.
 *
 * ## The gain pairs are fitted to a MEASURED field (§V696)
 *
 * `bite1` sets `gain1.whitelevel`, and the honest number depends entirely on what the
 * difference actually measures — which changed by thirteen times when `orb1` was given a
 * faster path. Fitted by eye it was wrong by an order of magnitude twice, once mapping the
 * field's MEDIAN to 0.86 and blowing the frame white. Louder low band lowers the white
 * point, so the wake flares on the kick; `hold1` lengthens the trail on the same beat.
 */
export const wakeDocument = document(
  "wake",
  "E40 Wake",
  settings(),
  graph(
    [
      node("bed", "noise", [-1620, -420], {
        type: "perlin4d",
        seed: 11,
        period: 0.11,
        harmon: 3,
        spread: 2,
        gain: 0.5,
        rough: 0.5,
        exp: 1.4,
        amp: 1.5,
        offset: 0.1,
        mono: true,
        aspectcorrect: true,
        speed: 0.035,
        t4d: 0.37, // T786: off the 4D lattice plane (T535) — t4d=0 collapses perlin4d's amplitude, so frame 0, which is the gallery card, was systematically flatter than every frame after it
        s4d: 1,
      }, { label: "bed1" }),
      node("orb", "circle", [-1620, -160], {
        mode: "fill",
        center: [0.5, 0.5],
        radius: [0.085, 0.085],
        softness: 0.09,
        fillcolor: [1, 0.97, 0.9, 1],
        bgcolor: [0, 0, 0, 0],
        aspectcorrect: true,
      }, { label: "orb1", parameters: { "center.x": drivenSlot("pathx1", 0.5), "center.y": drivenSlot("pathy1", 0.5), } }),
      node("stand", "add", [-1360, -70], { opacity: 1 }, { label: "stand1" }),
      node("pathx", "lfo", [-1620, 360], { shape: "sine", frequency: 0.29, amplitude: 0.33, offset: 0.5, phase: 0 }, { label: "pathx1" }),
      node("pathy", "lfo", [-1620, 600], { shape: "sine", frequency: 0.203, amplitude: 0.3, offset: 0.5, phase: 0.25 }, { label: "pathy1" }),
      node("clip", "movieFileIn", [-1620, 100], { file: "", playMode: "freeRun", speed: 1 }, { label: "clip1" }),
      node("pick", "switch", [-1360, 150], { index: 0 }, { label: "pick1" }),

      // ── the delay line and the difference against it ───────────────────────
      node("past", "cache", [-1100, 320], { frames: 8, index: 6, scale: 1 }, { label: "past1" }),
      node("moved", "difference", [-840, 150], {}, { label: "moved1" }),
      node("gain", "level", [-580, 150], {
        blacklevel: 0,
        gamma1: 1,
        contrast: 1,
        brightness: 1,
        invert: 0,
        opacity: 1,
      }, { label: "gain1", parameters: { whitelevel: drivenSlot("bite1:low", 2.2), } }),

      // ── chromatic split of the motion, not of the picture ──────────────────
      node("shiftr", "transform", [-320, -60], {
        t: [0.006, 0],
        r: 0,
        s: [1, 1],
        p: [0, 0],
        xord: "srt",
        extend: "hold",
        aspectcorrect: false,
      }, { label: "shiftr1", parameters: { "t.x": drivenSlot("tear1:high", 0.006), } }),
      node("shiftb", "transform", [-320, 360], {
        t: [-0.006, 0],
        r: 0,
        s: [1, 1],
        p: [0, 0],
        xord: "srt",
        extend: "hold",
        aspectcorrect: false,
      }, { label: "shiftb1", parameters: { "t.x": drivenSlot("tearn1:high", -0.006), } }),
      node("fuser", "reorder", [-60, 60], {
        outr: "in2r",
        outg: "in1g",
        outb: "in1b",
        outa: "one",
      }, { label: "fuser1" }),
      node("fuseb", "reorder", [200, 60], {
        outr: "in1r",
        outg: "in1g",
        outb: "in2b",
        outa: "one",
      }, { label: "fuseb1" }),

      // ── grade the motion ──────────────────────────────────────────────────
      node("palette", "ramp", [720, 420], {
        type: "horizontal",
        interp: "linear",
        phase: 0,
        period: 1,
        stops: [
          { position: 0, color: [0, 0, 0, 1] },
          { position: 0.22, color: [0.02, 0.09, 0.22, 1] },
          { position: 0.46, color: [0.05, 0.5, 0.62, 1] },
          { position: 0.68, color: [0.2, 0.92, 0.72, 1] },
          { position: 0.86, color: [0.85, 0.98, 0.55, 1] },
          { position: 1, color: [1, 1, 0.95, 1] },
        ],
      }, { label: "palette1", definitionVersion: 2 }),
      node("paint", "lookup", [980, 60], {
        channel: "luminance",
        row: 0.5,
        offset: 0,
        scale: 1.25,
      }, { label: "paint1" }),

      // ── the phosphor: only what MOVED enters the loop ─────────────────────
      node("loop", "feedback", [460, 380], {
        source: "born1",
        clearColor: [0, 0, 0, 0],
        reset: false,
        substeps: 1,
      }, { label: "loop1", parameters: { persistence: drivenSlot("hold1:level", 0.95), } }),
      node("born", "add", [720, 60], { opacity: 1 }, { label: "born1" }),

      // ── the subject, held down under its own wake ────────────────────────
      node("under", "level", [-1100, -140], {
        blacklevel: 0,
        whitelevel: 1,
        gamma1: 1,
        contrast: 1.4,
        brightness: 0.2,
        invert: 0,
        opacity: 1,
      }, { label: "under1" }),
      node("lay", "add", [1240, 60], { opacity: 1 }, { label: "lay1" }),
      node("trim", "level", [1500, 60], {
        blacklevel: 0,
        whitelevel: 1.25,
        gamma1: 1,
        contrast: 1.08,
        brightness: 1,
        invert: 0,
        opacity: 1,
      }, { label: "trim1" }),
      node("out", "output", [1760, 60], {}, { label: "out1" }),

      // ── the score ────────────────────────────────────────────────────────
      node("beat", "audioPattern", [-1620, 840], { bpm: 126, amount: 1, beatsPerBar: 4 }, { label: "beat1" }),
      node("smooth", "valueLag", [-1360, 840], { lag: 0.07 }, { label: "smooth1" }),

      node("biteg", "valueMath", [-1100, 620], { operation: "multiply", operand: -1.6 }, { label: "biteg1" }),
      node("biteb", "valueMath", [-840, 620], { operation: "add", operand: 3 }, { label: "biteb1" }),
      node("bite", "valueLimit", [-580, 620], { minimum: 1.6, maximum: 3.2 }, { label: "bite1" }),

      node("tearg", "valueMath", [-1100, 880], { operation: "multiply", operand: 0.03 }, { label: "tearg1" }),
      node("tearb", "valueMath", [-840, 880], { operation: "add", operand: 0.004 }, { label: "tearb1" }),
      node("tear", "valueLimit", [-580, 880], { minimum: 0.001, maximum: 0.03 }, { label: "tear1" }),
      node("tearng", "valueMath", [-1100, 1140], { operation: "multiply", operand: -0.03 }, { label: "tearng1" }),
      node("tearnb", "valueMath", [-840, 1140], { operation: "add", operand: -0.004 }, { label: "tearnb1" }),
      node("tearn", "valueLimit", [-580, 1140], { minimum: -0.03, maximum: -0.001 }, { label: "tearn1" }),

      node("holdg", "valueMath", [-1100, 1400], { operation: "multiply", operand: 0.032 }, { label: "holdg1" }),
      node("holdb", "valueMath", [-840, 1400], { operation: "add", operand: 0.93 }, { label: "holdb1" }),
      node("hold", "valueLimit", [-580, 1400], { minimum: 0.92, maximum: 0.972 }, { label: "hold1" }),
    ],
    [
      edge("e-bed-stand", ["bed", "out"], ["stand", "in1"], 0),
      edge("e-orb-stand", ["orb", "out"], ["stand", "in2"], 1),
      edge("e-stand-pick", ["stand", "out"], ["pick", "inputs"], 0),
      edge("e-clip-pick", ["clip", "out"], ["pick", "inputs"], 1),
      edge("e-pick-past", ["pick", "out"], ["past", "input"]),
      edge("e-pick-moved", ["pick", "out"], ["moved", "in1"], 0),
      edge("e-past-moved", ["past", "out"], ["moved", "in2"], 1),
      edge("e-moved-gain", ["moved", "out"], ["gain", "input"]),
      edge("e-gain-shiftr", ["gain", "out"], ["shiftr", "input"]),
      edge("e-gain-shiftb", ["gain", "out"], ["shiftb", "input"]),
      edge("e-gain-fuser", ["gain", "out"], ["fuser", "in1"]),
      edge("e-shiftr-fuser", ["shiftr", "out"], ["fuser", "in2"]),
      edge("e-fuser-fuseb", ["fuser", "out"], ["fuseb", "in1"]),
      edge("e-shiftb-fuseb", ["shiftb", "out"], ["fuseb", "in2"]),
      edge("e-fuseb-born", ["fuseb", "out"], ["born", "in1"], 0),
      edge("e-loop-born", ["loop", "out"], ["born", "in2"], 1),
      edge("e-born-paint", ["born", "out"], ["paint", "source"]),
      edge("e-palette-paint", ["palette", "out"], ["paint", "lookup"]),
      edge("e-pick-under", ["pick", "out"], ["under", "input"]),
      edge("e-under-lay", ["under", "out"], ["lay", "in1"], 0),
      edge("e-paint-lay", ["paint", "out"], ["lay", "in2"], 1),
      edge("e-lay-trim", ["lay", "out"], ["trim", "input"]),
      edge("e-trim-out", ["trim", "out"], ["out", "input"]),
      edge("e-beat-smooth", ["beat", "out"], ["smooth", "in"]),
      edge("e-smooth-biteg", ["smooth", "out"], ["biteg", "a"]),
      edge("e-biteg-biteb", ["biteg", "out"], ["biteb", "a"]),
      edge("e-biteb-bite", ["biteb", "out"], ["bite", "in"]),
      edge("e-smooth-tearg", ["smooth", "out"], ["tearg", "a"]),
      edge("e-tearg-tearb", ["tearg", "out"], ["tearb", "a"]),
      edge("e-tearb-tear", ["tearb", "out"], ["tear", "in"]),
      edge("e-smooth-tearng", ["smooth", "out"], ["tearng", "a"]),
      edge("e-tearng-tearnb", ["tearng", "out"], ["tearnb", "a"]),
      edge("e-tearnb-tearn", ["tearnb", "out"], ["tearn", "in"]),
      edge("e-smooth-holdg", ["smooth", "out"], ["holdg", "a"]),
      edge("e-holdg-holdb", ["holdg", "out"], ["holdb", "a"]),
      edge("e-holdb-hold", ["holdb", "out"], ["hold", "in"]),
    ],
  ),
);
