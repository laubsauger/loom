import { describe, expect, it } from "vitest";

import { compileGraph, flattenComponents } from "../../compiler/index.ts";
import type { FlattenedGraph } from "../../compiler/index.ts";
import { testCapabilities } from "../../compiler/test-support.ts";
import { hasAnimatedParameters } from "../../domain/channels/graph-channels.ts";
import { createValueGraphSession } from "../../domain/channels/value-graph.ts";
import { createPulseWatcher, pulseCommandInput } from "../../domain/parameters/pulse.ts";
import { DEFAULT_PROJECT_SETTINGS } from "../../domain/types/graph.ts";
import type { FrameEvaluationInput } from "../../domain/types/frame.ts";
import { analyzeChannelEntries, createAnalyzeChannels } from "../../runtime/execution/index.ts";
import {
  EXPRESSION_GAIN,
  INSTANCE_RATES,
  PULSE_CROSSES_AT_SECONDS,
  animatedComponentSystem,
  twoInstanceDocument,
} from "../fixtures/animated-component.ts";

/**
 * A COMPONENT ANIMATES ITSELF — all five mechanisms, two instances, different numbers
 * (T615, §V437, §V79, §V461, §V463).
 *
 * ## What a text scan cannot say
 *
 * `frame-path-flattening.test.ts` proves no frame path reads the raw document. That is a
 * TEXT scan, and §V463 is the invariant that says a text scan is not a semantic read: it
 * cannot tell "flattened and evaluated" from "flattened and thrown away". This file is the
 * other half — it runs the actual per-frame CPU layer on the actual fixture and asks each
 * mechanism for a number.
 *
 * ## Why every case is a COMPARISON between two instances
 *
 * §V461. One instance passes a version of this feature in which every instance shares one
 * Lag, one channel name and one plot — a one-instance fixture is structurally blind to the
 * failure that matters most (§V79). So the fixture instantiates one definition twice with
 * `rate` 0.5 and 2.0, and each assertion is "these two numbers differ", never "this number
 * is non-zero".
 *
 * ## The control
 *
 * Each case is paired with the same question asked of the RAW document, which is what the
 * app did before T615. Those pairs are the sensitivity proof and they live in the test
 * rather than in a broken tree (§V364): if the raw half ever stops being dead, the flat
 * half has stopped measuring anything.
 */

const settings = DEFAULT_PROJECT_SETTINGS;
const capabilities = testCapabilities();
const POINTER = { x: 0, y: 0, buttons: 0 } as const;

const frameAt = (index: number, fps = 60): FrameEvaluationInput => ({
  timeSeconds: index / fps,
  deltaSeconds: 1 / fps,
  frameIndex: index,
  mode: "realtime",
  randomSeed: 1,
});

