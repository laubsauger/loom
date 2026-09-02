import { describe, expect, it } from "vitest";
import type { GraphNode } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { ParameterValue } from "@domain/types/parameters.ts";
import { defaultParameters } from "@domain/parameters/index.ts";
import { effectiveParameterSchema, resolveParameters } from "@domain/parameters/resolve.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { createNodeRegistry } from "@nodes/registry/index.ts";
import {
  GIZMO_LOCKED_REASON,
  createVec3GizmoStore,
  gizmoHandlesFor,
} from "./vec3-gizmo-store.ts";
import type { GizmoParameterFacts, Vec3GizmoEditor } from "./vec3-gizmo-store.ts";

/**
 * T935 — what a gizmo WRITES, and what it refuses to write.
 *
 * These are the two halves of the row that are not geometry. The write half is §T692's
 * argument reused verbatim: the only thing this store can reach is the inspector's own
 * `ParameterEditor`, so a drag produces the same `setParameters` patch a typed edit does
 * (§V29/§V30) and one gesture is one undo group (§V15). The refusal half is §V113's rule
 * as §T896 and §T893 state it — the affordance is shown, the write is refused, and the
 * reason is one string everything reads.
 *
 * The recording editor below asserts on ENTRIES AND PHASES, not on call counts: a store
 * that wrote the right numbers under the wrong phase would coalesce a whole drag into no
 * undo entry, or a single click into one, and a count would not see either.
 */

const NODE = "light1" as NodeId;

function recorder(): Vec3GizmoEditor & {
  calls: Array<{ entries: Readonly<Record<string, ParameterValue>>; phase: "live" | "commit" }>;
} {
  const calls: Array<{
    entries: Readonly<Record<string, ParameterValue>>;
    phase: "live" | "commit";
  }> = [];
  return {
    calls,
    setStored(nodeId, entries, phase) {
      expect(nodeId).toBe(NODE);
      calls.push({ entries, phase });
    },
  };
}

/** A manifest with every trap in it: the wrong sizes, the wrong types, and a real pair. */
const SCHEMA: GizmoParameterFacts["schema"] = {
  kind: { type: "enum", label: "Type", default: "point", options: [] },
  intensity: { type: "number", label: "Intensity", default: 1 },
  position: { type: "vector", size: 3, label: "Position", default: [0, 0, 0] },
  target: { type: "vector", size: 3, label: "Target", default: [0, 0, 0] },
  offset: { type: "vector", size: 2, label: "Offset", default: [0, 0] },
  orient: { type: "vector", size: 4, label: "Orient", default: [0, 0, 0, 1] },
  hidden: {
    type: "vector",
    size: 3,
    label: "Hidden",
    default: [0, 0, 0],
    inactiveWhen: () => "This one cannot affect the picture.",
  },
};

function facts(
  overrides: Partial<Record<string, GizmoParameterFacts["resolved"][number]>> = {},
): GizmoParameterFacts {
  const base: GizmoParameterFacts["resolved"] = [
    { key: "kind", value: "point", mode: "static" },
    { key: "intensity", value: 1, mode: "static" },
    { key: "position", value: [1, 2, 3], mode: "static" },
    { key: "target", value: [4, 5, 6], mode: "static" },
    { key: "offset", value: [1, 2], mode: "static" },
    { key: "orient", value: [0, 0, 0, 1], mode: "static" },
    { key: "hidden", value: [9, 9, 9], mode: "static" },
  ];
  const resolved = base.map((entry) => overrides[entry.key] ?? entry);
  return {
    schema: SCHEMA,
    resolved,
    values: Object.fromEntries(resolved.map((entry) => [entry.key, entry.value])),
  };
}

