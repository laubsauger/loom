import { settings, node, edge, graph, document, drivenSlot } from "./builders.ts";

/**
 * E14 — Self-Regulating Bloom (T408).
 *
 *   sway(lfo) ─► field.amp                                      the DISTURBANCE
 *   field(noise) ─► gain(level) ─► clipbase ─┬─► cut ─► clip ─► halo ─► tint ─► glow.in1
 *                       ▲ brightness         └──────────────────────────────► glow.in2
 *   glow ─► out                palette ─► tint.lookup (phase ← "swirl1")
 *   glow ─► meter(analyze "meter1")                             the SENSOR
 *   probe(channelIn) ─► neg(×−1) ─► err(+target) ─► push(×K) ─► lift(+base) ─► clampg ─► engage(valueSwitch) = "gain1"   (in2 ◄ rest, the open loop)
 *                                       └─► swirl(×0.15) ─► swirlbias(+0.03) ─► swirlclamp = "swirl1"
 *
 * §V144's image → parameter → image loop, closed THROUGH PROCESSING for the first time
 * (§V615): analyze meters the finished frame, channelIn (T654) brings the number back
 * into the value graph, and a proportional controller drives the picture's brightness
 * toward a setpoint while an LFO breathes the field's amplitude to give it work to do.
 *
 * gain1 = clamp(1.3 + 2.0·(0.18 − meter1), 0.8, 1.8). Every constant is sized from a
 * measured plant curve, not taste — the md carries the numbers. The short version:
 * meter/brightness slope ≈ 0.23 at the operating point, so the brightness path closes
 * at K·G ≈ 0.47; the palette-phase tap adds ≈ 0.27 in the same corrective direction;
 * total loop gain ≈ 0.7 with the measurement one frame late (§V144), which is an
 * alternating decay with ratio 0.7 — the visible ringing on open IS the loop gain,
 * and `push` past ~4 crosses −1 into genuine oscillation. It settles near 0.206, not
 * 0.18: a P-controller leans on its error, and the residual ships undisguised.
 */