function fixture(): {
  raw: ReturnType<typeof twoInstanceDocument>;
  flat: FlattenedGraph;
  registry: ReturnType<typeof animatedComponentSystem>["registry"];
} {
  const { components, registry } = animatedComponentSystem();
  const raw = twoInstanceDocument();
  const flat = flattenComponents({ graph: raw, registry, components: components.view() });
  expect(flat.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
  return { raw, flat, registry };
}

/** Runs the value graph forward, exactly as `advanceChannels` does, and keeps the last. */
function runValueGraph(
  graph: Parameters<ReturnType<typeof createValueGraphSession>["evaluate"]>[0],
  registry: ReturnType<typeof animatedComponentSystem>["registry"],
  frames: number,
) {
  const session = createValueGraphSession(registry);
  let last = session.evaluate(graph, frameAt(0), { pointer: POINTER });
  for (let index = 1; index < frames; index += 1) {
    last = session.evaluate(graph, frameAt(index), { pointer: POINTER });
  }
  return last;
}

describe("T615 — a component's own animation runs, per instance", () => {
  it("mechanism 1 (VALUE NODE): each instance's LFO reads its OWN published rate", () => {
    const { raw, flat, registry } = fixture();

    // The control: on the raw document the component's internals do not exist at all.
    const dead = runValueGraph(raw, registry, 16);
    expect([...dead.byId.keys()]).toEqual([]);

    const live = runValueGraph(flat.graph, registry, 16);
    const one = live.byId.get("c1/wob")?.["value"];
    const two = live.byId.get("c2/wob")?.["value"];
    expect(typeof one).toBe("number");
    expect(typeof two).toBe("number");

    // The published knob reached the LFO, and it reached each instance separately: a sine
    // at 0.5 Hz and a sine at 2 Hz are at different points of their cycle at t = 15/60.
    expect(one).not.toBe(two);
    expect(INSTANCE_RATES["c1"]).not.toBe(INSTANCE_RATES["c2"]);
  });

  it("mechanism 2 (STATEFUL stage): two instances hold two Lag trajectories, not one (§V79)", () => {
    const { flat, registry } = fixture();
    const session = createValueGraphSession(registry);

    const one: number[] = [];
    const two: number[] = [];
    for (let index = 0; index < 24; index += 1) {
      const result = session.evaluate(flat.graph, frameAt(index), { pointer: POINTER });
      one.push(result.byId.get("c1/lag")?.["value"] as number);
      two.push(result.byId.get("c2/lag")?.["value"] as number);
    }

    // Both are real trajectories, and they are DIFFERENT ones. A shared state bag would
    // make these two series identical — which is exactly the failure a single-instance
    // fixture cannot see (§V461).
    expect(one.every((value) => Number.isFinite(value))).toBe(true);
    expect(two.every((value) => Number.isFinite(value))).toBe(true);
    expect(one).not.toEqual(two);
    // And each one is a SMOOTHING, not a copy of its input — it lags behind the LFO.
    const lastFrame = session.evaluate(flat.graph, frameAt(24), { pointer: POINTER });
    expect(lastFrame.byId.get("c1/lag")?.["value"]).not.toBe(lastFrame.byId.get("c1/wob")?.["value"]);
  });

  it("mechanism 3 (EXPRESSION): the operand expression evaluates inside the component, per instance", () => {
    const { flat, registry } = fixture();
    const frames = 16;
    const live = runValueGraph(flat.graph, registry, frames);

    const time = frameAt(frames - 1).timeSeconds;
    const expected = (instance: string): number =>
      (live.byId.get(`${instance}/lag`)?.["value"] as number) + time * EXPRESSION_GAIN;

    // The expression's retained static is 0, so a DEAD expression would leave the Math
    // node's operand at 0 and `amt` would equal `lag` exactly. It does not (§V461).
    expect(live.byId.get("c1/amt")?.["value"]).toBeCloseTo(expected("c1"), 10);
    expect(live.byId.get("c2/amt")?.["value"]).toBeCloseTo(expected("c2"), 10);
    expect(live.byId.get("c1/amt")?.["value"]).not.toBe(live.byId.get("c1/lag")?.["value"]);
    expect(live.byId.get("c1/amt")?.["value"]).not.toBe(live.byId.get("c2/amt")?.["value"]);
  });

  it("mechanism 3b (THE ANIMATE GATE): the raw document reports NOTHING animates", () => {
    const { raw, flat } = fixture();
    // This is the largest half of the defect. `compile.animate` is null when this is
    // false, so there is no per-frame compile at all — and a component-internal
    // EXPRESSION dies with it even though flattening preserves it perfectly.
    expect(hasAnimatedParameters(raw)).toBe(false);
    expect(hasAnimatedParameters(flat.graph)).toBe(true);
  });

  it("mechanism 4 (DRIVEN): each instance's blur takes its OWN channel's number", () => {
    const { raw, flat, registry } = fixture();
    const frames = 16;
    const frame = frameAt(frames - 1);
    const live = runValueGraph(flat.graph, registry, frames);

    // B41's `withUniqueNames` renamed instance 2's `amt` and REWROTE the binding that
    // reads it — this is the property the whole flat route rests on.
    const channels = [...live.byName.keys()];
    expect(channels).toContain("amt");
    expect(channels).toContain("amt1");

    const plan = compileGraph({
      graph: raw,
      settings,
      registry,
      capabilities,
      flattened: flat,
      resolution: { frame, channels: live.resolver },
    });
    expect(plan.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);

    const blurSize = (nodeId: string): number => {
      // Pass ids are namespaced by the flattened node they belong to.
      const pass = plan.passes.find(
        (entry) => entry.kind === "effect" && entry.id.endsWith(`${nodeId}:blur-h`),
      );
      if (pass === undefined || pass.kind !== "effect") {
        throw new Error(`no horizontal blur pass for ${nodeId}: ${plan.passes.map((p) => p.id).join(", ")}`);
      }
      return pass.uniforms?.["size"] as number;
    };

    // The number that reached the GPU plan, per instance. Not "the resolver would have
    // said" — the uniform the pass carries.
    expect(blurSize("c1/blur")).not.toBe(blurSize("c2/blur"));
    expect(blurSize("c1/blur")).toBeGreaterThan(0);
    expect(blurSize("c2/blur")).toBeGreaterThan(0);
  });

  it("mechanism 5 (ANALYZE): two instances publish two channels off two buffers", () => {
    const { raw, flat, registry } = fixture();

    // The control, and the exact shape T608 measured: the reduction buffer IS allocated
    // by the plan; only the CPU sampler could not see it.
    expect(analyzeChannelEntries(raw, registry)).toEqual([]);

    const entries = analyzeChannelEntries(flat.graph, registry);
    expect(entries.map((entry) => entry.nodeId).sort()).toEqual(["c1/an", "c2/an"]);
    expect(new Set(entries.map((entry) => entry.channel)).size).toBe(2);
    expect(new Set(entries.map((entry) => entry.resourceId)).size).toBe(2);

    const plan = compileGraph({ graph: raw, settings, registry, capabilities, flattened: flat });
    const allocated = new Set(plan.resources.map((resource) => resource.id));
    for (const entry of entries) expect(allocated.has(entry.resourceId)).toBe(true);

    // And the CPU half end to end: a different reduction per resource must arrive as a
    // different number per instance channel. The readback is stubbed — a GPU is not what
    // is under test here, the routing is.
    const readings: Record<string, number> = {};
    entries.forEach((entry, index) => {
      readings[entry.resourceId] = 0.125 * (index + 1);
    });
    const channels = createAnalyzeChannels({
      readBuffer: (resourceId) => {
        const value = readings[resourceId];
        if (value === undefined) return Promise.reject(new Error(`unknown resource ${resourceId}`));
        // `average, minimum, maximum, alpha` — the reduction's own layout.
        return Promise.resolve(new Float32Array([value, value, value, 1]).buffer);
      },
    });
    channels.track(entries);
    channels.sample();

    return Promise.resolve().then(() => {
      const first = entries[0] as (typeof entries)[number];
      const second = entries[1] as (typeof entries)[number];
      const a = channels.resolver(first.channel, {} as never);
      const b = channels.resolver(second.channel, {} as never);
      expect(typeof a).toBe("number");
      expect(typeof b).toBe("number");
      expect(a).not.toBe(b);
    });
  });

  it("mechanism 6 (PULSE): each instance fires its OWN reset, once, scoped to itself", () => {
    const { raw, flat, registry } = fixture();

    // The control: on the raw document the watcher never sees the pulse at all, so
    // TouchDesigner's whole reset idiom stopped working the moment the loop was packaged.
    const deadWatcher = createPulseWatcher(registry);
    const deadFires: string[] = [];
    for (let index = 0; index < 40; index += 1) {
      for (const fire of deadWatcher.step(raw, frameAt(index))) deadFires.push(fire.nodeId);
    }
    expect(deadFires).toEqual([]);

    const watcher = createPulseWatcher(registry);
    const fires: Array<{ nodeId: string; key: string; frame: number }> = [];
    for (let index = 0; index < 40; index += 1) {
      for (const fire of watcher.step(flat.graph, frameAt(index))) {
        fires.push({ nodeId: fire.nodeId, key: fire.key, frame: index });
      }
    }

    // TWO fires, not one. If the flat ids were not per-instance the watcher's armed map
    // would collide and only ONE would ever cross — which is precisely the §V79 failure a
    // single-instance fixture cannot detect (§V461).
    expect(fires.map((fire) => fire.nodeId).sort()).toEqual(["c1/fb", "c2/fb"]);
    expect(new Set(fires.map((fire) => fire.key))).toEqual(new Set(["resetPulse"]));
    // Edge-triggered: the level stays true for the rest of the run and must not re-fire.
    expect(fires).toHaveLength(2);
    for (const fire of fires) {
      expect(frameAt(fire.frame).timeSeconds).toBeGreaterThan(PULSE_CROSSES_AT_SECONDS);
      expect(frameAt(fire.frame - 1).timeSeconds).toBeLessThanOrEqual(PULSE_CROSSES_AT_SECONDS);
    }

    // And each one dispatches SCOPED TO ITSELF: `$node` becomes the flat id, which is the
    // id the plan's feedback table uses — so instance 1's reset cannot clear instance 2's
    // history (§V126). This is the "map back" half of the hazard.
    const inputs = fires.map((fire) => {
      const definition = registry.get(flat.graph.nodes[fire.nodeId]?.type ?? "")?.parameters[fire.key];
      if (definition === undefined || definition.type !== "pulse") throw new Error("not a pulse");
      return pulseCommandInput(definition, fire.nodeId);
    });
    expect(inputs).toEqual([{ nodeIds: ["c1/fb"] }, { nodeIds: ["c2/fb"] }]);

    const plan = compileGraph({ graph: raw, settings, registry, capabilities, flattened: flat });
    const pairs = new Set(plan.feedback.map((pair) => pair.nodeId));
    expect(pairs.has("c1/fb")).toBe(true);
    expect(pairs.has("c2/fb")).toBe(true);
  });

  it("keeps §V82's source path, which is what names the authored node (T616's hook too)", () => {
    const { flat } = fixture();
    const source = flat.sources.get("c1/wob");
    expect(source?.internalNodeId).toBe("wob");
    expect(source?.path).toEqual(["c1"]);
    expect(source?.sourcePath).toBe("Main / c1 / wob");
    // T616 hangs component-local time off exactly this chain, so T615 must not drop it.
    expect(flat.sources.get("c2/wob")?.path).toEqual(["c2"]);
  });
});
