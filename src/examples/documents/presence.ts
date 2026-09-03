import { settings, node, edge, graph, document, expressionSlot } from "./builders.ts";

/**
 * E52 — Presence (T1029). THE OS CUTS THE PERSON OUT, AND THE ROOM KNOWS.
 *
 *   cam1(webcam) ─┐
 *   stand1(rig)  ─┴► src1(switch) ─► mask1(personMask) ─► key1(multiply ◄ src1)
 *   haze1(noise) ─► wash1(hsv) ─────────────────────────► room1(over ◄ key1) ─► out1
 *
 * ## What the picture is
 *
 * A presence mirror: whoever stands at the camera is lifted off their background by
 * `personMask` — Apple's own Vision segmentation, reached through the local helper —
 * and composited over a slow synthetic haze. No model downloads, no weights, nothing
 * to verify (§V858): the OS supplies the model, which is exactly the trade this node
 * exists to demonstrate against the Matte node's hash-pinned, downloadable one. The
 * room answers the person: `mask1:coverage` — §V856's scalar, the fraction of the
 * frame the mask claims — drives the haze's saturation, so an empty room sits
 * near-grey and wakes into colour as someone walks in. "Ran and found nobody" is a
 * VALUE here, not an absence.
 *
 * ## Degrade, stated because every gate sees it (§T715)
 *
 * The shipped default is the deterministic understudy (`src1` at 0 — a webcam cannot
 * gate headlessly, E27's precedent), and the understudy contains NO PERSON, so on any
 * machine without the helper — and on every headless gate — the mask is zero
 * everywhere, `key1` goes black, `room1` shows the grey haze alone, and coverage
 * reads 0. That is the correct picture of an empty room, not a failure; the node's
 * diagnostic says what pairing the helper would change. Flip `src1` to 1 with the
 * helper attached and the mirror is live.
 */
export const presenceDocument = document(
  "e52-presence",
  "E52 Presence",
  settings({ randomSeed: 52 }),
  graph(
    [
      // ---- the performer's stand-in (deterministic; contains nobody, on purpose).
      //      Speeds are set where the cook oracle can SEE them: at its 128x72, 80-frame
      //      scale a 0.04 drift changed no byte and the example read as a static poster
      //      — a picture that moves must move at every scale a gate watches it at. ----
      node("bed", "noise", [-1920, -140], {
        type: "perlin4d", seed: 5, period: 0.35, harmon: 3, spread: 2, gain: 0.45,
        rough: 0.5, exp: 1.3, amp: 1, offset: 0.1, mono: false, aspectcorrect: true,
        speed: 0.35, t4d: 0.2, s4d: 1,
      }, { label: "bed1" }),
      /* The live half (E47's precedent): permission is requested only when the webcam
         node activates, never on load. */
      node("cam", "webcam", [-1920, 140], {}, { label: "cam1" }),
      node("src", "switch", [-1620, 0], { index: 0 }, { label: "src1" }),

      // ---- the cut ------------------------------------------------------------------
      /* The OS's verdict on "who is a person", at 10 Hz by default: each ask crosses
         the bridge (~1 MB), so the rate limit is a bandwidth dial as much as a CPU one. */
      node("mask", "personMask", [-1320, -140], { rateLimit: 0.1, invert: false }, { label: "mask1" }),
      /* The key: the source times its own mask — white-where-person on every channel
         (the node's convention, shared with Matte) makes multiply THE compositor. */
      node("key", "multiply", [-1020, 0], { opacity: 1 }, { label: "key1" }),

      // ---- the room that knows ------------------------------------------------------
      /* perlin4d, NOT a 3d type: the fourth dimension is what `speed` advances, and a
         3d haze with a speed knob is a static picture wearing a motion parameter — the
         cook oracle read the whole example as a poster because this layer (the only
         one visible without a helper) had no time axis at all. MONO, then tinted by a
         solid: hsv-saturating a multi-hue noise averaged to white-grey pastel, which is
         how the first shipped thumbnail was a blown-out poster (T1037's fix). */
      node("haze", "noise", [-1320, 320], {
        type: "perlin4d", seed: 12, period: 0.9, harmon: 2, spread: 2, gain: 0.4,
        rough: 0.5, exp: 1, amp: 0.7, offset: 0.15, mono: true, aspectcorrect: true,
        speed: 0.14, t4d: 0.37, s4d: 1,
      }, { label: "haze1" }),
      node("ink", "solid", [-1320, 600], { color: [0.12, 0.75, 0.5, 1] }, { label: "ink1" }),
      node("tint", "multiply", [-1020, 620], { opacity: 1 }, { label: "tint1" }),
      /* §V856 SPENT as LIGHT: the room BRIGHTENS with coverage. Empty room = dim green
         haze; a person filling a tenth of the frame turns the lamp up. The channel is
         the seam's own (`<name>:coverage`), so the wiring is one expression. */
      node("wash", "level", [-1020, 320], {},
        { label: "wash1", parameters: { brightness: expressionSlot("0.55 + op('mask1').chan.coverage * 4", 0.55) } }),
      node("room", "over", [-720, 80], { opacity: 1 }, { label: "room1" }),
      node("out", "output", [-420, 80], {}, { label: "out1" }),
    ],
    [
      edge("e1", ["bed", "out"], ["src", "inputs"], 0),
      edge("e2", ["cam", "out"], ["src", "inputs"], 1),
      edge("e3", ["src", "out"], ["mask", "input"]),
      edge("e4", ["src", "out"], ["key", "in1"]),
      edge("e5", ["mask", "out"], ["key", "in2"]),
      edge("e6", ["haze", "out"], ["tint", "in1"]),
      edge("e6b", ["ink", "out"], ["tint", "in2"]),
      edge("e6c", ["tint", "out"], ["wash", "input"]),
      edge("e7", ["key", "out"], ["room", "in1"]),
      edge("e8", ["wash", "out"], ["room", "in2"]),
      edge("e9", ["room", "out"], ["out", "input"]),
    ],
  ),
);
