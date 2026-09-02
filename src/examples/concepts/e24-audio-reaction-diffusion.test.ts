import { describe, expect, it } from "vitest";
import type { GraphNode } from "../../domain/types/graph.ts";
import { effectFor, example } from "./helpers.ts";

/** §T897: drivers are chan-expressions now; read the channel address back out of one. */
function channelOf(source: string | undefined): string | undefined {
  const m = /op\('([^']+)'\)\.chan\.([A-Za-z0-9_]+)/.exec(source ?? "");
  if (m === null) return undefined;
  return m[2] === "value" ? m[1] : `${m[1]}:${m[2]}`;
}


describe("E24 Audio Reaction-Diffusion", () => {
  const { document, plan } = example("E24-Audio-Reaction-Diffusion.loom.json");

  /**
   * T425's headline: substeps is DRIVEN, capped twice. The document binds the channel,
   * the plan carries a loop REGION whose count is the retained base (channels resolve
   * live, not at compile), and the graph-side fence sits exactly on [1, 34].
   */
  it("drives substeps from the bass, through a hard fence, into a live loop region", () => {
    const state = document.graph.nodes["state"] as GraphNode;
    const slot = state.parameters["substeps"] as { mode?: string; bindings?: { expression?: { source?: string } } };
    expect(slot.mode).toBe("expression");
    expect(channelOf(slot?.bindings?.expression?.source)).toBe("steps1:low");
    const begin = plan.passes.find((pass) => pass.kind === "loop" && pass.edge === "begin") as {
      count?: number;
    };
    expect(begin).toBeDefined();
    expect(begin.count).toBe(14); // the retained base — silence's iteration rate
    const cap = document.graph.nodes["scap"] as GraphNode;
    expect(cap.parameters["minimum"]).toBe(1);
    expect(cap.parameters["maximum"]).toBe(34);
  });

  /**
   * The tutorial's safe-bounds warning, as assertions: the white point is driven, and
   * its fence keeps the chemistry inside the band where the pattern SURVIVES — dead
   * Gray-Scott is a fixed point silence cannot revive.
   */
  it("range-maps audio into the chemistry with bounds the pattern survives", () => {
    const shape = document.graph.nodes["shape"] as GraphNode;
    const slot = shape.parameters["whitelevel"] as { mode?: string; bindings?: { expression?: { source?: string } } };
    expect(slot.mode).toBe("expression");
    expect(channelOf(slot?.bindings?.expression?.source)).toBe("wlevel1:lowMid");
    const fence = document.graph.nodes["wcap"] as GraphNode;
    // T562 moved the fence WITH the window it guards: `shape1`'s Level was refitted to the
    // warped field's measured spread (0.451..0.543 rather than 0.235..0.72), so the old
    // 0.62..0.80 would no longer be a safety bound — it would be the whole picture. The
    // assertion is that the fence still BRACKETS the retained white point closely, which is
    // the property, rather than the two literals it used to be.
    const retained = ((document.graph.nodes["shape"] as GraphNode).parameters["whitelevel"] as {
      bindings?: { static?: { value?: number } };
    }).bindings?.static?.value;
    expect(retained).toBe(0.543);
    expect(fence.parameters["minimum"]).toBe(0.528);
    expect(fence.parameters["maximum"]).toBe(0.566);
  });

  /**
   * T562 — THE CHEMISTRY MAP IS A FIELD, and the failure it shipped with was that the
   * field was nearly a CONSTANT: `broad1` ran at period 0.62 with two octaves, one feature
   * bigger than the frame, and `detail1` only warped it. Several octaves at a smaller
   * period is what gives the picture regions, so it is asserted rather than left to be
   * quietly retuned back.
   */
  it("gives the chemistry map more than one spatial scale, or every region runs the same chemistry", () => {
    const broad = document.graph.nodes["broad"] as GraphNode;
    expect(broad.parameters["harmon"]).toBeGreaterThanOrEqual(3);
    expect(broad.parameters["period"]).toBeLessThanOrEqual(0.35);
    // And the window is fitted to the field rather than three times wider than it: a Level
    // whose span dwarfs its input's spread is moving DC, not making contrast.
    const shape = document.graph.nodes["shape"] as GraphNode;
    const black = shape.parameters["blacklevel"] as number;
    const white = ((shape.parameters["whitelevel"] as { bindings?: { static?: { value?: number } } })
      .bindings?.static?.value) as number;
    expect(white - black).toBeLessThan(0.15);
  });

  /** The RGB delay is TIME: three ring taps at three depths, braided one channel each. */
  it("builds the RGB delay from three cache taps, not per-channel scaling", () => {
    const taps = plan.passes
      .filter((pass) => pass.kind === "effect" && String((pass as { id: string }).id).includes("cache-read"))
      .map((pass) => ((pass as { uniforms?: { tap?: number } }).uniforms?.tap ?? 0));
    // T560 shortened the spread from 2/5/9. A delay line LONGER than a transient turns
    // that transient into pure primaries: once a beat seeds new structure, a blob appears
    // and is consumed within a frame or two, and at a spread of seven each channel caught
    // that flash alone. Three depths, braided one channel each, is the concept; the depths
    // are scaled to the fastest thing in the picture.
    expect([...taps].sort((a, b) => a - b)).toEqual([2, 4, 7]);
    const rings = plan.resources.filter((resource) => resource.kind === "ring") as ReadonlyArray<{
      frames: number;
    }>;
    expect(rings.map((ring) => ring.frames).sort((a, b) => a - b)).toEqual([4, 5, 8]);
  });

  /** The wind is INSIDE the loop region, so substeps multiply the stirring. */
  it("stirs inside the loop: the wind pass sits between the loop markers", () => {
    const ids = plan.passes.map((pass) => (pass as { id: string }).id);
    const begin = ids.findIndex((id) => id.endsWith("#loop:begin"));
    const end = ids.findIndex((id) => id.endsWith("#loop:end"));
    const windIndex = ids.findIndex((id) => id.startsWith("wind#"));
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(windIndex).toBeGreaterThan(begin);
    expect(windIndex).toBeLessThan(end);
  });

  /**
   * T734 / §V626 — AND THE WIND ADVECTS, IT DOES NOT ROTATE.
   *
   * This node shipped for a long time as a Transform with `r: 0.02`, a rigid rotation
   * applied seventeen to twenty-four times per frame depending on the bass. §V626 is that
   * a rotation TURNS a lattice and leaves it a lattice: the substrate stays stationary
   * relative to the pattern, so nothing shears. That is why E24 "gets very lame and boring
   * and evenly covers the screen very early on" — the stirring was decorative.
   *
   * Advection through the static chemistry map shears instead, and it beats the rotation at
   * every age measured: at frame 1800, motion 0.0462 to 0.0624 and live spot count 238 to
   * 907. The mutation that proves the claim is `weight: [0, 0]`, which renders a plausible
   * picture and collapses the moved-pixel count three to twelve fold.
   */
  it("advects the state rather than rotating it — the wind is a flow, not a spin", () => {
    expect(document.graph.nodes["wind"]?.type).toBe("displace");

    // Both axes carry weight, or this is a shear along a line rather than a flow.
    const weight = effectFor(plan, "wind").uniforms?.["weight"];
    expect(Array.isArray(weight) ? weight : []).toHaveLength(2);
    for (const axis of weight as readonly number[]) expect(Math.abs(axis)).toBeGreaterThan(0);

    // TWO CHANNELS in the flow field. `mono` offsets every texel identically, which is a
    // translation of the whole dish and shears nothing.
    const swell = effectFor(plan, "swell");
    expect(swell.uniforms?.["mono"]).toBeFalsy();
    expect(swell.uniforms?.["speed"]).not.toBe(0);

    // The state goes in on `source`, the flow on `disp`, and nothing else reaches it.
    const into = Object.values(document.graph.edges).filter((edge) => edge.target.nodeId === "wind");
    expect(into.map((edge) => `${edge.source.nodeId}->${edge.target.portId}`).sort()).toEqual([
      "state->source",
      "swell->disp",
    ]);
    // …and the kernel still reads the wind's output, so the slot is unchanged downstream.
    const out = Object.values(document.graph.edges).filter((edge) => edge.source.nodeId === "wind");
    expect(out.map((edge) => `${edge.target.nodeId}.${edge.target.portId}`)).toEqual(["rd.input"]);

    // The chemistry map is NOT carried along: `dish1` reaches blue through the Reorder,
    // which runs after the kernel, so the state slides across a stationary parameter field.
    const mapIntoPack = Object.values(document.graph.edges).find(
      (edge) => edge.target.nodeId === "pack" && edge.target.portId === "in2",
    );
    expect(mapIntoPack?.source.nodeId).toBe("dish");
  });

  /**
   * T560 — THE TRIGGER SEEDS THE PLATE, AND NOTHING LAGS IT. The shipped file put `trig1`'s
   * one-frame pulse through a `valueLag` of 0.35 s, and a one-pole smoother answers a
   * single-frame impulse with `1 - exp(-dt/tau)` — 0.047 at 60fps — so the palette scale it
   * drove travelled 2.4000..2.4535 on a hit. §V481(b) from the other side. The pulse now
   * reaches the Threshold's CUT raw: shut at 2.0 (nothing in a 0..1 field reaches it), open
   * on the frame the hit lands, screened into the simulation state as a seed the reaction
   * then grows. The assertion is the ABSENCE of a smoother on that path, because that is
   * the thing that was wrong.
   */
  it("seeds the plate from the raw trigger, with nothing smoothing the pulse", () => {
    expect((document.graph.nodes["trig"] as GraphNode).type).toBe("valueTrigger");
    const gate = document.graph.nodes["gate"] as GraphNode;
    expect(gate.type).toBe("threshold");
    const slot = gate.parameters["threshold"] as {
      mode?: string;
      bindings?: { expression?: { source?: string }; static?: { value?: number } };
    };
    expect(channelOf(slot?.bindings?.expression?.source)).toBe("seedcut1:onsetCount");
    expect(slot.bindings?.static?.value).toBe(2); // shut, and shut is exactly zero mask
    // trig1 -> seedamt -> seedcut -> the gate: every hop is arithmetic, none is stateful.
    const path = ["seedamt", "seedcut"].map((id) => (document.graph.nodes[id] as GraphNode).type);
    expect(path).toEqual(["valueMath", "valueMath"]);
    expect(document.graph.nodes["kick"]).toBeUndefined();
    // And the seed is SCREENED into the state, not added: screen takes U and V to 1 where
    // the mask is, which is the kernel's own seededState, and leaves them untouched at 0.
    expect((document.graph.nodes["inject"] as GraphNode).type).toBe("screen");
  });

  /**
   * T560 — FIVE FAST PATHS BESIDE THE SLOW ONE, off a SECOND Lag. The whole diagnosis in
   * one assertion: every audio path used to run through the reaction, which integrates a
   * beat away. These five are one-frame responses, one band each (§V471.3), and the Lag
   * they hang off has to be the fast one or they are back on the integrator.
   */
  it("drives five one-frame properties off a fast lag, one band each", () => {
    const snap = document.graph.nodes["snap"] as GraphNode;
    expect(snap.type).toBe("valueLag");
    expect(snap.parameters["lag"]).toBeLessThan(0.06);
    expect((document.graph.nodes["env"] as GraphNode).parameters["lag"]).toBeGreaterThan(0.1);
    const driven = (nodeId: string, key: string): string | undefined =>
      channelOf(
        (
          (document.graph.nodes[nodeId] as GraphNode).parameters[key] as {
            bindings?: { expression?: { source?: string } };
          }
        )?.bindings?.expression?.source,
      );
    expect(driven("warpA", "weight.x")).toBe("lenswa1:low");
    expect(driven("warpB", "weight.x")).toBe("lenswb1:lowMid");
    expect(driven("warpC", "weight.x")).toBe("lenswc1:high");
    expect(driven("tint", "scale")).toBe("grade1:highMid");
    expect(driven("glow", "brightness")).toBe("bright1:level");
    // Five DIFFERENT bands: one master gain moving everything together is the thing
    // §V471.3 exists to rule out.
    const bands = new Set(
      ["lenswa1:low", "lenswb1:lowMid", "lenswc1:high", "grade1:highMid", "bright1:level"].map(
        (channel) => channel.split(":")[1],
      ),
    );
    expect(bands.size).toBe(5);
    /*
     * T738 — and the three lens weights read a FENCED value, not the bare gain+bias.
     * This is the assertion that would have failed before the fix: under real music the
     * unfenced chains ran NEGATIVE (warpc1 for 99.9% of one track), and a negative
     * displace weight inverts the lens instead of quieting it. The floor is the claim —
     * so it is asserted as a floor of exactly 0, not merely "a Limit exists".
     */
    for (const id of ["acap", "bcap", "ccap"]) {
      const fence = document.graph.nodes[id] as GraphNode;
      expect(fence.type, `${id} must fence its lens weight`).toBe("valueLimit");
      expect(fence.parameters["minimum"], `${id} must floor at zero`).toBe(0);
    }
  });

  /**
   * B74/§V363: the flagship demonstrates ITSELF. Assets are session-only, so no example
   * can ship a bound track — the music node must be the deterministic pattern, or the
   * first-open experience is an LFO breathing over a doc line nobody reads.
   */
  it("ships the synthetic pattern as its source, so it plays on first open", () => {
    const music = document.graph.nodes["music"] as GraphNode;
    expect(music.type).toBe("audioPattern");
    expect(music.label).toBe("music1"); // the swap contract: replace the node, keep the label
  });
});
