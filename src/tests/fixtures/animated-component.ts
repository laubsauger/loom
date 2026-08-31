import type { GraphComponentDefinition } from "../../domain/types/components.ts";
import type { GraphDocument, GraphNode } from "../../domain/types/graph.ts";
import type { StoredParameter } from "../../domain/types/parameters.ts";
import { componentNodeType, createComponentSystem } from "../../domain/components/index.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";

/**
 * ONE component carrying ALL FIVE animation mechanisms, INSTANCED TWICE (T615, §V461).
 *
 * ## Why one fixture and not five
 *
 * The defect T615 fixes is one cause with six symptoms: every per-frame CPU walk read the
 * un-flattened document, so nothing inside a component instance existed for any of them.
 * A fixture per mechanism would let four of them be fixed and the fifth quietly stay dead,
 * which is exactly the site-by-site shape §V437 forbids. So one component holds all five,
 * and the test asserts each one separately against it:
 *
 *   1. a VALUE NODE          — `wob`, an LFO whose frequency is a published knob.
 *   2. a STATEFUL value node — `lag`, so the two instances have two TRAJECTORIES and not
 *                              one shared bag of state (§V79, and the reason two instances
 *                              is load-bearing rather than tidy).
 *   3. an EXPRESSION param   — `amt.operand`, `time * 2`, with a retained static of 0 so a
 *                              dead expression is a DIFFERENT number rather than a similar
 *                              one (§V461: the fixture must be capable of failing).
 *   4. a DRIVEN param        — `blur.size`, reading `amt` by name. The name is what B41's
 *                              `withUniqueNames` renames per instance, and it rewrites the
 *                              binding with it — which is the single reason the flat route
 *                              works at all.
 *   5. an ANALYZE node       — `an`, a GPU readback whose channel is the node's name.
 *   6. a PULSE param         — `fb.resetPulse`, an expression crossing zero.
 *
 * ## Why TWO instances with DIFFERENT published values
 *
 * §V461: a fixture must be CAPABLE of distinguishing what its test asserts. One instance
 * passes even when every instance shares one Lag's state, one channel name and one plot —
 * it is structurally blind to the failure that matters. Two instances with `rate` 0.5 and
 * 2.0 make every mechanism produce a DIFFERENT NUMBER per instance, so a shared-state
 * regression is a failed assertion rather than a coincidence.
 *
 * The document itself carries NO root-level animation on purpose. That is what makes
 * `hasAnimatedParameters(raw) === false` — the half of the defect that killed
 * `compile.animate` outright, and with it every component-internal EXPRESSION, even though
 * flattening preserves those perfectly.
 */

export const PULSE_CROSSES_AT_SECONDS = 0.25;

/**
 * The expression's gain, in blur PIXELS per second.
 *
 * Large on purpose. §V461: the pixel-level gate compares an animated render against an
 * un-animated one, and a blur whose radius reaches 0.17 px in six frames rounds to the
 * same one-tap kernel as a radius of zero — the two renders come out byte-identical and
 * the gate proves nothing. This is the size at which "the animation reached the plan" is
 * visible in the picture.
 */
export const EXPRESSION_GAIN = 120;

/** LFO amplitude, also in blur pixels: it is what makes the two INSTANCES look apart. */
export const LFO_AMPLITUDE = 12;

const node = (id: string, type: string, extra: Partial<GraphNode> = {}): GraphNode => ({
  id,
  type,
  label: id,
  definitionVersion: 1,
  position: { x: 0, y: 0 },
  parameters: {},
  ...extra,
});

const edge = (id: string, from: readonly [string, string], to: readonly [string, string]) => ({
  id,
  source: { nodeId: from[0], portId: from[1] },
  target: { nodeId: to[0], portId: to[1] },
});

/** A driven slot with its retained static beside it (§V108). */
export const driven = (channel: string, retained: number): StoredParameter => ({
  mode: "driven",
  bindings: {
    driven: { kind: "driven", channel },
    static: { kind: "static", value: retained },
  },
});

/** An expression slot with its retained static beside it (§V108). */
export const expression = (source: string, retained: number): StoredParameter => ({
  mode: "expression",
  bindings: {
    expression: { kind: "expression", source },
    static: { kind: "static", value: retained },
  },
});

export const ANIMATED_COMPONENT_ID = "animated";