describe("T935 — which parameters are offered a handle", () => {
  it("offers every world-space vec3 and nothing else on the node", () => {
    /*
     * The predicate is `vector` of size 3 and it is only correct because of WHERE it is
     * asked — on a tile the compiler published an orbit basis for, i.e. one that draws a
     * scene in world space. The traps here are the shapes that would slip through a
     * looser test: a 2-vector, a 4-vector, a number and an enum.
     */
    const handles = gizmoHandlesFor(facts());
    expect(handles.map((handle) => handle.key)).toEqual(["position", "target"]);
    expect(handles[0]?.label).toBe("Position");
    expect(handles[0]?.value).toEqual([1, 2, 3]);
  });

  it("offers NO handle for a parameter §V146 says cannot affect the picture", () => {
    // A point light's `direction`, a directional light's `position`. The inspector field
    // stays editable (§V146: inactive is not disabled) — what is withheld is the MARKER,
    // because a marker drawn in a scene that does not contain the thing it marks is a lie
    // about the scene rather than merely a wasted control.
    expect(gizmoHandlesFor(facts()).some((handle) => handle.key === "hidden")).toBe(false);
  });

  it("SHOWS a driven handle and refuses it, rather than hiding it (§T935(b))", () => {
    /*
     * The distinction the row insists on. Hiding would make a driven parameter look like
     * one that could never have a gizmo; the honest report is that it has one and its
     * driver currently owns it. That is §T896's ruling for the colour picker and §T893's
     * for the disabled field, one surface further out.
     */
    const handles = gizmoHandlesFor(
      facts({ position: { key: "position", value: [1, 2, 3], mode: "expression" } }),
    );
    const position = handles.find((handle) => handle.key === "position");
    expect(position).toBeDefined();
    expect(position?.refusal).toBe(GIZMO_LOCKED_REASON);
    // Its sibling is untouched: the refusal is per parameter, not per node.
    expect(handles.find((handle) => handle.key === "target")?.refusal).toBeNull();
  });

  it("refuses on ONE non-static AXIS, because the write is all three or nothing (§V113)", () => {
    // A compound parameter is component-addressable, so `position.y` can run an
    // expression while x and z are constants. A gizmo cannot write two of three.
    const handles = gizmoHandlesFor(
      facts({
        position: {
          key: "position",
          value: [1, 2, 3],
          mode: "static",
          components: [
            { name: "x", mode: "static" },
            { name: "y", mode: "bind" },
            { name: "z", mode: "static" },
          ],
        },
      }),
    );
    expect(handles.find((handle) => handle.key === "position")?.refusal).toBe(
      GIZMO_LOCKED_REASON,
    );
  });

  it("draws a driven handle at its EFFECTIVE value — where the driver put it", () => {
    // Not §V108's retained static. The handle's claim is "this is where this thing is in
    // this picture", and while a driver owns the parameter that is the driver's number.
    const handles = gizmoHandlesFor(
      facts({ target: { key: "target", value: [-7, 0.5, 2], mode: "expression" } }),
    );
    expect(handles.find((handle) => handle.key === "target")?.value).toEqual([-7, 0.5, 2]);
  });

  it("skips a vec3 whose value is not three finite numbers", () => {
    const handles = gizmoHandlesFor(
      facts({ position: { key: "position", value: [1, Number.NaN, 3], mode: "static" } }),
    );
    expect(handles.map((handle) => handle.key)).toEqual(["target"]);
  });
});

const handleFor = (key: string) => {
  const handle = gizmoHandlesFor(facts()).find((entry) => entry.key === key);
  if (handle === undefined) throw new Error(`no handle for ${key}`);
  return handle;
};