export const selfRegulatingBloomDocument = document(
  "self-regulating-bloom",
  "E14 Self-Regulating Bloom",
  settings(),
  graph(
    [
      /**
       * THE DISTURBANCE. ±0.35 of field amplitude over a 77-second cycle — enough to
       * swing the meter 0.172 peak-to-peak open-loop (measured with the sway sped up so
       * a run covers whole cycles); closed, the same swing measures 0.114 — attenuation
       * by 1/(1+L), not elimination. The clamp does NOT saturate under this sway
       * (measured at the trough: gain ≈1.28, well inside the rails) — its real job is
       * bounding the pulse when `push` is turned past the stability boundary.
       */
      node("sway", "lfo", [-1040, -200], {
        shape: "sine",
        frequency: 0.013,
        amplitude: 0.35,
        offset: 1,
        phase: 0,
      }),
      node("field", "noise", [-1040, 0], {
        type: "perlin4d",
        seed: 5,
        period: 0.26,
        harmon: 3,
        spread: 2,
        gain: 0.5,
        rough: 0.5,
        exp: 1,
        offset: 0,
        mono: true,
        aspectcorrect: true,
        t4d: 0.37, // T535: off the 4D lattice plane, where frame 0 is unrepresentative
        s4d: 1,
        speed: 0.12,
      }, {
        parameters: { amp: drivenSlot("sway1", 1) },
      }),
      /**
       * THE ACTUATOR. The controller owns exactly one number in the picture: this
       * brightness. The window under it (0.42/1.05) is what puts the field's mean at a
       * plant slope the controller can work — without the window the slope tripled and
       * the same K sat on the edge of oscillation.
       */
      node("gain", "level", [-780, 0], {
        blacklevel: 0.42,
        whitelevel: 1.05,
        contrast: 1,
      }, {
        // §V107/§V108: the retained 1.3 is `lift`'s own base, so a host with no
        // channel renders the frame-0 picture, not a different example.
        parameters: { brightness: drivenSlot("gain1", 1.3) },
      }),
      // E4/E34's lesson, twice: `gain` and `cut` are signed pipelines whose black
      // points emit negatives into an rgba16float working format; the blur would smear
      // them and `add` would SUBTRACT the halo. Both clamps are load-bearing.
      node("clipbase", "limit", [-540, 0], { mode: "clamp", low: 0, high: 4, steps: 4 }),
      node("cut", "level", [-300, -160], { blacklevel: 0.46, whitelevel: 0.56, contrast: 1 }),
      node("clip", "limit", [-60, -160], { mode: "clamp", low: 0, high: 4, steps: 4 }),
      node("halo", "blur", [180, -160], { size: 40, filter: "gaussian", extend: "hold" }),
      /**
       * THE WRAP IS THE TRAP. A ramp is periodic: a NEGATIVE phase wraps the mask's
       * near-zero majority — the whole background — past 0 into the white top end.
       * Measured: phase −0.02 alone lifted the settled meter from 0.51 to 0.94, a
       * POSITIVE feedback loop through an art decision that saturated early builds to a
       * white frame in five frames. `swirlbias` and `swirlclamp`'s floor keep the phase
       * on the safe side; positive phase shifts the halo's palette gently and in the
       * CORRECTIVE direction, which is why the tap gets to exist.
       */
      node(
        "palette",
        "ramp",
        [180, 60],
        {
          type: "horizontal",
          interp: "smooth",
          period: 1,
          stops: [
            { position: 0, color: [0, 0, 0, 1] },
            { position: 0.03, color: [0.24, 0.05, 0.4, 1] },
            { position: 0.09, color: [0.85, 0.2, 0.3, 1] },
            { position: 0.16, color: [1, 0.55, 0.16, 1] },
            { position: 0.28, color: [1, 0.9, 0.6, 1] },
            { position: 0.45, color: [1, 1, 0.95, 1] },
          ],
        },
        { definitionVersion: 2, parameters: { phase: drivenSlot("swirl1", 0.03) } },
      ),
      node("tint", "lookup", [420, -160], { channel: "luminance", row: 0.5, offset: 0, scale: 1 }),
      node("glow", "add", [660, 0], { opacity: 1 }),
      /**
       * THE SENSOR — and deliberately on the FINISHED frame, glow and palette included,
       * not on the raw field. Metering the input would regulate something the viewer
       * never sees; metering the output is what makes the palette tap part of the loop
       * gain and the whole argument honest. Its NAME is the channel (§V129).
       */
      node("meter", "analyze", [1180, -160], { channel: "luminance", operation: "average" }, { label: "meter1" }),
      node("out", "output", [920, 0]),

      /**
       * THE CONTROLLER. channelIn (T654) is the crossing that §V615 records: before it,
       * a measured channel could drive a slot but could not be SUBTRACTED from a target.
       * The fallback is the setpoint itself, so frame 0 — before any readback has
       * completed (§V144: the resolver answers with the last COMPLETED reduction, and on
       * frame 0 there is none) — renders at exactly `lift`'s base. The opening ring you
       * see is the one-frame latency taking hold, displayed rather than hidden; pause
       * the transport and the analyze node's §V329 staleness age counts up in its popup
       * while the picture stands still.
       */
      node("probe", "channelIn", [-1140, 320], { channel: "meter1", fallback: 0.18 }),
      node("neg", "valueMath", [-880, 320], { operation: "multiply", operand: -1 }),
      node("err", "valueMath", [-620, 320], { operation: "add", operand: 0.18 }, { label: "err1" }),
      node("push", "valueMath", [-360, 320], { operation: "multiply", operand: 2 }),
      node("lift", "valueMath", [-100, 320], { operation: "add", operand: 1.3 }),
      // The rails. Not exercised by the sway (measured); load-bearing at the
      // STABILITY BOUNDARY: past `push` ≈ 4 the loop pulses, and these bounds are
      // what keep the pulse between 0.11 and 0.41 instead of black-to-blown
      // (0.004–0.67 with the rails opened). Gated at that case, per §V461.
      node("clampg", "valueLimit", [160, 320], { minimum: 0.8, maximum: 1.8 }),
      /**
       * THE A/B SWITCH (§V461 for the reader, not only for the gates). index 0 is the
       * closed loop; flip it to 1 and the brightness is the bare base — the open loop,
       * one integer away. Under the same sway the meter swings 0.172 open against
       * 0.114 closed (measured): the difference IS the controller, and this switch is
       * how you see it without running anything offline. The constant is pinned equal
       * to `lift`'s base so the comparison changes exactly one thing: whether the
       * measurement is allowed to push back.
       */
      node("rest", "constant", [420, 560], { value: 1.3 }),
      node("engage", "valueSwitch", [420, 320], { index: 0 }, { label: "gain1" }),
      // The same error, spent twice: a small warm/cool lean on the halo's palette.
      node("swirl", "valueMath", [-360, 560], { operation: "multiply", operand: 0.15 }),
      node("swirlbias", "valueMath", [-100, 560], { operation: "add", operand: 0.03 }),
      node("swirlclamp", "valueLimit", [160, 560], { minimum: 0.005, maximum: 0.055 }, { label: "swirl1" }),
    ],
    [
      edge("e-field-gain", ["field", "out"], ["gain", "input"]),
      edge("e-gain-clipbase", ["gain", "out"], ["clipbase", "input"]),
      edge("e-clipbase-cut", ["clipbase", "out"], ["cut", "input"]),
      edge("e-cut-clip", ["cut", "out"], ["clip", "input"]),
      edge("e-clip-halo", ["clip", "out"], ["halo", "input"]),
      edge("e-halo-tint", ["halo", "out"], ["tint", "source"]),
      edge("e-palette-tint", ["palette", "out"], ["tint", "lookup"]),
      edge("e-tint-glow", ["tint", "out"], ["glow", "in1"], 0),
      edge("e-clipbase-glow", ["clipbase", "out"], ["glow", "in2"], 1),
      edge("e-glow-out", ["glow", "out"], ["out", "input"]),
      // Cut THIS edge and the loop opens: the channel vanishes, `probe` falls back to
      // the setpoint, the error reads zero, and the sway swings the picture unregulated.
      edge("e-glow-meter", ["glow", "out"], ["meter", "input"]),
      edge("v-probe-neg", ["probe", "out"], ["neg", "a"]),
      edge("v-neg-err", ["neg", "out"], ["err", "a"]),
      edge("v-err-push", ["err", "out"], ["push", "a"]),
      edge("v-push-lift", ["push", "out"], ["lift", "a"]),
      edge("v-lift-clampg", ["lift", "out"], ["clampg", "in"]),
      edge("v-clampg-engage", ["clampg", "out"], ["engage", "in1"], 0),
      edge("v-rest-engage", ["rest", "out"], ["engage", "in2"], 1),
      edge("v-err-swirl", ["err", "out"], ["swirl", "a"]),
      edge("v-swirl-swirlbias", ["swirl", "out"], ["swirlbias", "a"]),
      edge("v-swirlbias-swirlclamp", ["swirlbias", "out"], ["swirlclamp", "in"]),
    ],
  ),
);
