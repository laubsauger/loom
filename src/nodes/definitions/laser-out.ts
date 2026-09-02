import type { CompiledNodeDescription, NodeDefinition } from "../../domain/types/node-definition.ts";
import { SINK_TAG } from "./sink.ts";

/**
 * Laser Out (T950) — the planned sample stream, to a laser projector DAC. A SINK with
 * no output: the picture was never the device's job (§T947's design win), so E50
 * renders identically with or without hardware, and this node's absence from the
 * render chain is what makes §T715 trivial here rather than hard.
 *
 * ## Where the emission actually happens — never here (T949, §V840 per path)
 *
 * `compile()` produces NO passes and the definition performs NO I/O — §T949's
 * structural scan holds that. The session pump (`src/app/use-laser-bridge.ts`,
 * registered in `EMISSION_PUMPS` — §T1005's gate holds THAT) is the only place bytes
 * could leave, it consults `emissionRefusal` per node, and today it CONSTRUCTS NO
 * TRANSPORT AT ALL: the Ether Dream helper driver has not landed, so the mechanism
 * that prevents firing in every context is the absence of any sender, stated in the
 * pump rather than implied. The wire protocol itself is already built and
 * emulator-gated (`src/mcp/ether-dream.ts`); connecting it to a socket is the bridge
 * helper's commit, behind the dead-man timer §T950 requires (G2: the failsafe lives on
 * the far side of the thing that can fail).
 *
 * ## ARMING IS SESSION STATE AND NEVER DOCUMENT STATE (G1)
 *
 * There is deliberately no "armed" parameter: a parameter is saved into `.loom.json`,
 * and a downloaded document must never be able to emit light by being opened. Arming
 * will be a deliberate human action in the session surface when the transport lands,
 * and it will not survive a reload.
 *
 * ## Safety posture, stated where the author reads it
 *
 * Loom is not a safety device and never describes itself as one. Compliance with
 * IEC 60825-1 is a property of the projector and its operator. What this path
 * guarantees is narrower and total: OUR bugs do not create a hazard — G3's blanked
 * tails, G4's blank-and-hold on bad coordinates, and G9's device-reported rate clamp
 * are enforced by the only functions that produce point bytes (`ether-dream.ts`).
 */
export const laserOutNode: NodeDefinition = {
  type: "laserOut",
  version: 1,
  title: "Laser Out",
  category: "output",
  description:
    "Sends a planned laser sample stream (from Laser Path) to an Ether Dream DAC on the local network. Needs the local helper (pnpm mcp:serve) — a browser page cannot open TCP — and the hardware driver is NOT yet available in this build: the node loads, the document renders, and nothing is transmitted anywhere. THERE IS NO DEFAULT DEVICE: set Host or nothing will ever be sent. Output is a live-session action only — an offline render, a take, a headless export and the test suites never transmit. This drives a laser projector: a projector, its interlocks and its scan-fail hardware are the operator's responsibility, and this node does not make an unsafe projector safe.",
  tags: ["laser", "output", "device", "ether-dream", "dac", SINK_TAG],
  /*
   * T949/§V841 — the row's argument, not just its verdict: this node's PURPOSE is to
   * reach hardware that emits light. It is `pure` under NODE_REPRODUCIBILITY (no
   * output, nothing evaluated — the render reproduces bit-for-bit with or without it),
   * and that answer says NOTHING about the beam, which is exactly why this second axis
   * exists. `emissionRefusal` reads this field; §T1005's gates force the pump that
   * consults it to exist and to be registered.
   */
  sideEffect: "emits",
  /* §V25: a declared sink — the compiler keeps the planner chain above this node
     compiled even though nothing draws it, which is what the pump will read. */
  sink: true,
  inputs: [
    {
      id: "points",
      label: "Samples",
      type: { kind: "pointset" as const, requires: [{ name: "position", type: "vec3f" as const }] },
      description:
        "The PLANNED stream from Laser Path — the exact samples the DAC would receive. Feeding raw geometry here skips the planner's galvo-velocity bounds; wire Laser Path in between.",
    },
  ],
  outputs: [],
  parameters: {
    host: {
      type: "string",
      label: "Host",
      default: "",
      description:
        "The Ether Dream's address on the local network. EMPTY MEANS NO DEVICE — nothing is transmitted, ever, until a host is named (§T950: no default destination; a lighting network is a network).",
    },
    maxPps: {
      type: "number",
      label: "Projector max pps",
      default: 0,
      min: 0,
      max: 96000,
      range: "bounded",
      step: 1000,
      description:
        "An author-set ceiling on the scan rate, BELOW the device's own reported maximum — it can lower the clamp, never raise it (G9). 0 defers to the device's broadcast value. Community practice runs at ~80% of a scanner's rated speed.",
    },
  },
  compile(): CompiledNodeDescription {
    // No passes: the sink declaration alone keeps the upstream plan alive, and the
    // session pump reads the planner's buffers from outside the plan. Emitting GPU
    // work here would put device concerns into every headless render of the document.
    return { passes: [] };
  },
};
