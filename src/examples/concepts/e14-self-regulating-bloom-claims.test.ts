import { describe, expect, it } from "vitest";
import type { GraphNode } from "../../domain/types/graph.ts";
import type { ParameterSlot } from "../../domain/types/parameters.ts";
import { example } from "./helpers.ts";

describe("E14 Self-Regulating Bloom claims", () => {
  const { document } = example("E14-Self-Regulating-Bloom.loom.json");
  const nodes = document.graph.nodes as Record<string, GraphNode>;
  const edges = Object.values(document.graph.edges);
  const into = (nodeId: string) => edges.filter((edge) => edge.target.nodeId === nodeId).map((edge) => edge.source.nodeId);

  /**
   * THE LOOP IS CLOSED, STRUCTURALLY. §V144's image → parameter → image loop is the
   * whole reason this example exists (§V615), so the gate walks it: the analyze node
   * meters the FINISHED composite (not the raw field — metering the input would
   * regulate something the viewer never sees), channelIn reads that channel by name
   * (§V129), the error chain reaches the brightness slot, and the sign along the way
   * is NEGATIVE — a positive controller here is a photograph of a white frame.
   */
  it("closes analyze → channelIn → error chain → driven brightness, with negative sign", () => {
    // Sensor on the final add, the same node the output shows.
    expect(nodes["meter"]?.type).toBe("analyze");
    expect(nodes["meter"]?.label).toBe("meter1");
    expect(into("meter")).toEqual(["glow"]);
    expect(into("out")).toEqual(["glow"]);
    // The crossing reads it back by name.
    expect(nodes["probe"]?.type).toBe("channelIn");
    expect(nodes["probe"]?.parameters["channel"]).toBe("meter1");
    // The chain: probe → neg(×−1) → err(+target) → push(×K) → lift(+base) → clampg.
    expect(into("neg")).toEqual(["probe"]);
    expect(into("err")).toEqual(["neg"]);
    expect(into("push")).toEqual(["err"]);
    expect(into("lift")).toEqual(["push"]);
    expect(into("clampg")).toEqual(["lift"]);
    expect(nodes["neg"]?.parameters["operand"]).toBe(-1);
    expect(Number(nodes["push"]?.parameters["operand"])).toBeGreaterThan(0);
    // The actuator wears the SWITCH, and the switch ships closed: in1 is the chain,
    // in2 is the bare base, and the open branch equals `lift`'s operand exactly, so
    // flipping the index changes one thing — whether the measurement pushes back.
    expect(nodes["engage"]?.label).toBe("gain1");
    expect(nodes["engage"]?.parameters["index"]).toBe(0);
    expect(into("engage").sort()).toEqual(["clampg", "rest"]);
    expect(nodes["rest"]?.parameters["value"]).toBe(nodes["lift"]?.parameters["operand"]);
    const brightness = nodes["gain"]?.parameters["brightness"] as ParameterSlot;
    expect(brightness.mode).toBe("driven");
    expect(brightness.bindings["driven"]).toEqual({ kind: "driven", channel: "gain1" });
  });

  /**
   * THE WRAP IS THE TRAP. A ramp is periodic: a NEGATIVE phase wraps the background —
   * the mask's near-zero majority — into the palette's white top end. Measured while
   * building: phase −0.02 alone lifted the settled meter from 0.51 to 0.94, positive
   * feedback that saturated early builds to a white frame within five frames. The
   * clamp's floor is the safety, so its floor being POSITIVE is gated, not trusted.
   */
  it("clamps the palette phase strictly above the wrap", () => {
    expect(nodes["swirlclamp"]?.label).toBe("swirl1");
    expect(Number(nodes["swirlclamp"]?.parameters["minimum"])).toBeGreaterThan(0);
    const phase = nodes["palette"]?.parameters["phase"] as ParameterSlot;
    expect(phase.mode).toBe("driven");
    expect(phase.bindings["driven"]).toEqual({ kind: "driven", channel: "swirl1" });
    // The retained value sits inside the clamp's window too: a host without the
    // channel must not render the wrapped picture either (§V107).
    const retained = (phase.bindings["static"] as { value?: unknown }).value;
    expect(Number(retained)).toBeGreaterThan(0);
  });

  /**
   * §V510 twice over: BOTH signed pipelines are clamped before anything spreads or
   * adds them. `gain` and `cut` are Levels whose black points emit negatives into
   * rgba16float; without these two floors the halo subtracts itself from the frame.
   */
  it("pins both clamp floors at zero, in the right places", () => {
    for (const id of ["clipbase", "clip"]) {
      expect(nodes[id]?.type).toBe("limit");
      expect(nodes[id]?.parameters["mode"]).toBe("clamp");
      expect(nodes[id]?.parameters["low"]).toBe(0);
    }
    expect(into("cut")).toEqual(["clipbase"]);
    expect(into("halo")).toEqual(["clip"]);
    // The base branch of the add comes from the CLAMPED image, not the raw level.
    expect(into("glow").sort()).toEqual(["clipbase", "tint"]);
  });

  /**
   * FRAME 0 TELLS THE TRUTH ABOUT LATENCY. The resolver answers with the last
   * COMPLETED readback (§V144) and on frame 0 there is none, so channelIn answers its
   * fallback. That fallback is pinned EQUAL to the setpoint: the error reads zero and
   * frame 0 renders at exactly the base brightness — the opening ring the viewer sees
   * afterwards is the loop taking hold one frame late, displayed rather than hidden.
   */
  it("sets the fallback to the setpoint, so frame 0 is the base picture", () => {
    expect(nodes["probe"]?.parameters["fallback"]).toBe(nodes["err"]?.parameters["operand"]);
  });
});
