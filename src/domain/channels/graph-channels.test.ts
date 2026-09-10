import { describe, expect, it } from "vitest";

import type { GraphComponentDefinition } from "../types/components.ts";
import type { GraphDocument, GraphNode } from "../types/graph.ts";
import type { ComponentId, NodeId, PortId } from "../types/ids.ts";
import type { GraphPatchOperation } from "../types/patch.ts";
import type { StoredParameter } from "../types/parameters.ts";
import type { FrameEvaluationInput } from "../types/frame.ts";
import { createFlattenedGraphSource } from "../../app/flattened-graph.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { allNodeDefinitions, blurNode } from "../../nodes/definitions/index.ts";
import { alice, contextFor, patch } from "../commands/test-support.ts";
import { createDomainBus } from "../commands/index.ts";
import { componentNodeType, createComponentSystem } from "../components/index.ts";
import { createSequentialIdFactory } from "../graph/ids.ts";
import { createGraphStore } from "../graph/store.ts";
import type { ResolvedParameter, ChannelResolver } from "../parameters/resolve.ts";
import { resolveParameters } from "../parameters/resolve.ts";
import { graphChannelResolver, hasAnimatedParameters } from "./graph-channels.ts";

/**
 * The driven mode comes ALIVE (T238, T203, §V143): a parameter driven by channel
 * `lfo1` reads the LFO node named `lfo1`, per frame, through the one resolver.
 */

function node(id: string, type: string, extra: Partial<GraphNode> = {}): GraphNode {
  return {
    id: id as NodeId,
    type,
    definitionVersion: 1,
    position: { x: 0, y: 0 },
    parameters: {},
    ...extra,
  };
}

function graphWith(...nodes: GraphNode[]): GraphDocument {
  return {
    revision: 1,
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
    edges: {},
    groups: {},
  } as unknown as GraphDocument;
}

const registry = createNodeRegistry(allNodeDefinitions).view();

const frameAt = (timeSeconds: number): FrameEvaluationInput => ({
  timeSeconds,
  deltaSeconds: 1 / 60,
  frameIndex: Math.round(timeSeconds * 60),
  mode: "realtime",
  randomSeed: 7,
});

describe("graphChannelResolver (T238-T240)", () => {
  const lfo = node("n-lfo", "lfo", {
    label: "lfo1",
    parameters: { shape: "sine", frequency: 1, amplitude: 0.5, offset: 0.5, phase: 0 },
  });
  const driven = node("n-blur", "blur", {
    label: "blur1",
    parameters: {
      size: { mode: "driven", bindings: { driven: { kind: "driven", channel: "lfo1" } } },
    },
  });

  it("drives a parameter from an LFO by NAME, per frame — something finally moves", () => {
    const graph = graphWith(lfo, driven);
    const channels = graphChannelResolver(graph, registry);

    const at = (t: number) =>
      resolveParameters(driven, blurNode, { frame: frameAt(t), channels }).values["size"];

    expect(at(0.25)).toBeCloseTo(1, 10); // crest: 0.5 + 0.5·sin(π/2)
    expect(at(0.75)).toBeCloseTo(0, 10); // trough
    expect(at(0.25)).toBe(at(0.25)); // §V45: same frame, same value, every time
  });

  it("returns undefined — retained value in effect — for a name that is no value source", () => {
    const graph = graphWith(driven); // no lfo1 in the document
    const channels = graphChannelResolver(graph, registry);
    const resolved = resolveParameters(driven, blurNode, { frame: frameAt(1), channels });
    expect(resolved.get("size")?.value).toBe(8); // blur's manifest default
    expect(resolved.get("size")?.diagnostic?.code).toBe("parameter.driven");
  });

  it("reads the source's parameters as their STATIC view — no channel-of-channel recursion", () => {
    const recursive = node("n-lfo2", "lfo", {
      label: "lfo1",
      parameters: {
        frequency: { mode: "driven", bindings: { driven: { kind: "driven", channel: "lfo1" } } },
        amplitude: 1,
        offset: 0,
        shape: "saw",
      },
    });
    const graph = graphWith(recursive, driven);
    const channels = graphChannelResolver(graph, registry);
    // Frequency's driven slot has no static payload, so the manifest default (1) rules;
    // the point is that this terminates and yields a finite number.
    const value = channels("lfo1", { node: driven, key: "size", definition: blurNode.parameters["size"]!, frame: frameAt(0.5) });
    expect(typeof value).toBe("number");
    expect(Number.isFinite(value)).toBe(true);
  });
});

