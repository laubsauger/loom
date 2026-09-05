import { settings, node, edge, graph, document, drivenSlot } from "./builders.ts";

/**
 * E64 — Relay (T1193). THE LOOP, CLOSED THROUGH A UDP SOCKET.
 *
 *   sweep1(lfo) ─► beam1.center.x
 *   beam1(circle) ─┬─► field1(add) ◄─ bed1(noise) ─► bedclip1(limit), gate1(rectangle), wash1(ramp)
 *                  │        │
 *                  │        ▼
 *                  │   dim1(level ┄ ctl1:level)  ─┬─► win1(crop) ─► meter1(analyze)   the SENSOR
 *                  │                              └─► plate1(over)                    the PICTURE
 *   probe1(channelIn "meter1") ─► wire1(valueMath range) ─► send1(oscOut → 127.0.0.1:9107 /loom/relay)
 *                                                                       │
 *                                                            ~~ UDP, out of the page ~~
 *                                                                       │
 *   hear1(oscIn ◄ 127.0.0.1:9107 /loom/relay) ─┬─► ctl1(valueMath range) = dim1.brightness   the ACTUATOR
 *                                              └─► penB1 ─► penb1(circle)
 *   wire1 ─► penA1 ─► pena1(circle)
 *   pena1+penb1 ─► ink1(over) ─► tape1(over) ◄─ roll1(transform) ◄─ hist1(feedback "tape1")   the CHART
 *   tape1 ─► plate1 ◄─ panel1(rectangle), dim1
 *
 * ## Why this file exists
 *
 * `oscIn` and `oscOut` shipped with a README section each and appeared in **zero**
 * examples — T728's failure mode in its purest form, and the whole device surface
 * (T1103, T1111) had no catalogue presence at all. The owner asked for "OSC in / OSC out,
 * ideally both in one so that we can demonstrate our capabilities… and maybe the pass
 * through". This is both, in one document, and the pass-through is the subject.
 *
 * ## THE CLOSED CIRCUIT IS WHAT MAKES IT RUNNABLE BY ANYBODY
 *
 * `oscOut` transmits to `127.0.0.1:9107` and `oscIn` listens on `127.0.0.1:9107`. One
 * helper process owns both sockets — the ingress socket binds `BRIDGE_HOST` and the
 * egress socket is the one `dgram` gives an ephemeral port — so the datagram leaves this
 * machine's UDP stack and comes back into it. **No second machine, no phone, no desk.**
 * An OSC example that needs a TouchOSC layout on somebody's iPad is an example nobody
 * runs.
 *
 * ## A BARE ROUND TRIP PROVES NOTHING, SO THIS ONE TRANSFORMS
 *
 * If the graph sent a number and read the same number back, the picture would be a
 * tautology: the value that returns is the value you sent. So what goes out is a
 * measurement of the picture ITSELF — `meter1` reduces the metered window to the
 * brightest luminance in it — and what comes back DRIVES that picture's brightness, in the
 * corrective direction. E14 Self-Regulating Bloom closes exactly this loop inside the process, with
 * `channelIn` feeding a proportional controller. This file is that same loop with the
 * wire replaced by a UDP socket, and the extra latency is the whole demonstration.
 *
 * Loop sign is NEGATIVE and the gain is deliberately small: brighter window → higher
 * reading → lower `dim1.brightness` → dimmer window. `ctl1`'s range runs 1.24 down to
 * 0.86 across the full 0…1 of the returned control, and both remaps CLAMP, so a value
 * arriving from anywhere — this graph, or a fader somebody else points at port 9107 —
 * cannot drive the picture out of its rails.
 *
 * ## THE TRANSFORM IS ALSO A LESSON ABOUT UNITS
 *
 * `wire1` normalises the raw reading (a peak luminance inside the window, which lives
 * between 0.075 and 0.42) onto 0…1 BEFORE the send, and `ctl1` denormalises AFTER the
 * receive. That is deliberate and is not symmetry for its own sake: what goes on the wire
 * should be in the units the far end expects, because the far end might not be you. Point
 * `send1` at a lighting desk and 0…1 is what a fader wants; point something else at 9107
 * and 0…1 is what this document promises to accept.
 *
 * ## THE CHART IS THE LATENCY, DRAWN
 *
 * `pena1` (amber, small) plots what was SENT this frame; `penb1` (cyan, wider) plots what
 * has come BACK. Both draw at x = 0.94 and the whole strip scrolls left, so x is time and
 * a feature that appears in cyan some frames after it appeared in amber is **displaced to
 * the right by exactly the round trip**. That displacement is the measurement this file
 * exists to make visible, and it is not a number anybody has to be told.
 *
 * `roll1` translates by EXACTLY eight texels (8/1280 = 0.00625) with `aspectcorrect` off.
 * A fractional shift resampled a couple of hundred times turns a trace into fog; an exact texel
 * shift is a bilinear identity, so the history stays a line.
 *
 * ## WHAT IT LOOKS LIKE WITH NO HELPER, WHICH IS THE ORDINARY CASE
 *
 * This is the first example in the catalogue that cannot fully render standalone: a page
 * cannot open a UDP socket, so the round trip needs the local helper running and paired.
 * That state is designed for rather than apologised for.
 *
 *  - `oscIn` ALWAYS publishes: an unheard address falls to its declared Rest, so
 *    `hear1:level` reads 0.42 and `dim1` sits at a fixed, well-exposed brightness. The
 *    picture is a picture.
 *  - The cyan trace goes **dead flat** while the amber one keeps moving. One live trace
 *    and one straight line is a legible statement that nothing is coming back — it is not
 *    a dead frame and it is not a lie that looks like it is working.
 *  - The reason reaches a surface without this document drawing any text: `use-osc-bridge`
 *    raises an `osc.helper` diagnostic against both nodes naming the helper and the
 *    command, sourced from `devices/helper.ts` (T1110), and the problems pane renders it.
 *
 * ## THE DESTINATION IS IN THE DOCUMENT, AND THAT IS NOT AN OVERSIGHT
 *
 * `oscOut` ships with an empty Host and a zero Port — there is NO default destination, by
 * design (T950 gap 4): Art-Net's default is a broadcast address and copying that habit is
 * a decision this build refuses to make for anybody. So a fresh `oscOut` transmits
 * nothing, and a document that wants to transmit has to SAY WHERE. This one says
 * `127.0.0.1`, which is the only destination a shipped example is entitled to name: it is
 * this machine, it is the machine the helper is already bound to, and opening the file
 * cannot put a datagram on anybody's studio network.
 *
 * ## Motion is not on the loop
 *
 * `sweep1` is a free-running LFO and `bed1` is a moving 4D noise, so the picture animates
 * whether or not a helper is anywhere. That is a requirement rather than a nicety: the
 * headless gates render this file with no device attached at all, and an example whose
 * only motion came from the round trip would read as a still to every one of them — and,
 * worse, would look broken to anybody who opened it before starting the helper.
 */

