import { settings, node, edge, graph, document, drivenSlot } from "./builders.ts";

const NAVE_RIBS = 60;

const NAVE_ROUND = 176;

const NAVE_KERNEL = `const TAU: f32 = 6.28318530717958647692;

fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  /* The grid's two axes become the tunnel's two axes: x goes AROUND the bore, y indexes
     which rib you are on. Nothing else in the kernel knows it started life as a plane. */
  let around = (p.position.x * 0.5 + 0.5) * TAU;
  let rib = p.position.y * 0.5 + 0.5;

  /* ctx.absTime, and this is the whole reason it exists (T489, §V437). The tunnel's motion
     is a POSITION read off a clock — the one shape that snaps at a timeline lap if it reads
     the wrapping one. On the absolute clock the fract() below is continuous forever: the
     ribs keep coming, a lap does nothing, and an hour behind a set is an hour of tunnel.
     Deterministic too: absTime is SECONDS since transport start (the manifest's own
     contract - a reader who takes this for a frame count and retunes 0.052 to match
     reproduces the E35 frozen-clock fault, §V645/§V637), zeroed at render (T467). */
  let depth = fract(rib + ctx.absTime * 0.052);

  /* ctx.value1 is the bass (T479): a value write per frame, never a rebuild (§V5). The bore
     BREATHES on the kick — the whole tunnel widens and settles — which reads at the size a
     projection is watched from, where a colour change does not. */
  let flute = 0.19 * sin(around * 8.0 + ctx.absTime * 0.42);
  let radius = 1.05 + flute + ctx.value1 * 0.62;

  /* Depth 0 sits BEHIND the camera on purpose. A scrolling tunnel has to recycle its ribs
     somewhere, and the recycle is a teleport; putting it behind the eye means the pop
     happens where nobody is looking, instead of as a flash in the middle of the frame. */
  let z = 2.9 - depth * 34.0;
  q.position = vec3f(cos(around) * radius, sin(around) * radius, z);

  /* p.sample is the palette, read off the ramp by the bridge at this point's own grid
     position — so the COLOUR is a gradient in the graph, not a formula in this text. All
     the kernel does is fade it, which is the one thing the ramp cannot know.
     TWO FADES, and the near one is not optional. A quad has a fixed WORLD size, so a rib
     three units from the eye draws as a fistful of blocks; the first build looked like the
     tunnel was made of postage stamps. Fading a rib out as it passes the eye hides the
     recycle AND the blockiness in one term, and it is also just what depth of field and
     atmosphere do to a real corridor. */
  let far = smoothstep(1.0, 0.7, depth);
  let near = smoothstep(2.0, -2.4, z);
  q.sample = vec4f(p.sample.rgb * far * near * (0.7 + ctx.value2 * 1.1), 1.0);
  return q;
}`;

/**
 * E30 — Nave (T503). The audio-and-3D corner, which nothing in the set filled.
 *
 * You are inside a cathedral of light moving toward you: ninety-six fluted ribs of glowing
 * points, receding to a vanishing point, sliding past forever. On the kick the whole bore
 * OPENS — the tunnel widens by half a radius and settles over the beat — and the ribs
 * brighten with it. It is the shot every VJ set has and none of our examples had: E24 is
 * audio and 2D, E25 is 3D and silent, and this is the crossing.
 *
 * ## Everything in this file is a decision about which clock
 *
 * The rib motion is a POSITION read off a clock — `fract(rib + t · 0.052)` — which is
 * exactly the shape that breaks at a loop boundary. On `ctx.time` the whole tunnel would
 * jump back a third of a rib every lap, forever, in the one setting these examples are
 * for. It reads `ctx.absTime` instead (T489/B97), so the scroll is continuous across a lap
 * and an offline render still reproduces, because absolute time is frames-since-transport-
 * start and T467 zeroes it at render (§V44, §V45).
 *
 * Its neighbours own different clocks, and that is §V436 working rather than an
 * inconsistency: `sway1`/`rise1` are LFOs and free-running, so the camera drift also
 * survives a lap; `beat1` is the Audio Pattern and TIMELINE-ANCHORED by design, so bar one
 * lands on the in point and a scrub finds the same beat.
 *
 * ## Where the colour lives, and why it is not in the kernel
 *
 * The obvious way to colour four thousand points is six lines of cosine palette in WGSL,
 * and it would look the same. It is in a Ramp instead, read through `textureToAttribute` at
 * each point's own grid position, because a gradient you can drag stops around in is worth
 * more in a node tool than a gradient you have to recompile — and because the entire reason
 * this example exists is to be OPENED and messed with. The kernel only does the one thing
 * the ramp cannot: fade a rib by how far away it ended up.
 *
 * ## Unlit, and that is not laziness
 *
 * `materialUnlit` with a per-point tint (T478), no lights, and a wide bloom. Points ARE
 * the light here — a lambert response on four thousand tiny quads would just make them
 * grey where they face away, and the shot is a light source rather than a lit object.
 */