describe("hasAnimatedParameters", () => {
  it("is false for a static document and true once any slot animates", () => {
    expect(hasAnimatedParameters(graphWith(node("a", "solid")))).toBe(false);
    expect(
      hasAnimatedParameters(
        graphWith(
          node("a", "solid", {
            parameters: {
              amount: { mode: "expression", bindings: { expression: { kind: "expression", source: "time" } } },
            },
          }),
        ),
      ),
    ).toBe(true);
  });

  /**
   * T988 — `map` is the fifth mode and it is the one this predicate leaves out. That is a
   * decision, so it is gated: the reason has to be checkable, not remembered.
   *
   * §V287: a map has NO CPU value. `resolveStored`'s `map` branch returns the RETAINED
   * static and files the mapping as data for the consumer to compile, so the number the
   * inspector reads is the same at every frame. Saying "animated" here would arm the
   * panel's 10 Hz sampler — a timer, a `setState` and a full inspector re-render, ten
   * times a second — for a value that provably cannot move.
   */
  it("excludes `map`, because a mapped parameter's CPU value is the same at every frame", () => {
    const mapped = node("a", "blur", {
      parameters: {
        size: {
          mode: "map",
          bindings: {
            map: { kind: "map", attribute: "size" },
            static: { kind: "static", value: 12 },
          },
        },
      },
    });

    // The reason, measured rather than asserted: resolve the same parameter a thousand
    // frames apart and it is the retained 12 both times. If that ever stopped being true,
    // THIS is the assertion that has to fail before the predicate is changed.
    const early = resolveParameters(mapped, blurNode, { frame: frameAt(0) }).values["size"];
    const late = resolveParameters(mapped, blurNode, { frame: frameAt(1000) }).values["size"];
    expect(early).toBe(12);
    expect(late).toBe(early);

    expect(hasAnimatedParameters(graphWith(mapped))).toBe(false);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════
 * T1245 — THE NAME INDEX IS BUILT ONCE PER RESOLVER, AND A RESOLVER IS ONE FLAT GRAPH
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * `nodeByName` sorted every node id and built a fresh `Map` on EVERY `op('x').chan` read,
 * which is every driven parameter every frame — §T1182's profile put `nodeNames` at 13.7%
 * of a 3000-frame run. The index is now built once inside the resolver closure, the same
 * move §T1172 made for the parameter reader.
 *
 * ⚠ THE HAZARD IS THE SCOPE, NOT THE INDEX, so these gates are about two things and
 * nothing about the mechanism:
 *
 *  1. the ANSWERS are unchanged — including the two easy ones to "clean up": on a
 *     duplicate label the LOWEST node id wins (`nodeNames` sorts the ids and keeps the
 *     first label it meets), and a name matching nothing is `undefined`, which a driven
 *     parameter reads as its retained value;
 *  2. an EDIT is visible on the very next read. The resolver captures ONE graph object
 *     and the app builds a new resolver per flat graph (`use-graph-compile.ts`'s
 *     `channels` memo, keyed on `flatGraph`), so the block below drives rename / add /
 *     delete through the command bus and a component edit through the real registry, and
 *     reads back through `resolveParameters` — the consumer — each time.
 */

const drivenSlot = (channel: string): StoredParameter => ({
  mode: "driven",
  bindings: { driven: { kind: "driven", channel } },
});

/** A `blur1` whose size is driven by `channel`. Not in any document: the resolver is. */
const drivenBlur = (channel: string): GraphNode =>
  node("n-driven-blur", "blur", { label: "blur1", parameters: { size: drivenSlot(channel) } });

const constantNode = (id: string, label: string, value: number): GraphNode =>
  node(id, "constant", { label, parameters: { value } });

/** What the parameter resolver reads back for a size driven by `channel`. */
const sizeDrivenBy = (channels: ChannelResolver, channel: string): ResolvedParameter | undefined =>
  resolveParameters(drivenBlur(channel), blurNode, { frame: frameAt(0), channels }).get("size");

/** Blur's manifest default — what a driven slot RETAINS when its channel answers nothing. */
const NO_CHANNEL = 8;

describe("T1245 — the resolver's name index gives the same answers", () => {
  it("answers many different names from ONE resolver, interleaved", () => {
    // A one-entry cache answers the second name with the first name's node, and a cache
    // that is correct in blocks can still be wrong read alternately — which is how a
    // frame reads it, one driven parameter after another.
    const channels = graphChannelResolver(
      graphWith(constantNode("n-a", "knobA", 3), constantNode("n-b", "knobB", 5)),
      registry,
    );
    expect(sizeDrivenBy(channels, "knobA")?.value).toBe(3);
    expect(sizeDrivenBy(channels, "knobB")?.value).toBe(5);
    expect(sizeDrivenBy(channels, "knobA")?.value).toBe(3);
    expect(sizeDrivenBy(channels, "knobB")?.value).toBe(5);
  });

  it("keeps the duplicate-name winner the sort-and-scan chose: the LOWEST node id", () => {
    // §V127 says duplicate names cannot exist, but legacy documents carry them and
    // `nodeNames` has always had a rule for them: `Object.keys(graph.nodes).sort()`,
    // first label wins. Insertion order is REVERSED against id order here, so a "cleaner"
    // last-wins or an insertion-order tiebreak reads 5 and fails.
    const channels = graphChannelResolver(
      graphWith(constantNode("n-b", "knob", 5), constantNode("n-a", "knob", 3)),
      registry,
    );
    expect(sizeDrivenBy(channels, "knob")?.value).toBe(3);
    expect(sizeDrivenBy(channels, "knob")?.value).toBe(3);
  });

  it("goes on answering nothing for a name that matches nothing, before and after a hit", () => {
    // The miss is the read that has no entry to cache, so it is the one a memo gets
    // wrong: it must stay a miss across the read that populates the index.
    const channels = graphChannelResolver(graphWith(constantNode("n-a", "knob", 3)), registry);
    expect(sizeDrivenBy(channels, "nope")?.value).toBe(NO_CHANNEL);
    expect(sizeDrivenBy(channels, "nope")?.diagnostic?.code).toBe("parameter.driven");
    expect(sizeDrivenBy(channels, "knob")?.value).toBe(3);
    expect(sizeDrivenBy(channels, "nope")?.value).toBe(NO_CHANNEL);
    expect(sizeDrivenBy(channels, "knob")?.value).toBe(3);
  });
});

/**
 * The invalidation half, driven through the REAL path: the command bus edits the
 * document, `createFlattenedGraphSource` produces the flat graph the app runs on, and the
 * resolver is rebuilt exactly when that object changes — `use-graph-compile.ts`'s memo,
 * without React.
 */
interface ChannelScene {
  readonly channels: () => ChannelResolver;
  readonly apply: (operations: GraphPatchOperation[]) => Promise<Record<string, string>>;
  readonly rename: (nodeId: string, label: string | null) => Promise<void>;
  /** What `blur1.size` resolves to, read out of the FLAT graph as the frame loop reads it. */
  readonly sizeOf: (nodeId: string) => ResolvedParameter | undefined;
  readonly components: ReturnType<typeof createComponentSystem>["components"];
}

function scene(definitions: GraphComponentDefinition[] = []): ChannelScene {
  const system = createComponentSystem(createNodeRegistry(allNodeDefinitions).view(), definitions);
  const store = createGraphStore({
    ids: createSequentialIdFactory("t"),
    now: () => "2026-08-29T00:00:00.000Z",
  });
  const { bus } = createDomainBus({ store, registry: system.nodes });
  const flattened = createFlattenedGraphSource({
    store: store.view,
    registry: system.nodes,
    components: system.components,
  });

  // ONE resolver per flat graph object, rebuilt when that object changes — the shape of
  // `use-graph-compile.ts`'s `channels` memo, which is keyed on `flatGraph`.
  let memo: { graph: GraphDocument; channels: ChannelResolver } | null = null;
  const channels = (): ChannelResolver => {
    const graph = flattened.current().graph;
    if (memo === null || memo.graph !== graph) {
      memo = { graph, channels: graphChannelResolver(graph, system.nodes) };
    }
    return memo.channels;
  };

  return {
    channels,
    components: system.components,
    async apply(operations) {
      const result = await bus.execute(
        "graph.applyPatch",
        patch(store.view.getRevision(), operations),
        contextFor(alice),
      );
      expect(result.status).toBe("applied");
      return (result.output as { createdIds: Record<string, string> }).createdIds;
    },
    async rename(nodeId, label) {
      const result = await bus.execute("node.rename", { nodeId, label }, contextFor(alice));
      expect(result.status).toBe("applied");
    },
    sizeOf(nodeId) {
      const resolver = channels();
      const blur = flattened.current().graph.nodes[nodeId as NodeId];
      expect(blur).toBeDefined();
      return resolveParameters(blur as GraphNode, blurNode, {
        frame: frameAt(0),
        channels: resolver,
      }).get("size");
    },
  };
}

const addConstant = (ref: string, label: string, value: number): GraphPatchOperation => ({
  op: "addNode",
  ref: ref as `$${string}`,
  type: "constant",
  position: { x: 0, y: 0 },
  parameters: { value },
  label,
});

const addDrivenBlur = (ref: string, channel: string): GraphPatchOperation => ({
  op: "addNode",
  ref: ref as `$${string}`,
  type: "blur",
  position: { x: 200, y: 0 },
  parameters: { size: drivenSlot(channel) },
  label: "blur1",
});

describe("T1245 — an edit is visible on the very next read", () => {
  it("follows a RENAME through the bus, and stops answering the old name", async () => {
    const world = scene();
    const ids = await world.apply([addConstant("$knob", "knob", 3), addDrivenBlur("$blur", "knob")]);
    expect(world.sizeOf(ids["$blur"]!)?.value).toBe(3);

    await world.rename(ids["$knob"]!, "dial");

    // §V128 rewrote the driven binding in the SAME patch, so the blur now names `dial` —
    // and the read follows it rather than freezing on the index that knew `knob`.
    expect(world.sizeOf(ids["$blur"]!)?.value).toBe(3);
    // What a reference still spelling the old name reads: nothing. A permanent index
    // would still be handing out the constant here.
    expect(sizeDrivenBy(world.channels(), "knob")?.value).toBe(NO_CHANNEL);
    expect(sizeDrivenBy(world.channels(), "dial")?.value).toBe(3);
  });

  it("resolves a node ADDED after the index was already built", async () => {
    // The read order that matters: the first read builds an index with no `knob` in it.
    const world = scene();
    const ids = await world.apply([addDrivenBlur("$blur", "knob")]);
    expect(world.sizeOf(ids["$blur"]!)?.value).toBe(NO_CHANNEL);

    await world.apply([addConstant("$knob", "knob", 7)]);
    expect(world.sizeOf(ids["$blur"]!)?.value).toBe(7);
  });

  it("stops resolving a name whose node was DELETED", async () => {
    const world = scene();
    const ids = await world.apply([addConstant("$knob", "knob", 3), addDrivenBlur("$blur", "knob")]);
    expect(world.sizeOf(ids["$blur"]!)?.value).toBe(3);

    await world.apply([{ op: "removeNodes", nodeIds: [ids["$knob"]! as NodeId] }]);
    expect(world.sizeOf(ids["$blur"]!)?.value).toBe(NO_CHANNEL);
  });

  it("follows a component RE-FLATTEN that moves the name onto another node", async () => {
    // §V210(c): re-authoring a component at the same version changes what flattening
    // produces while the host document is untouched — same nodes, same edges, same
    // revision. `dial` exists ONLY inside the component, so this is also the read of a
    // name that is not in the authored document at all.
    const world = scene([dialbox("dialA", "dialB")]);
    const ids = await world.apply([
      { op: "addNode", ref: "$c1", type: componentNodeType("dialbox" as ComponentId, 1), position: { x: 0, y: 0 } },
      addDrivenBlur("$blur", "dial"),
    ]);
    expect(world.sizeOf(ids["$blur"]!)?.value).toBe(3);

    // The same version, re-authored: `dial` is now the OTHER internal constant.
    world.components.register(dialbox("dialB", "dialA"));
    expect(world.sizeOf(ids["$blur"]!)?.value).toBe(11);
  });
});

/**
 * A component holding two constants: `dialA` is worth 3, `dialB` is worth 11, and the
 * `dial` label sits on whichever id is passed first (the other gets `spare`). Registering
 * the SAME version with the ids swapped is the re-flatten that moves the name.
 */
function dialbox(dialId: "dialA" | "dialB", spareId: "dialA" | "dialB"): GraphComponentDefinition {
  const worth = (id: string): number => (id === "dialA" ? 3 : 11);
  return {
    componentId: "dialbox" as ComponentId,
    version: 1,
    name: "Dial Box",
    graph: graphWith(constantNode(dialId, "dial", worth(dialId)), constantNode(spareId, "spare", worth(spareId))),
    inputs: [],
    outputs: [{ externalId: "out" as PortId, label: "Out", nodeId: dialId as NodeId, portId: "out" as PortId }],
    parameters: [],
  };
}