/**
 * The metered window, in uv. `gate1` paints it and `win1` crops to it, from the SAME four
 * numbers — a sensor you cannot see is a sensor nobody believes, and two hand-typed copies
 * of a rectangle drift the moment one of them is nudged.
 */
const GATE = { left: 0.33, right: 0.67, bottom: 0.34, top: 0.86 } as const;
/**
 * The same window as a generator sees it, DERIVED rather than typed a second time.
 *
 * Two conventions meet here and the file would ship crooked if either were assumed:
 * `crop` measures v from the BOTTOM, and `circle`/`rectangle` measure their centre from
 * the TOP, so the marker's y is `1 − v`. And `rectangle`'s `size` is a HALF-extent about
 * its centre, not a width. Both facts were learned by rendering the crop on its own and
 * looking at where it landed, which is the only way to learn them.
 */
const GATE_CENTER: readonly [number, number] = [
  (GATE.left + GATE.right) / 2,
  1 - (GATE.bottom + GATE.top) / 2,
];
const GATE_SIZE: readonly [number, number] = [
  (GATE.right - GATE.left) / 2,
  (GATE.top - GATE.bottom) / 2,
];

/**
 * The reading's working span, MEASURED rather than guessed (the md carries the table).
 *
 * `meter1` reports the MAXIMUM rather than the average, and that is the one measurement
 * decision in the file worth arguing. `crop` blanks everything outside the window and
 * `analyze` reduces the WHOLE frame, so an average is the window's own mean scaled by the
 * window's area — here about 0.003 to 0.013, a band three decades below the 0…1 anything
 * downstream expects. The maximum is the brightest thing the sensor can see, is not
 * diluted by the blanked region at all, and lands in 0.075…0.42: a number a person can read
 * and a receiver can use. `wire1` still normalises it, because 0.06…0.60 is not 0…1.
 */