export const naveDocument = document(
  "e30-nave",
  "E30 Nave",
  settings({ outputResolution: { width: 1280, height: 720 }, randomSeed: 30 }),
  graph(
    [
      // ---- the sound ---------------------------------------------------------------
      node("beat", "audioPattern", [-1740, 700], { bpm: 120, amount: 1 }, { label: "beat1" }),
      node("swellEnv", "valueLag", [-1480, 700], { lag: 0.11 }, { label: "swell1" }),
      node("bgain", "valueMath", [-1740, 960], { operation: "multiply", operand: 1.8397 }, { label: "bgain1" }),
      /* T701: the dB-domain pattern rests at 0.712 where the linear one rested at 0.12,
         so the single multiply grew the house bias half — same output range as before,
         read off the new input range. */
      node("bnorm", "valueMath", [-1740, 1180], { operation: "add", operand: -1.2437 }, { label: "bnorm1" }),
      node("bcap", "valueLimit", [-1480, 960], { minimum: 0, maximum: 0.5 }, { label: "bore1" }),
      node("lgain", "valueMath", [-1220, 960], { operation: "multiply", operand: 0.8 }, { label: "lgain1" }),
      node("lcap", "valueLimit", [-960, 960], { minimum: 0.05, maximum: 0.85 }, { label: "lum1" }),

      // ---- the palette, as a gradient rather than as a formula -----------------------
      node("palette", "ramp", [-1740, 40], {
        type: "vertical", interp: "smooth", phase: 0, period: 1,
        /* Read along the RIB index, and since depth is `fract(rib + t)` that is the same
           thing as reading along DEPTH, rotating slowly. One pass of the gradient down the
           shaft, not several: `period: 4` was tried and is worse, because the ramp node
           compresses the gradient into the first quarter rather than tiling it, so the
           whole tunnel came out one blue. Deep indigo through a cold cyan to a hot coral,
           with a near-black notch at 0.86 — the notch is what gives the shaft visible
           SEGMENTS instead of one continuous wash. */
        stops: [
          { position: 0, color: [0.05, 0.03, 0.24, 1] },
          { position: 0.26, color: [0.08, 0.45, 0.85, 1] },
          { position: 0.5, color: [0.25, 0.95, 0.85, 1] },
          { position: 0.7, color: [1, 0.72, 0.3, 1] },
          { position: 0.86, color: [0.02, 0.01, 0.06, 1] },
          { position: 1, color: [0.55, 0.12, 0.7, 1] },
        ],
      }, { label: "palette1", definitionVersion: 2 }),

      // ---- the tunnel ----------------------------------------------------------------
      node("sheet", "pointGrid", [-1480, 340], {
        count: NAVE_RIBS * NAVE_ROUND, cols: NAVE_ROUND, rows: NAVE_RIBS,
      }, { label: "grid1" }),
      node("bridge", "textureToAttribute", [-1220, 160], {
        count: NAVE_RIBS * NAVE_ROUND,
      }, { label: "bridge1" }),
      node("roll", "pointKernel", [-960, 160], {
        capacity: NAVE_RIBS * NAVE_ROUND,
        seed: 30,
        attributes: JSON.stringify([
          { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
          { name: "sample", type: "vec4f", default: [0, 0, 0, 0] },
        ]),
        kernel: NAVE_KERNEL,
      }, {
        label: "roll1",
        parameters: {
          value1: drivenSlot("bore1:low", 0.16),
          value2: drivenSlot("lum1:level", 0.28),
        },
      }),

      node("glass", "materialUnlit", [-700, -140], { color: [1, 1, 1, 1] }, { label: "glass1" }),
      node("ribs", "geometry", [-700, 160], {
        mode: "instances", shape: "quad", scale: 0.0092, material: "glass1", tint: [1, 1, 1, 1],
      }, {
        label: "ribs1",
        parameters: { tint: { mode: "map", bindings: { static: { kind: "static", value: [1, 1, 1, 1] }, map: { kind: "map", attribute: "sample" } } } },
      }),

      // ---- the shot ------------------------------------------------------------------
      node("sway", "lfo", [-960, 440], { shape: "sine", frequency: 0.031, amplitude: 0.34, offset: 0, phase: 0 }, { label: "sway1" }),
      node("rise", "lfo", [-960, 700], { shape: "sine", frequency: 0.023, amplitude: 0.3, offset: 0, phase: 0.25 }, { label: "rise1" }),
      node("eye", "camera", [-440, 160], {
        /* Inside the bore, off the axis by a hair and drifting. Dead centre on the axis is
           a perfectly symmetric frame, and a perfectly symmetric frame has no parallax —
           the tunnel stops reading as a space and starts reading as a target. */
        eye: [0, 0, 2], lookAt: [0, 0, -12], fov: 50, near: 0.05, far: 120, ortho: false,
      }, {
        label: "eye1",
        parameters: {
          "eye.x": drivenSlot("sway1", 0),
          "eye.y": drivenSlot("rise1", 0),
        },
      }),
      node("shot", "render", [-180, 160], {
        scenes: "ribs1", camera: "eye1", lights: "",
        ambientColor: [1, 1, 1, 1], ambientIntensity: 0,
        background: [0.004, 0.005, 0.014, 1],
      }, { label: "shot1" }),

      node("halo", "blur", [80, 420], { size: 20, filter: "gaussian", extend: "hold" }, { label: "halo1" }),
      node("haze", "level", [340, 420], {
        blacklevel: 0, whitelevel: 1, contrast: 1, brightness: 0.7, gamma1: 1, opacity: 1,
      }, { label: "haze1" }),
      node("burn", "add", [600, 160], {}, { label: "burn1" }),
      node("out", "output", [860, 160], {}, { label: "out1" }),
    ],
    [
      edge("e-beat-swell", ["beat", "out"], ["swellEnv", "in"]),
      edge("e-swell-bgain", ["swellEnv", "out"], ["bgain", "a"]),
      edge("e-bgain-bnorm", ["bgain", "out"], ["bnorm", "a"]),
      edge("e-bnorm-bcap", ["bnorm", "out"], ["bcap", "in"]),
      edge("e-swell-lgain", ["swellEnv", "out"], ["lgain", "a"]),
      edge("e-lgain-lcap", ["lgain", "out"], ["lcap", "in"]),

      edge("e-grid-bridge", ["sheet", "out"], ["bridge", "points"]),
      edge("e-palette-bridge", ["palette", "out"], ["bridge", "texture"]),
      edge("e-bridge-roll", ["bridge", "out"], ["roll", "in"]),
      edge("e-roll-ribs", ["roll", "out"], ["ribs", "points"]),

      edge("e-shot-halo", ["shot", "out"], ["halo", "input"]),
      edge("e-halo-haze", ["halo", "out"], ["haze", "input"]),
      edge("e-shot-burn", ["shot", "out"], ["burn", "in1"]),
      edge("e-haze-burn", ["haze", "out"], ["burn", "in2"]),
      edge("e-burn-out", ["burn", "out"], ["out", "input"]),
    ],
  ),
);
