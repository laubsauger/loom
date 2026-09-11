// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { flattenComponents } from "@compiler/index.ts";
import type { FlattenedGraph } from "@compiler/index.ts";
import { createValueGraphSession } from "@domain/channels/value-graph.ts";
import { componentNodeType, createComponentSystem } from "@domain/components/index.ts";
import type { GraphComponentDefinition } from "@domain/types/components.ts";
import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import type { GraphDocument, GraphNode } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { ValuePlot } from "@editor/nodes/value-plot.tsx";
import { instanceValueChannels } from "../../app/instance-value-channels.ts";
import { createValueHistoryStore } from "../../app/value-history.ts";

/**
 * T1297 — A COMPONENT INSTANCE'S PLOT FILLS, which it could not do since instances existed.
 *
 * The owner: "we definitely need a way to inspect the different channels if there's
 * multiple channels on a value operator… right now we have no way to see that". The
 * instance in front of him showed an EMPTY plot — not a wrong number, nothing — because
 * `flattenComponents` deletes the instance node and the history sampler walks the
 * flattened graph, so no ring was ever written under the instance's id, while the
 * synthesized definition's `value` outputs made `publishesValueChannels` answer true and
 * the pane draw a plot that said "no signal yet" for the life of the document.
 *
 * These tests go through the REAL flattener and the REAL value graph, because the map
 * being reused (`instanceOutputs`) is produced by the first and keyed against the second.
 * A hand-built map would agree with whatever this file decided it looked like.
 *
 * T1031 fixed the other half of this seam — a plot of a node INSIDE a dived component.
 * Both halves are now the same redirect the TEXTURE layer has used since instances
 * started disappearing (`redirectSink`).
 */

beforeAll(() => {
  installDomStubs();
  if (typeof Element.prototype.checkVisibility !== "function") {
    Element.prototype.checkVisibility = () => true;
  }
});
afterEach(cleanup);

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

const FRAME: FrameEvaluationInput = {
  timeSeconds: 1.5,
  deltaSeconds: 1 / 60,
  frameIndex: 90,
  mode: "realtime",
  randomSeed: 1,
};
const POINTER = { x: 0.25, y: 0.75, buttons: 1 } as const;

/**
 * `audioAnalysis`'s shape, in the nodes a test can drive without a sound card: several
 * inner publishers, exposed as separate value sockets, TWO OF WHICH PUBLISH THE SAME
 * CHANNEL NAME. Mouse publishes `x`, `y`, `buttons`; two of them is the collision the
 * naming rule exists for, and `pointer` + `aim` + `clock` is seven channels — more than
 * the four the curves can carry, so this fixture exercises both halves of the row at once.
 */
function analysisComponent(): GraphComponentDefinition {
  return {
    componentId: "analysis",
    version: 1,
    name: "Analysis",
    graph: {
      revision: 1,
      groups: {},
      nodes: Object.fromEntries(
        [
          node("m1", "mouse"),
          node("m2", "mouse"),
          node("t1", "timer"),
          // Socket order is CANVAS order (T607), so the y coordinates fix the order the
          // readout prints in — `pointer`, `aim`, `clock`.
          node("pointer", "componentOutValue", { position: { x: 300, y: 0 } }),
          node("aim", "componentOutValue", { position: { x: 300, y: 100 } }),
          node("clock", "componentOutValue", { position: { x: 300, y: 200 } }),
        ].map((entry) => [entry.id, entry]),
      ),
      edges: {
        a: edge("a", ["m1", "out"], ["pointer", "in"]),
        b: edge("b", ["m2", "out"], ["aim", "in"]),
        c: edge("c", ["t1", "out"], ["clock", "in"]),
      },
    },
    inputs: [],
    outputs: [],
    parameters: [],
  };
}