const READING_LOW = 0.075;
const READING_HIGH = 0.42;

/** Where the chart's pens live, and the band they swing through. */
const PEN_X = 0.94;
/** y measured from the TOP, so LOW is the bottom of the frame — a rising value rises. */
const PEN_LOW = 0.925;
const PEN_HIGH = 0.745;

/** The one destination, written once so the two halves of the circuit cannot disagree. */
const LOOPBACK_HOST = "127.0.0.1";
const LOOPBACK_PORT = 9107;
const RELAY_ADDRESS = "/loom/relay";

/**
 * What `hear1` publishes when nothing is arriving, and what `dim1` retains.
 *
 * 0.42 rather than 0 or 1 on purpose: it is inside the range the live loop settles
 * through, so the no-helper picture is the same picture at a fixed exposure rather than a
 * different example (§V108's rule — a retained value has to be a sane picture on its own).
 *
 * It is the same NUMBER as `READING_HIGH` and that is a coincidence, not a relationship:
 * one is a control value in 0…1 and the other is a luminance. Nothing reads one as the
 * other, and changing either leaves the other alone.
 */
const RELAY_REST = 0.42;

export const relayDocument = document(
  "e64-relay",
  "E64 Relay",
  settings({ randomSeed: 64 }),
  graph(
    [
      // ---- the subject: something worth measuring, moving on its own ----------------
      /* The ground colour. A ramp rather than a flat fill so the frame has somewhere to
         go dark, which is what lets the beam read as light rather than as paint. */
      node(
        "wash",
        "ramp",
        [-2400, -640],
        {
          type: "vertical",
          interp: "smooth",
          period: 1,
          stops: [
            { position: 0, color: [0.03, 0.05, 0.11, 1] },
            { position: 0.55, color: [0.05, 0.08, 0.16, 1] },
            { position: 1, color: [0.02, 0.03, 0.07, 1] },
          ],
        },
        { definitionVersion: 2, label: "wash1" },
      ),
      /* Texture, and the second free-running clock. Dim: the bed is what the beam is seen
         against, so it must not be a second light. */
      node(
        "bed",
        "noise",
        [-2400, -340],
        {
          type: "perlin4d",
          seed: 64,
          period: 0.19,
          harmon: 3,
          spread: 2,
          gain: 0.5,
          rough: 0.5,
          exp: 2.2,
          amp: 1,
          offset: -0.5,
          mono: true,
          aspectcorrect: true,
          speed: 0.07,
          // T535/T786: off the 4D lattice plane, where frame 0 is unrepresentative.
          t4d: 0.37,
          s4d: 1,
        },
        { label: "bed1" },
      ),
      /* THE SENSOR, PAINTED. A faint cool wash exactly where `win1` crops, so a viewer can
         see what the number is a number OF. It is added BEFORE `dim1`, so the controller
         scales it along with everything else it measures — a marker outside the loop would
         be a constant the loop could not see and the reader would have to be told about. */
      node(
        "gate",
        "rectangle",
        [-2400, -40],
        {
          mode: "fill",
          center: [...GATE_CENTER],
          size: [...GATE_SIZE],
          roundness: 0,
          softness: 0.02,
          fillcolor: [0.05, 0.09, 0.13, 1],
          bgcolor: [0, 0, 0, 0],
          // FALSE deliberately: `crop` works in plain uv, and an aspect-corrected
          // rectangle would paint a window that is not the window being measured.
          aspectcorrect: false,
        },
        { label: "gate1" },
      ),
      node(
        "sweep",
        "lfo",
        [-2400, 260],
        // 0.33 Hz — 182 frames a cycle against 160 frames of visible chart, so the strip
        // always carries most of a crossing and the lag has a feature to be measured against.
        { shape: "sine", frequency: 0.33, amplitude: 0.42, offset: 0.5, phase: 0 },
        { label: "sweep1" },
      ),
      node(
        "beam",
        "circle",
        [-2100, -340],
        {
          mode: "fill",
          center: [0.5, 1 - 0.6],
          radius: [0.045, 0.045],
          softness: 0.26,
          fillcolor: [1, 0.72, 0.34, 1],
          bgcolor: [0, 0, 0, 0],
          aspectcorrect: true,
        },
        { label: "beam1", parameters: { "center.x": drivenSlot("sweep1", 0.5) } },
      ),
      /* E14's `clipbase` idiom, and load-bearing for the same reason: the bed's `offset` is
         negative — that is how a noise centred on 0.5 becomes a dark ground with no extra
         Level in the chain — and a negative in an rgba16float working format would SUBTRACT
         from the wash and the marker it is composited with. Clamped at the source, so
         everything downstream is adding light to light. */
      node("bedclip", "limit", [-2100, -40], { mode: "clamp", low: 0, high: 4, steps: 4 }, { label: "bedclip1" }),
      node("field", "add", [-1800, -340], { opacity: 1 }, { label: "field1" }),

      // ---- the actuator: the one number the returned value owns --------------------
      /**
       * THE ACTUATOR, and the only thing in the picture the loop controls.
       *
       * `brightness` is driven by `ctl1:level` — the channel name carries `:level` because
       * `hear1` declares a control called `level` and every value node downstream maps the
       * bag per channel, so the name rides all the way through the arithmetic.
       *
       * The retained value is `ctl1`'s own output at the Rest reading, so a host with no
       * value graph at all renders the same exposure the no-helper session does.
       */
      node(
        "dim",
        "level",
        [-1500, -340],
        { blacklevel: 0, whitelevel: 1, gamma1: 1, contrast: 1, invert: 0, opacity: 1 },
        { label: "dim1", parameters: { brightness: drivenSlot("ctl1:level", 1.0804) } },
      ),

      // ---- the sensor --------------------------------------------------------------
      node(
        "win",
        "crop",
        [-1200, -640],
        { left: GATE.left, right: GATE.right, bottom: GATE.bottom, top: GATE.top },
        { label: "win1" },
      ),
      /* Its NAME is the channel (§V129), and the reading is one frame late by design
         (§V144) — which is the first of the three delays the chart adds up. */
      node(
        "meter",
        "analyze",
        [-900, -640],
        { channel: "luminance", operation: "maximum" },
        { label: "meter1" },
      ),

      // ---- out of the page ---------------------------------------------------------
      /* T654's crossing: `analyze` publishes a CHANNEL, not a port, so nothing could wire
         from it until `channelIn` existed. The fallback is the middle of the working span,
         so frame 0 — before any readback has completed — sends a sane number rather than
         a zero. */
      node(
        "probe",
        "channelIn",
        [-900, -40],
        { channel: "meter1", fallback: READING_LOW + (READING_HIGH - READING_LOW) * 0.25 },
        { label: "probe1" },
      ),
      node(
        "wire",
        "valueMath",
        [-600, -40],
        {
          operation: "range",
          fromLow: READING_LOW,
          fromHigh: READING_HIGH,
          toLow: 0,
          toHigh: 1,
          outside: "clamp",
        },
        { label: "wire1" },
      ),
      /**
       * THE EGRESS HALF. Host and Port are set because `oscOut` has no default destination
       * and never will — see the module note.
       *
       * `rate` is 60 rather than the default 30: the subject of this file is LATENCY, and
       * a 30 Hz cap adds up to half a frame of it that has nothing to do with the network.
       * A real rig sending to a desk across a room should leave it at 30.
       *
       * The bag arriving here has one channel called `value` (`channelIn` publishes that
       * name), so it sends the bare address `/loom/relay` — the single-control form a
       * receiver expects — rather than `/loom/relay/value`.
       */
      node(
        "send",
        "oscOut",
        [-300, -40],
        { host: LOOPBACK_HOST, port: LOOPBACK_PORT, address: RELAY_ADDRESS, rate: 60 },
        { label: "send1" },
      ),

      // ---- back into the page ------------------------------------------------------
      /**
       * THE INGRESS HALF. The port is document state with no default (a default port would
       * mean a document that opens a listening socket because it was opened), and the
       * `controls` declaration GROWS this node's own schema: naming `level` here is what
       * creates the `levelAddress` and `levelRest` parameters below.
       *
       * The address it learns is the address `send1` writes. The two halves of the circuit
       * meet here and nowhere else.
       */
      node(
        "hear",
        "oscIn",
        [0, -40],
        {
          port: LOOPBACK_PORT,
          controls: "level",
          levelAddress: RELAY_ADDRESS,
          levelRest: RELAY_REST,
        },
        { label: "hear1" },
      ),
      /* The denormalise, and the loop's sign. INVERTED bounds — 0 maps to the bright end
         and 1 to the dim end — which is the whole of what makes this negative feedback
         rather than a runaway. `clamp` on the position, so a value from outside 0…1 pins
         to a rail instead of extrapolating the picture to black or to white. */
      node(
        "ctl",
        "valueMath",
        [300, -40],
        {
          operation: "range",
          fromLow: 0,
          fromHigh: 1,
          toLow: 1.24,
          toHigh: 0.86,
          outside: "clamp",
        },
        { label: "ctl1" },
      ),

      // ---- the chart: two pens, one strip -------------------------------------------
      node(
        "penA",
        "valueMath",
        [-300, 300],
        {
          operation: "range",
          fromLow: 0,
          fromHigh: 1,
          toLow: PEN_LOW,
          toHigh: PEN_HIGH,
          outside: "clamp",
        },
        { label: "penA1" },
      ),
      node(
        "penB",
        "valueMath",
        [300, 300],
        {
          operation: "range",
          fromLow: 0,
          fromHigh: 1,
          toLow: PEN_LOW,
          toHigh: PEN_HIGH,
          outside: "clamp",
        },
        { label: "penB1" },
      ),
      /* RECEIVED, drawn wide and cool. Behind the sent pen deliberately: when the two
         agree the amber sits inside the cyan, and when they do not the amber rides out of
         it — which is the reading this chart exists for. */
      node(
        "penb",
        "circle",
        [600, 300],
        {
          mode: "fill",
          center: [PEN_X, (PEN_LOW + PEN_HIGH) / 2],
          radius: [0.013, 0.016],
          softness: 0.028,
          fillcolor: [0.18, 0.72, 0.86, 1],
          bgcolor: [0, 0, 0, 0],
          /* FALSE for both pens: the dot has to be at least as wide as one frame's scroll
             or the trace draws as beads instead of a line, and an aspect-corrected radius
             is NARROWER in x at 16:9, which is the wrong way round. */
          aspectcorrect: false,
        },
        { label: "penb1", parameters: { "center.y": drivenSlot("penB1:level", 0.15) } },
      ),
      /* SENT, drawn small and hot. */
      node(
        "pena",
        "circle",
        [600, 620],
        {
          mode: "fill",
          center: [PEN_X, (PEN_LOW + PEN_HIGH) / 2],
          radius: [0.008, 0.011],
          softness: 0.024,
          fillcolor: [1, 0.78, 0.3, 1],
          bgcolor: [0, 0, 0, 0],
          aspectcorrect: false,
        },
        { label: "pena1", parameters: { "center.y": drivenSlot("penA1", 0.15) } },
      ),
      node("ink", "over", [900, 460], { opacity: 1 }, { label: "ink1" }),
      /* THE STRIP. `tape1` is this frame's ink over the scrolled history; `hist1` records
         `tape1` by NAME (T350 — the loop is a reference, not a back-edge) and `roll1`
         shifts what came back. Persistence 1: the fade here is the LEFT EDGE, not a decay,
         so the whole visible history is equally legible. */
      node("tape", "over", [1200, 460], { opacity: 1 }, { label: "tape1" }),
      node(
        "hist",
        "feedback",
        [1200, 800],
        { source: "tape1", persistence: 1, clearColor: [0, 0, 0, 0], reset: false, substeps: 1 },
        { label: "hist1" },
      ),
      /* Exactly four texels of a 1280-wide frame. See the module note on why the number is
         a texel count and not a taste. `zero` so the right-hand edge stays empty rather
         than smearing the newest sample across the width the scroll vacates. */
      node(
        "roll",
        "transform",
        [900, 800],
        {
          t: [-8 / 1280, 0],
          r: 0,
          s: [1, 1],
          p: [0, 0],
          extend: "zero",
          aspectcorrect: false,
        },
        { label: "roll1" },
      ),

      // ---- the frame ----------------------------------------------------------------
      /* The instrument panel. The chart is drawn over a moving picture, and a trace you
         have to hunt for is a trace nobody reads — this is the only node in the file whose
         job is legibility. Semi-opaque rather than solid, so the picture still runs under
         it and the frame stays one frame rather than two. */
      node(
        "panel",
        "rectangle",
        [1200, -40],
        {
          mode: "fill",
          center: [0.5, (PEN_LOW + PEN_HIGH) / 2],
          size: [0.5, (PEN_LOW - PEN_HIGH) / 2 + 0.045],
          roundness: 0,
          softness: 0.004,
          fillcolor: [0.012, 0.016, 0.028, 0.78],
          bgcolor: [0, 0, 0, 0],
          aspectcorrect: false,
        },
        { label: "panel1" },
      ),
      node("plate", "over", [1500, -340], { opacity: 1 }, { label: "plate1" }),
      node("out", "output", [1800, -340], {}, { label: "out1" }),
    ],
    [
      edge("e-beam-field", ["beam", "out"], ["field", "in1"]),
      edge("e-bed-bedclip", ["bed", "out"], ["bedclip", "input"]),
      edge("e-bedclip-field", ["bedclip", "out"], ["field", "in2"], 0),
      edge("e-gate-field", ["gate", "out"], ["field", "in2"], 1),
      edge("e-wash-field", ["wash", "out"], ["field", "in2"], 2),
      edge("e-field-dim", ["field", "out"], ["dim", "input"]),
      // Cut this and the sensor goes blind: `meter1` stops publishing, `probe1` falls to
      // its fallback, and the same number leaves and returns for ever.
      edge("e-dim-win", ["dim", "out"], ["win", "input"]),
      edge("e-win-meter", ["win", "out"], ["meter", "input"]),

      // the value circuit
      edge("v-probe-wire", ["probe", "out"], ["wire", "a"]),
      edge("v-wire-send", ["wire", "out"], ["send", "in"]),
      edge("v-wire-penA", ["wire", "out"], ["penA", "a"]),
      edge("v-hear-ctl", ["hear", "out"], ["ctl", "a"]),
      edge("v-hear-penB", ["hear", "out"], ["penB", "a"]),

      // the chart
      edge("e-pena-ink", ["pena", "out"], ["ink", "in1"]),
      edge("e-penb-ink", ["penb", "out"], ["ink", "in2"], 0),
      edge("e-ink-tape", ["ink", "out"], ["tape", "in1"]),
      edge("e-roll-tape", ["roll", "out"], ["tape", "in2"], 0),
      edge("e-hist-roll", ["hist", "out"], ["roll", "input"]),

      edge("e-tape-plate", ["tape", "out"], ["plate", "in1"]),
      edge("e-panel-plate", ["panel", "out"], ["plate", "in2"], 0),
      edge("e-dim-plate", ["dim", "out"], ["plate", "in2"], 1),
      edge("e-plate-out", ["plate", "out"], ["out", "input"]),
    ],
  ),
);
