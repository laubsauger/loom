import { settings, node, edge, graph, document, drivenSlot } from "./builders.ts";
import { SHADER_SOURCE_PARAMETER } from "../../domain/commands/apply-patch.ts";
import { FLUID_VELOCITY_WGSL } from "../shaders/fluid-velocity.wgsl.ts";

/**
 * E12 — Fluid (T362).
 *
 *   vel1(feedback) ─► stir1(customWgsl) ─► advect1.disp        the VELOCITY loop
 *        ╰┄┄┄┄┄┄┄┄ source: "stir1" ┄┄┄┄┄┄┄┄┄┄╯               (a reference, T350)
 *   dye1(feedback) ─► advect1(displace) ─► diffuse1(blur) ─► inject1.in2
 *   ink1(circle, centre ← mouse1) ─────────────────────────► inject1.in1
 *   inject1(over) ─► out1(output)                             the DYE loop
 *        ╰┄┄┄┄┄┄┄┄ dye1.source: "inject1" ┄┄╯
 *
 * E2 is already a reaction-diffusion, and the difference is the whole reason this file
 * exists: a chemistry BLOOMS — the pattern is generated where it stands — while a fluid
 * FLOWS, because the pattern is CARRIED. So this graph has two states, not one. The
 * velocity field is a state, the dye is a state, and the only thing connecting them is
 * that one is used as the coordinate the other is sampled at.
 *
 * ADVECTION IS A DISPLACE NODE, and that is the point of building it here rather than in
 * one kernel. Backward semi-Lagrangian advection — sample the dye one step upstream — is
 * exactly `uv + shift * weight` with a negative weight, which is Displace's whole shader.
 * Diffusion is a Blur. The fade is the Feedback node's own `persistence`. The only thing
 * that needed WGSL is the velocity field's self-advection plus the stirring force, and
 * that is one node. Written as a single kernel the graph would show nothing at all.
 *
 * THE NEGATIVE WEIGHT IS THE EXAMPLE. `weight: [-1, -1]` with `offset: [0, 0]` reads the
 * velocity as a SIGNED per-step displacement and samples AGAINST it. Flip the sign and
 * the dye still moves, still looks like a fluid, and is running the unstable forward
 * scheme — plausible-wrong, which is why `concepts/*.test.ts` pins the sign rather than the
 * presence of the node.
 *
 * ONE POINTER, TWO READERS (§V182). The stirring vortex is in the shader, reading
 * `frameU.pointer` from the shared frame block. The ink blob is on the CPU, its `center`
 * driven by the Mouse node. Neither of them is a DOM listener: both are the coordinate the
 * viewer published for this frame, so the ink lands in the eye of the vortex on every
 * frame by construction rather than by tuning.
 *
 * TWO LOOPS, NO CYCLE (T350, §V285). Neither Feedback is wired back into: each NAMES the
 * node it records, `edges` stays a DAG, and the compiler synthesizes the closing edge. Two
 * loops in one file is also what makes this the example that would notice a swap ordered
 * per-plan rather than per-pair — the velocity pair must swap after the dye has read it.
 *
 * WHY ONLY ONE LOOP IS PINNED (§V50/§V51). Both loops are still cycles, and a cycle breaks
 * resolution/format INHERITANCE because the chain has no ground to stand on — that is why
 * E2 pins its Feedback node. Here only the velocity loop needs it: the dye loop's
 * Composite inherits from `in1`, which is the ink generator, which takes the project's
 * settings. The dye loop is grounded through the ink; the velocity loop is grounded
 * nowhere, so it says what it needs. rgba16float on the velocity is not decoration —
 * a per-step displacement of 0.005 uv has no representation in rgba8unorm at all.
 *
 * The frame is SQUARE. Displace's weight is in uv units, so a 16:9 frame would make one
 * unit of velocity travel a different distance horizontally than vertically, and the
 * vortex would come out as an ellipse.
 */
export const fluidDocument = document(
  "e12-fluid",
  "E12 Fluid",
  settings({ outputResolution: { width: 640, height: 640 }, randomSeed: 17 }),
  graph(
    [
      node("mouse", "mouse", [-980, 320], {}, { label: "mouse1" }),
      node(
        "velocity",
        "feedback",
        [-640, 200],
        // T350 (§V285): the loop is a REFERENCE. The velocity feedback NAMES the kernel
        // that produces it, so `edges` stays a DAG and the picture stops showing a cycle.
        { persistence: 1, clearColor: [0, 0, 0, 0], reset: false, source: "stir1" },
        {
          label: "vel1",
          // The velocity loop's only ground (see the note above).
          resolution: { mode: "fixed", width: 640, height: 640 },
          format: { mode: "fixed", format: "rgba16float" },
        },
      ),
      node(
        "stir",
        "customWgsl",
        [-320, 200],
        { [SHADER_SOURCE_PARAMETER]: FLUID_VELOCITY_WGSL, amount: 1 },
        { label: "stir1" },
      ),
      node(
        "dye",
        "feedback",
        [-640, -120],
        { persistence: 0.985, clearColor: [0, 0, 0, 0], reset: false, source: "inject1" },
        { label: "dye1" },
      ),
      node(
        "advect",
        "displace",
        [-320, -120],
        {
          // Per STEP, signed, sampled upstream. See the note above; the sign is the claim.
          weight: [-1, -1],
          offset: [0, 0],
          sourcex: "red",
          sourcey: "green",
          // Nothing may smear in from outside the box.
          extend: "zero",
        },
        { label: "advect1" },
      ),
      node("diffuse", "blur", [-40, -120], { size: 1.4, filter: "gaussian", extend: "zero" }, { label: "diffuse1" }),
      node(
        "ink",
        "circle",
        [-40, 137],
        {
          mode: "fill",
          radius: [0.028, 0.028],
          softness: 0.055,
          fillcolor: [1, 0.62, 0.24, 0.6],
          bgcolor: [0, 0, 0, 0],
          aspectcorrect: true,
        },
        {
          label: "ink1",
          // §V113 component slots, §V182's CPU half: the blob sits where the pointer is,
          // in the same 0..1 v-down coordinate the kernel reads (§V236).
          parameters: {
            "center.x": drivenSlot("mouse1:x", 0.5),
            "center.y": drivenSlot("mouse1:y", 0.5),
          },
        },
      ),
      node("inject", "over", [240, -60], { opacity: 1 }, { label: "inject1" }),
      node("out", "output", [520, -60], {}, { label: "out1" }),
    ],
    [
      edge("e-velocity-stir", ["velocity", "out"], ["stir", "input"]),
      // The SAME texture that closes the velocity loop steers the dye — this frame's
      // velocity, not last frame's, and rendered once for both consumers (§V6).
      edge("e-stir-advect", ["stir", "out"], ["advect", "disp"]),
      edge("e-dye-advect", ["dye", "out"], ["advect", "source"]),
      edge("e-advect-diffuse", ["advect", "out"], ["diffuse", "input"]),
      edge("e-diffuse-inject", ["diffuse", "out"], ["inject", "in2"]),
      edge("e-ink-inject", ["ink", "out"], ["inject", "in1"]),
      edge("e-inject-out", ["inject", "out"], ["out", "input"]),
    ],
  ),
);