/** One inner publisher only, so the instance reads exactly like the node inside it. */
function singleComponent(): GraphComponentDefinition {
  return {
    componentId: "single",
    version: 1,
    name: "Single",
    graph: {
      revision: 1,
      groups: {},
      nodes: Object.fromEntries(
        [node("m1", "mouse"), node("pointer", "componentOutValue", { position: { x: 300, y: 0 } })].map(
          (entry) => [entry.id, entry],
        ),
      ),
      edges: { a: edge("a", ["m1", "out"], ["pointer", "in"]) },
    },
    inputs: [],
    outputs: [],
    parameters: [],
  };
}

function instanceDocument(componentId: string): GraphDocument {
  return {
    revision: 1,
    groups: {},
    nodes: { inst: node("inst", componentNodeType(componentId, 1)) },
    edges: {},
  } as GraphDocument;
}

function world(definition: GraphComponentDefinition) {
  const nodes = createNodeRegistry(allNodeDefinitions).view();
  const system = createComponentSystem(nodes);
  system.components.register(definition);
  const flattened = flattenComponents({
    graph: instanceDocument(definition.componentId),
    registry: system.nodes,
    components: system.components.view(),
  });
  expect(flattened.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
  // The instance really is gone — the premise of the bug, asserted rather than assumed.
  expect(Object.keys(flattened.graph.nodes)).not.toContain("inst");
  return { registry: system.nodes, flattened };
}

/**
 * One frame, exactly as `sampleValueHistory` spends it: ONE evaluation of the value graph
 * (§V275 — a second one would advance a stateful stage twice), the instance entries it
 * yields pushed into the ring, and `retain` given the ids that actually published. A
 * silent instance is absent from that set, which is how its ring is dropped rather than
 * frozen.
 */
function sampleOneFrame(
  registry: ReturnType<typeof world>["registry"],
  flattened: FlattenedGraph,
  store: ReturnType<typeof createValueHistoryStore>,
): void {
  const session = createValueGraphSession(registry);
  const result = session.evaluate(flattened.graph, FRAME, { pointer: POINTER });
  const entries = instanceValueChannels(flattened, registry, result.byId);
  for (const entry of entries) store.push(entry.nodeId, entry.channels, FRAME.timeSeconds);
  store.retain(new Set(entries.map((entry) => entry.nodeId)));
}

/** What the node body actually prints: the channel name beside its number, in order. */
function readout(): ReadonlyArray<readonly [string, string]> {
  const list = screen.getByLabelText("Channels of inst");
  return [...list.querySelectorAll("div")].map((row) => [
    row.querySelector("dt")?.textContent ?? "",
    row.querySelector("dd")?.textContent ?? "",
  ]);
}

describe("T1297 — the instance's own plot", () => {
  it("shows the channels its component publishes, where the user is looking", () => {
    const { registry, flattened } = world(analysisComponent());
    const store = createValueHistoryStore();
    sampleOneFrame(registry, flattened, store);

    render(<ValuePlot nodeId={"inst" as NodeId} history={store} />);

    // The defect, stated as its symptom: this is what the instance showed, forever.
    expect(screen.queryByText("no signal yet")).toBeNull();
    expect(readout()).toEqual([
      ["pointer:x", "0.250"],
      ["pointer:y", "0.750"],
      ["pointer:buttons", "1.000"],
      ["aim:x", "0.250"],
      ["aim:y", "0.750"],
      ["aim:buttons", "1.000"],
      ["clock:value", "1.500"],
    ]);
    store.dispose();
  });

  it("keeps two publishers of the SAME channel name apart, instead of one winning", () => {
    const { registry, flattened } = world(analysisComponent());
    const store = createValueHistoryStore();
    sampleOneFrame(registry, flattened, store);
    const names = store.get("inst" as NodeId).channels;
    // `m1` and `m2` both publish `x`. Merged, one would silently overwrite the other and
    // the instance would claim three channels where it has seven — a readout that is
    // wrong rather than merely short.
    expect(names.filter((name) => name.endsWith(":x"))).toEqual(["pointer:x", "aim:x"]);
    expect(names).toHaveLength(7);
    store.dispose();
  });

  it("plots four curves for seven readings — the cap is on the CURVES", () => {
    const { registry, flattened } = world(analysisComponent());
    const store = createValueHistoryStore();
    sampleOneFrame(registry, flattened, store);
    const history = store.get("inst" as NodeId);
    expect(history.series).toHaveLength(4);
    expect(history.plotted).toEqual(["pointer:x", "pointer:y", "pointer:buttons", "aim:x"]);
    // …and all seven are still readable, which is the half that was unreachable before.
    expect(history.channels).toHaveLength(7);
    store.dispose();
  });

  it("a single exposed publisher reads exactly like the node inside it — no prefix", () => {
    const { registry, flattened } = world(singleComponent());
    const store = createValueHistoryStore();
    sampleOneFrame(registry, flattened, store);
    render(<ValuePlot nodeId={"inst" as NodeId} history={store} />);
    // One socket is one bag; `pointer:x` would be ceremony over a component that IS a
    // Mouse, and the common case is the one worth keeping unadorned.
    expect(readout()).toEqual([
      ["x", "0.250"],
      ["y", "0.750"],
      ["buttons", "1.000"],
    ]);
    store.dispose();
  });

  it("§V91 — a muted inner node reads as NO SIGNAL, never as a zero", () => {
    const { registry, flattened } = world(singleComponentMuted());
    const store = createValueHistoryStore();
    sampleOneFrame(registry, flattened, store);

    render(<ValuePlot nodeId={"inst" as NodeId} history={store} />);
    // A muted node is not cooked and publishes no bag, so the instance publishes nothing.
    // Drawing a line at zero would be a claim that the component produced zero, which is
    // a different and wrong statement about a component that produced nothing.
    expect(screen.getByText("no signal yet")).toBeTruthy();
    expect(store.get("inst" as NodeId).latest).toBeNull();
    store.dispose();
  });

  it("§V91 — a window already recorded is DROPPED when its publisher goes silent", () => {
    const live = world(singleComponent());
    const store = createValueHistoryStore();
    sampleOneFrame(live.registry, live.flattened, store);
    expect(store.get("inst" as NodeId).latest).not.toBeNull();

    // The same document with the inner node muted: `retain` no longer names the instance,
    // so the ring goes rather than freezing on the trajectory it had when it was switched
    // off — a frozen tail reads as a live-but-still signal.
    const off = world(singleComponentMuted());
    sampleOneFrame(off.registry, off.flattened, store);
    expect(store.get("inst" as NodeId).latest).toBeNull();
    store.dispose();
  });
});

function singleComponentMuted(): GraphComponentDefinition {
  const definition = singleComponent();
  return {
    ...definition,
    graph: {
      ...definition.graph,
      nodes: {
        ...definition.graph.nodes,
        m1: { ...(definition.graph.nodes["m1"] as GraphNode), ui: { muted: true } },
      },
    },
  };
}

/**
 * The wiring, asserted as TEXT (the idiom `expression-references.test.tsx` uses).
 *
 * "Built, tested, never wired" is this project's dominant bug class, and the gate that
 * catches it derives `create*`/`open*` FACTORIES from the source tree — a plain function
 * called from one callback is invisible to it. A green file above with a dead call site
 * in `app.tsx` would reproduce the exact bug this row is about: a correct redirect that
 * nothing ever runs.
 */
describe("T1297 — the redirect is on the frame path", () => {
  it("the one value-history sampler calls it, on the same flattened graph and the same bags", () => {
    // Comments stripped first, for the reason `expression-references.test.ts` strips
    // them: the docblock beside the call site quotes the call, and a whole-file scan
    // would go green on a version where the prose survived and the call was deleted.
    // `process.cwd()` rather than `import.meta.url`: in the BROWSER vitest project this
    // module's url is served by vite and is not a file: url at all.
    const app = readFileSync(resolve(process.cwd(), "src/app/app.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(app).toContain("instanceValueChannels(flattened, runtime.registry, bags)");
    expect(app).toContain("valueHistory.push(instance.nodeId, instance.channels");
    expect(app).toContain("live.add(instance.nodeId)");
  });
});