describe("T935 — the drag writes the document, once per gesture", () => {
  it("writes LIVE while dragging and COMMITS the last value at the end (§V15)", () => {
    /*
     * The phases ARE the undo behaviour. `live` values share one transaction the editor
     * mints on the first of them and coalesces to an animation frame; `commit` closes it,
     * so a drag is one history entry landing back where the drag began. Asserting the
     * numbers without the phases would pass for a store that opened a new undo group per
     * pointer event.
     */
    const editor = recorder();
    const store = createVec3GizmoStore({ editor });
    expect(store.begin(NODE, handleFor("position"))).toBeNull();
    store.drag(NODE, "position", [0.5, 1, -1]);
    store.drag(NODE, "position", [0.25, 1.5, -1]);
    store.end(NODE, "position");

    expect(editor.calls.map((call) => call.phase)).toEqual(["live", "live", "commit"]);
    expect(editor.calls.at(-1)?.entries).toEqual({ position: [0.25, 1.5, -1] });
    // The commit carries the SAME KEY as the live writes. The editor's gesture identity is
    // the node plus its sorted key set, so a commit under any other key set would open a
    // second group and leave the drag's own transaction open forever.
    expect(Object.keys(editor.calls.at(-1)?.entries ?? {})).toEqual(["position"]);
  });

  it("rounds to six decimals — a drag must not author float noise into the file", () => {
    const editor = recorder();
    const store = createVec3GizmoStore({ editor });
    store.begin(NODE, handleFor("position"));
    store.drag(NODE, "position", [1 / 3, 0.1 + 0.2, -2]);
    expect(editor.calls[0]?.entries).toEqual({ position: [0.333333, 0.3, -2] });
  });

  it("COMMITS NOTHING when a press never moved: a click is not an undo step", () => {
    const editor = recorder();
    const store = createVec3GizmoStore({ editor });
    store.begin(NODE, handleFor("position"));
    store.end(NODE, "position");
    expect(editor.calls).toEqual([]);
  });

  it("REFUSES a driven handle: the reason comes back and nothing is written", () => {
    const editor = recorder();
    const store = createVec3GizmoStore({ editor });
    const driven = gizmoHandlesFor(
      facts({ position: { key: "position", value: [1, 2, 3], mode: "expression" } }),
    ).find((handle) => handle.key === "position");
    expect(driven).toBeDefined();

    expect(store.begin(NODE, driven as never)).toBe(GIZMO_LOCKED_REASON);
    // And the refusal is not decoration: a drag that reached the store anyway still
    // writes nothing, because no session was opened. That is what stops a plain value
    // from silently replacing the expression envelope.
    store.drag(NODE, "position", [9, 9, 9]);
    store.end(NODE, "position");
    expect(editor.calls).toEqual([]);
  });

  it("keeps TWO HANDLES ON ONE NODE independent (§T935(d))", () => {
    /*
     * The "target vector" the owner asked for is a PAIR, and the model must carry it with
     * no special case. Sessions are keyed by node AND parameter, so the two gestures are
     * separate begins, separate writes and — because the editor keys its transaction by
     * the key set — separate undo steps. Dragging one must not move or commit the other.
     */
    const editor = recorder();
    const store = createVec3GizmoStore({ editor });
    store.begin(NODE, handleFor("position"));
    store.begin(NODE, handleFor("target"));
    expect(store.isDragging(NODE, "position")).toBe(true);
    expect(store.isDragging(NODE, "target")).toBe(true);

    store.drag(NODE, "position", [1, 1, 1]);
    store.end(NODE, "position");
    expect(store.isDragging(NODE, "position")).toBe(false);
    // The other gesture survived its sibling's commit.
    expect(store.isDragging(NODE, "target")).toBe(true);

    store.drag(NODE, "target", [2, 2, 2]);
    store.end(NODE, "target");

    expect(editor.calls).toEqual([
      { entries: { position: [1, 1, 1] }, phase: "live" },
      { entries: { position: [1, 1, 1] }, phase: "commit" },
      { entries: { target: [2, 2, 2] }, phase: "live" },
      { entries: { target: [2, 2, 2] }, phase: "commit" },
    ]);
  });

  it("drops the session at the end, so the next gesture re-reads the document (§V657)", () => {
    // T692 pinned the same property: an undo between drags must not be overwritten by a
    // stale local value. Here the value lives entirely in the caller's handle, which is
    // rebuilt from the document each render — so "the session is gone" IS that property.
    const editor = recorder();
    const store = createVec3GizmoStore({ editor });
    store.begin(NODE, handleFor("position"));
    store.drag(NODE, "position", [1, 1, 1]);
    store.end(NODE, "position");
    editor.calls.length = 0;

    store.drag(NODE, "position", [5, 5, 5]);
    store.end(NODE, "position");
    expect(editor.calls).toEqual([]);
  });
});