export function animatedComponentDefinition(): GraphComponentDefinition {
  return {
    componentId: ANIMATED_COMPONENT_ID,
    version: 1,
    name: "Animated",
    graph: {
      revision: 1,
      groups: {},
      nodes: Object.fromEntries(
        [
          // 1. the value node. FREE-RUNNING (§V436) — its phase comes from the absolute
          //    clock, which is what the lap case below relies on.
          node("wob", "lfo", { parameters: { frequency: 0.5, amplitude: LFO_AMPLITUDE, shape: "sine" } }),
          // 2. the STATEFUL stage. Two instances, two trajectories, or §V79 is broken.
          node("lag", "valueLag", { parameters: { lag: 0.1 } }),
          // 3. the expression. Retained static 0, so "dead" reads differently from "live".
          node("amt", "valueMath", {
            parameters: { operation: "add", operand: expression(`time * ${String(EXPRESSION_GAIN)}`, 0) },
          }),
          // 4. the driven parameter, reading `amt` BY NAME.
          node("blur", "blur", { parameters: { size: driven("amt", 0) } }),
          // 5. the Analyze node. Its name is its channel.
          node("an", "analyze", { parameters: { channel: "r", operation: "average" } }),
          // 6. the pulse, fired by an expression crossing zero.
          node("fb", "feedback", {
            parameters: {
              persistence: 0.5,
              // The expression language has no comparison operators (T370's whitelist),
              // so "after 0.25s" is written as a sign step: 0 up to the crossing, 1 after.
              // `isPulseArmed` takes any non-zero number, and the watcher is edge-triggered,
              // so this fires EXACTLY ONCE per instance and then holds.
              resetPulse: expression(`max(0, sign(time - ${String(PULSE_CROSSES_AT_SECONDS)}))`, 0),
            },
          }),
        ].map((entry) => [entry.id, entry]),
      ),
      edges: {
        w1: edge("w1", ["wob", "out"], ["lag", "in"]),
        w2: edge("w2", ["lag", "out"], ["amt", "a"]),
        w3: edge("w3", ["blur", "out"], ["an", "input"]),
        w4: edge("w4", ["blur", "out"], ["fb", "in"]),
      },
    },
    inputs: [{ externalId: "source", label: "Source", nodeId: "blur", portId: "input" }],
    outputs: [{ externalId: "out", label: "Out", nodeId: "fb", portId: "out" }],
    parameters: [
      {
        key: "rate",
        definition: { type: "number", label: "Rate", default: 0.5, min: 0, max: 10 },
        targets: [{ nodeId: "wob", key: "frequency" }],
      },
    ],
  };
}

/** The published `rate` each instance carries. Different, which is the whole point. */
export const INSTANCE_RATES: Readonly<Record<string, number>> = { c1: 0.5, c2: 2 };

/**
 * `gen -> c1 -> c2 -> out`. NOTHING at the root animates, so `hasAnimatedParameters` on
 * the raw document answers false and `compile.animate` is null — the state this fixture
 * exists to make visible.
 */
export function twoInstanceDocument(): GraphDocument {
  return {
    revision: 1,
    groups: {},
    nodes: Object.fromEntries(
      [
        // A CHECKER, not a Solid. §V461 again, and it cost a debugging round: blurring a
        // FLAT COLOUR is a no-op, so with a Solid source the animated blur produced
        // byte-identical pixels to a frozen one and the pixel gate below proved nothing.
        // The fixture has to be capable of showing what its test asserts.
        node("gen", "checker", { parameters: { size: [8, 8] } }),
        node("c1", componentNodeType(ANIMATED_COMPONENT_ID, 1), {
          parameters: { rate: INSTANCE_RATES["c1"] as number },
        }),
        node("c2", componentNodeType(ANIMATED_COMPONENT_ID, 1), {
          parameters: { rate: INSTANCE_RATES["c2"] as number },
        }),
        node("out", "output"),
      ].map((entry) => [entry.id, entry]),
    ),
    edges: {
      e0: edge("e0", ["gen", "out"], ["c1", "source"]),
      e1: edge("e1", ["c1", "out"], ["c2", "source"]),
      e2: edge("e2", ["c2", "out"], ["out", "input"]),
    },
  };
}

/** The registry pair the flattening needs: component-aware nodes plus the catalogue. */
export function animatedComponentSystem() {
  const nodes = createNodeRegistry(allNodeDefinitions).view();
  const system = createComponentSystem(nodes);
  system.components.register(animatedComponentDefinition());
  return { components: system.components, registry: system.nodes };
}
