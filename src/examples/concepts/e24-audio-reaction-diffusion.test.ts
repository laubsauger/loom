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
  const slotOf = (nodeId: string, key: string) =>
    (document.graph.nodes[nodeId] as GraphNode).parameters[key] as {
      mode?: string;
      bindings?: { expression?: { source?: string }; static?: { value?: number } };
    };
  const sourceOf = (nodeId: string, key: string): string => slotOf(nodeId, key).bindings?.expression?.source ?? "";

  /**
   * T425's headline: substeps is DRIVEN, capped twice. The document binds the channel,
   * the plan carries a loop REGION whose count is the retained base (channels resolve
   * live, not at compile), and the graph-side fence sits exactly on [1, 34] — T1234 moved
   * it from a `valueLimit` node into the expression's own `clamp`, so the bound is read
   * off the expression rather than off a third node.
   */
  it("drives substeps from the bass rank, through a hard fence, into a live loop region", () => {
    const slot = slotOf("state", "substeps");
    expect(slot.mode).toBe("expression");
    expect(channelOf(sourceOf("state", "substeps"))).toBe("lvl1:low");
    expect(sourceOf("state", "substeps")).toMatch(/^clamp\(.*, 1, 34\)$/);
    const begin = plan.passes.find((pass) => pass.kind === "loop" && pass.edge === "begin") as {
      count?: number;
    };
    expect(begin).toBeDefined();
    // The retained base is the rank's own mid: a constant input ranks 0.5, so this is
    // silence's iteration rate, 8 + 24 * 0.5.
    expect(begin.count).toBe(20);
  });

  /**
   * The tutorial's safe-bounds warning, as assertions: the white point is driven from the
   * lowMid RANK, and the range the expression spans keeps the chemistry inside the band
   * where the pattern SURVIVES — dead Gray-Scott is a fixed point silence cannot revive.
   * T1234: the rank is 0..1 by construction, so `a + b * rank` IS the fence; the two
   * literals are the measured range (0.49 covers 39% of the disc, 0.55 covers 68%).
   */
  it("range-maps the audio rank into the chemistry with bounds the pattern survives", () => {
    const slot = slotOf("shape", "whitelevel");
    expect(slot.mode).toBe("expression");
    expect(channelOf(sourceOf("shape", "whitelevel"))).toBe("lvl1:lowMid");
    const m = /^([0-9.]+) \+ ([0-9.]+) \* op/.exec(sourceOf("shape", "whitelevel"));
    expect(m).not.toBeNull();
    const rest = Number(m![1]);
    const peak = rest + Number(m![2]);
    expect(rest).toBe(0.48);
    expect(peak).toBeCloseTo(0.55, 6);
    // Retained is the rank's mid, which is what silence renders.
    expect(slot.bindings?.static?.value).toBeCloseTo((rest + peak) / 2, 6);
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
    // T1234: the trigger's pulse is read RAW by the expression — not through `hit1`, whose
    // 250 ms decay would hold the gate open for fifteen frames and seed a wash.
    expect(channelOf(slot?.bindings?.expression?.source)).toBe("trig1:onsetCount");
    expect(slot.bindings?.static?.value).toBe(2); // shut, and shut is exactly zero mask
    expect(channelOf(sourceOf("born", "opacity"))).toBe("trig1:onsetCount");
    const intoTrig = Object.values(document.graph.edges).filter((edge) => edge.target.nodeId === "trig");
    expect(intoTrig.map((edge) => edge.source.nodeId)).toEqual(["source"]);
    expect(document.graph.nodes["kick"]).toBeUndefined();
    // And the seed is SCREENED into the state, not added: screen takes U and V to 1 where
    // the mask is, which is the kernel's own seededState, and leaves them untouched at 0.
    expect((document.graph.nodes["inject"] as GraphNode).type).toBe("screen");
  });

  /**
   * T1234 — ONE ANALYSIS INSTANCE, and every lane is an expression on one of its two bags.
   * The 28 `valueMath`/`valueLimit` conditioning nodes are gone: a raw band × gain lane is a
   * statement about one source's loudness (measured: 21.5% disc occupancy on the pattern,
   * 5.8% on the clip, same graph), and the rank normaliser is what removes the source from
   * the mapping. The assertion is the SHAPE — one instance, two bags, no lane nodes left —
   * and the split: five distinct reads, each on the bag its job needs (§V952: continuous
   * through `levels`, counts through `hits`).
   */
  it("conditions the audio once, and drives every lane as an expression on lvl1 or hit1", () => {
    const analyses = Object.values(document.graph.nodes).filter((node) => node.type === "component:audioAnalysis@1");
    expect(analyses.map((node) => node.id)).toEqual(["analysis"]);
    for (const [id, port] of [["lvl", "levels"], ["hit", "hits"]] as const) {
      const bag = document.graph.nodes[id] as GraphNode;
      expect(bag.type).toBe("valueLimit");
      expect([bag.parameters["minimum"], bag.parameters["maximum"]]).toEqual([0, 1]);
      const into = Object.values(document.graph.edges).filter((edge) => edge.target.nodeId === id);
      expect(into.map((edge) => `${edge.source.nodeId}.${edge.source.portId}`)).toEqual([`analysis.${port}`]);
    }
    // No conditioning lane survives: the only value-math left would be a regression.
    const lanes = Object.values(document.graph.nodes).filter((node) => node.type === "valueMath" || node.type === "valueLag");
    expect(lanes).toEqual([]);
    // Counts through hits, continuous through levels — one read per property.
    const reads = {
      "warpA.weight.x": channelOf(sourceOf("warpA", "weight.x")),
      "warpB.weight.x": channelOf(sourceOf("warpB", "weight.x")),
      "warpC.weight.x": channelOf(sourceOf("warpC", "weight.x")),
      "tint.scale": channelOf(sourceOf("tint", "scale")),
      "glow.brightness": channelOf(sourceOf("glow", "brightness")),
      "grow.s.x": channelOf(sourceOf("grow", "s.x")),
    };
    expect(reads).toEqual({
      "warpA.weight.x": "hit1:kickCount",
      "warpB.weight.x": "hit1:snareCount",
      "warpC.weight.x": "hit1:hatCount",
      "tint.scale": "lvl1:highMid",
      "glow.brightness": "hit1:onsetCount",
      "grow.s.x": "lvl1:low",
    });
    // Both axes of every pair read the same source, or a lens becomes a shear.
    for (const id of ["warpA", "warpB", "warpC"]) expect(sourceOf(id, "weight.y")).toBe(sourceOf(id, "weight.x"));
    expect(sourceOf("grow", "s.y")).toBe(sourceOf("grow", "s.x"));
    // A lens at rest is OFF: the three weights are a bare gain on a count that rests at 0,
    // which is T738's floor stated by the arithmetic rather than by a Limit node.
    for (const id of ["warpA", "warpB", "warpC"]) expect(sourceOf(id, "weight.x")).toMatch(/^0\.[0-9]+ \* op\('hit1'\)/);
  });

  /**
   * T1237 — WHAT KIND of pattern the disc grows is on three slow clocks and never on a
   * beat: a regime change per beat is a strobe of unrelated textures. `anisotropy` must stay
   * under the 0.35 ceiling T1237 measured (past ±0.5, stripes stay alive in the band's high
   * corner where spots die — and this file's black IS that corner being dead).
   */
  it("walks morph, shape and anisotropy on slow free-running LFOs, anisotropy under 0.35", () => {
    const knobs = { morph: "band", shape: "stencil", anisotropy: "grain" } as const;
    for (const [key, id] of Object.entries(knobs)) {
      expect(channelOf(sourceOf("rd", key)), key).toBe(id + "1");
      const lfo = document.graph.nodes[id] as GraphNode;
      expect(lfo.type).toBe("lfo");
      // Slower than a minute per lap: 80 s, 120 s, 164 s.
      expect(lfo.parameters["frequency"] as number).toBeLessThan(1 / 60);
    }
    const grain = document.graph.nodes["grain"] as GraphNode;
    const reach = Math.abs(grain.parameters["amplitude"] as number) + Math.abs(grain.parameters["offset"] as number);
    expect(reach).toBeLessThanOrEqual(0.35);
    // Three incommensurate laps, so the combination never repeats inside a set.
    const periods = Object.values(knobs).map((id) => 1 / ((document.graph.nodes[id] as GraphNode).parameters["frequency"] as number));
    expect(new Set(periods.map((p) => Math.round(p))).size).toBe(3);
  });

  /**
   * T1234 — THE ECHO LOOP IS CAPPED. The old expansion rate rested at 0.982 (a SHRINKING
   * loop that the comments called an expansion); on the low rank it now runs 1.008..1.029
   * always, and `dim1`'s gamma is contractive only in [0,1): above 1 it grows, and the
   * clip's loud bars diverged the top-right corner to inf. The clamp is the bound.
   */
  it("caps the expanding echo loop at 1, between the dimmer and the stamp", () => {
    const cap = document.graph.nodes["cap"] as GraphNode;
    expect(cap.type).toBe("limit");
    expect([cap.parameters["mode"], cap.parameters["low"], cap.parameters["high"]]).toEqual(["clamp", 0, 1]);
    const chain = Object.values(document.graph.edges)
      .filter((edge) => ["fade", "cap"].includes(edge.source.nodeId))
      .map((edge) => `${edge.source.nodeId}->${edge.target.nodeId}.${edge.target.portId}`)
      .sort();
    expect(chain).toEqual(["cap->born.in2", "fade->cap.input"]);
    const m = /^([0-9.]+) \+ ([0-9.]+) \* op/.exec(sourceOf("grow", "s.x"));
    expect(Number(m![1])).toBeGreaterThan(1);
    expect(Number(m![1]) + Number(m![2])).toBeLessThan(1.03);
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