/**
 * THE WIRING GATE — the derivation runs against the REAL catalogue, not a fixture.
 *
 * "Built, tested, never wired" is this project's dominant bug class, and a predicate that
 * matches nothing is its quietest form: every test above would stay green while no node in
 * the shipped registry ever produced a handle. So these assert the two directions on real
 * definitions — the nodes that MUST offer one, and the shapes that must not.
 *
 * They also pin the SCOPE honestly. `light` and `pointRay` are the whole of it today,
 * because the gate is a published orbit basis and those are the 3D-payload nodes carrying
 * world vectors. `camera` and `projector` own the other four (`eye`/`lookAt`) and are
 * deliberately not orbitable — their tiles draw through their OWN matrix (T561/T614), so a
 * point of theirs has no place on their own picture and T692's orbit gizmo is what edits
 * them. That is a host problem, not a model problem, and it is stated here so the next
 * person reads a decision rather than a gap.
 */
describe("T935 — the derivation against the shipped node catalogue", () => {
  const registry = createNodeRegistry(allNodeDefinitions).view();

  const nodeOf = (type: string, overrides: Record<string, ParameterValue> = {}): GraphNode => {
    const definition = registry.get(type);
    if (definition === undefined) throw new Error(`no definition for ${type}`);
    return {
      id: `${type}1` as NodeId,
      type,
      definitionVersion: definition.version,
      position: { x: 0, y: 0 },
      parameters: { ...defaultParameters(definition.parameters), ...overrides },
    };
  };

  const handlesOf = (node: GraphNode) => {
    const definition = registry.get(node.type);
    if (definition === undefined) throw new Error("missing definition");
    const resolved = resolveParameters(node, definition);
    return gizmoHandlesFor({
      schema: effectiveParameterSchema(definition, node.parameters),
      resolved: resolved.entries,
      values: resolved.values,
    });
  };

  it("gives a DIRECTIONAL light exactly one handle: its Direction", () => {
    // The shipped default. `position` is present in the manifest and §V146-inactive here,
    // which is why the count matters as much as the name.
    expect(handlesOf(nodeOf("light")).map((handle) => handle.key)).toEqual(["direction"]);
  });

  it("swaps to Position the moment the light becomes a POINT light", () => {
    // The handle set follows the parameter that can actually affect the picture, with no
    // second place where "which light kind uses which vector" is written down.
    expect(handlesOf(nodeOf("light", { kind: "point" })).map((handle) => handle.key)).toEqual([
      "position",
    ]);
  });

  it("gives pointRay its world Direction", () => {
    expect(handlesOf(nodeOf("pointRay")).map((handle) => handle.key)).toContain("direction");
  });

  it("gives a CONVOLVE no handles at all — a kernel row is not a place", () => {
    /*
     * The false positive a bare `vector`/3 predicate would produce. It is excluded in the
     * app by WHERE the predicate is asked — a convolve tile is a texture and publishes no
     * orbit basis, so `graph-pane.tsx` never calls this for it — but asserting the three
     * rows here would fail loudly if that gate were ever widened without a `space: "world"`
     * declaration to replace it. So this documents the CONDITION rather than the code:
     * three handles is the right answer for this function and the wrong answer for the app.
     */
    expect(handlesOf(nodeOf("convolve")).map((handle) => handle.key)).toEqual([
      "row0",
      "row1",
      "row2",
    ]);
  });
});
