import { describe, expect, it } from "vitest";
import type { PortType } from "@domain/types/ports.ts";
import { testNodeDefinitions } from "@nodes/registry/test-nodes.ts";
import {
  compatibleDefinitions,
  describeDrag,
  describeDragPrecisely,
  filterLibrary,
  friendlyPortLabel,
  groupByCategory,
  matchScore,
  searchDefinitions,
} from "./search.ts";
import { readNodeDragPayload, writeNodeDragPayload } from "./drag-payload.ts";
import type { DragDataCarrier } from "./drag-payload.ts";

const definitions = testNodeDefinitions;
const types = (list: readonly { type: string }[]): string[] => list.map((entry) => entry.type).sort();

const rgba: PortType = { kind: "texture2d", sample: "float", channels: 4 };
const mono: PortType = { kind: "texture2d", sample: "float", channels: 1 };
const untypedChannels: PortType = { kind: "texture2d", sample: "float" };

/**
 * §V13 — "connect requires exact PortType match. ⊥ implicit conversion."
 *
 * The library's port-drag search is the first place a user meets that rule, and the
 * easiest place to break it: offering a "close enough" node produces a suggestion the
 * graph then refuses to connect. So the search must return exactly the set the connect
 * operation would accept — no more.
 */
describe("§V13 — port-drag search offers only exactly-compatible nodes", () => {
  it("finds the nodes that can consume a dragged rgba output", () => {
    const matches = compatibleDefinitions(definitions, { type: rgba, direction: "output" });
    expect(types(matches.map((match) => match.definition))).toEqual([
      "test.blur",
      "test.composite",
      "test.customWgsl",
      "test.feedback",
    ]);
  });

  it("rejects the near misses that make §V13 worth having", () => {
    const matches = compatibleDefinitions(definitions, { type: rgba, direction: "output" });
    const offered = new Set(matches.map((match) => match.definition.type));
    // Same kind, same sample type, different channel count.
    expect(offered.has("test.mono")).toBe(false);
    // Same kind and channels, different sample type.
    expect(offered.has("test.depth")).toBe(false);
    // Different kind entirely.
    expect(offered.has("test.scalarF32")).toBe(false);
    expect(offered.has("test.vec2")).toBe(false);
  });

  it("treats an unspecified channel count as its own declaration, not a wildcard", () => {
    // Widening this to "matches anything" is exactly the implicit coercion §V13 forbids.
    const matches = compatibleDefinitions(definitions, {
      type: untypedChannels,
      direction: "output",
    });
    expect(matches).toEqual([]);
  });

  it("does not confuse a scalar with another scalar type, or a vec2 with a vec3", () => {
    const f32 = compatibleDefinitions(definitions, {
      type: { kind: "scalar", scalar: "f32" },
      direction: "output",
    });
    expect(types(f32.map((match) => match.definition))).toEqual(["test.scalarF32"]);

    const vec2 = compatibleDefinitions(definitions, {
      type: { kind: "vector", scalar: "f32", size: 2 },
      direction: "output",
    });
    expect(types(vec2.map((match) => match.definition))).toEqual(["test.vec2"]);
  });

  it("searches the other direction when the drag started at an input", () => {
    const matches = compatibleDefinitions(definitions, { type: mono, direction: "input" });
    // Which node can PRODUCE a mono texture: only the mono node.
    expect(types(matches.map((match) => match.definition))).toEqual(["test.mono"]);
  });

  it("reports which port would receive the edge, so the drop can wire it", () => {
    const matches = compatibleDefinitions(definitions, { type: rgba, direction: "output" });
    const blur = matches.find((match) => match.definition.type === "test.blur");
    expect(blur?.port.id).toBe("source");
  });

  it("finds nothing when no registered node accepts the type, rather than relaxing", () => {
    const matches = compatibleDefinitions(definitions, {
      type: { kind: "matrix", columns: 4, rows: 4 },
      direction: "output",
    });
    expect(matches).toEqual([]);
  });
});

/**
 * T167 — the drag banner needs a short, human label, not `describePortType`'s
 * diagnostic-shaped signature. `describePortType` itself stays untouched (§V57):
 * mismatch diagnostics still need to say exactly which sample/channel/space differs.
 */
describe("T167 — friendly port label for the drag banner", () => {
  it("is short and carries no angle brackets, unlike the diagnostic form", () => {
    const label = friendlyPortLabel(rgba);
    expect(label).toBe("RGBA texture");
    expect(label).not.toMatch(/[<>]/);
  });

  it("names channel count in plain language, and falls back for an untyped texture", () => {
    expect(friendlyPortLabel(mono)).toBe("single-channel texture");
    expect(friendlyPortLabel(untypedChannels)).toBe("texture");
  });

  it("gives every other port kind a short, bracket-free label too", () => {
    expect(friendlyPortLabel({ kind: "scalar", scalar: "f32" })).toBe("number");
    expect(friendlyPortLabel({ kind: "vector", scalar: "f32", size: 3 })).toBe("3D vector");
    expect(friendlyPortLabel({ kind: "buffer", element: "Particle", access: "read" })).toBe(
      "buffer",
    );
    expect(friendlyPortLabel({ kind: "matrix", columns: 4, rows: 4 })).toBe("4×4 matrix");
    expect(friendlyPortLabel({ kind: "pointset", requires: [] })).toBe("point set");
    expect(friendlyPortLabel({ kind: "material", model: "pbr" })).toBe("material");
    expect(friendlyPortLabel({ kind: "camera" })).toBe("camera");
  });

  it("describeDrag uses the friendly label; describeDragPrecisely keeps the diagnostic form", () => {
    const drag = { type: rgba, direction: "output" } as const;
    expect(describeDrag(drag)).toBe("RGBA texture");
    expect(describeDragPrecisely(drag)).toBe("texture2d<float,4,linear>");
  });
});

describe("text search", () => {
  it("ranks an exact title above a prefix above a substring", () => {
    expect(matchScore({ ...definitions[0]!, title: "Blur", type: "x" }, "blur")).toBeGreaterThan(
      matchScore({ ...definitions[0]!, title: "Blurry", type: "x" }, "blur") ?? 0,
    );
    expect(matchScore({ ...definitions[0]!, title: "Blurry", type: "x" }, "blur")).toBeGreaterThan(
      matchScore({ ...definitions[0]!, title: "Gaussian Blur X", type: "x" }, "blur") ?? 0,
    );
  });

  it("matches the type, the category, the tags and the description", () => {
    const definition = {
      ...definitions[0]!,
      title: "Zzz",
      type: "pkg.zzz",
      category: "filter",
      tags: ["sharpen"],
      description: "unsharp mask",
    };
    expect(matchScore(definition, "sharpen")).not.toBeNull();
    expect(matchScore(definition, "filter")).not.toBeNull();
    expect(matchScore(definition, "unsharp")).not.toBeNull();
    expect(matchScore(definition, "nothing-like-this")).toBeNull();
  });

  it("returns a stable order for equal scores", () => {
    const first = searchDefinitions(definitions, "test");
    const second = searchDefinitions([...definitions].reverse(), "test");
    expect(types(first)).toEqual(types(second));
    expect(first.map((entry) => entry.title)).toEqual(second.map((entry) => entry.title));
  });
});

describe("the list the pane renders", () => {
  it("applies compatibility, category and query together", () => {
    const list = filterLibrary(definitions, {
      portDrag: { type: rgba, direction: "output" },
      category: "filter",
    });
    expect(types(list)).toEqual(["test.blur"]);
  });

  it("sorts a browse-mode list alphabetically by title", () => {
    const list = filterLibrary(definitions, {});
    expect(list.map((entry) => entry.title)).toEqual(
      [...list.map((entry) => entry.title)].sort((a, b) => a.localeCompare(b)),
    );
  });

  it("groups by category, categories alphabetical", () => {
    const groups = groupByCategory(filterLibrary(definitions, {}));
    expect(groups.map((group) => group.category)).toEqual(
      [...groups.map((group) => group.category)].sort((a, b) => a.localeCompare(b)),
    );
  });
});

describe("drag payload", () => {
  function carrier(): DragDataCarrier & { store: Map<string, string> } {
    const store = new Map<string, string>();
    return {
      store,
      setData: (format, data) => void store.set(format, data),
      getData: (format) => store.get(format) ?? "",
    };
  }

  it("round-trips a node type and the port to wire", () => {
    const transfer = carrier();
    writeNodeDragPayload(transfer, {
      type: "test.blur",
      connectTo: { portId: "source", direction: "input" },
    });
    expect(readNodeDragPayload(transfer)).toEqual({
      type: "test.blur",
      connectTo: { portId: "source", direction: "input" },
    });
    // Plain text too, so the drag means something outside the canvas.
    expect(transfer.store.get("text/plain")).toBe("test.blur");
  });

  it("returns null for a foreign drag instead of throwing", () => {
    const empty = carrier();
    expect(readNodeDragPayload(empty)).toBeNull();

    const junk = carrier();
    junk.setData("application/x-loom-node", "{not json");
    expect(readNodeDragPayload(junk)).toBeNull();

    const wrongShape = carrier();
    wrongShape.setData("application/x-loom-node", JSON.stringify({ nope: 1 }));
    expect(readNodeDragPayload(wrongShape)).toBeNull();
  });

  it("drops a malformed connectTo rather than passing a bad wiring hint on", () => {
    const transfer = carrier();
    transfer.setData(
      "application/x-loom-node",
      JSON.stringify({ type: "test.blur", connectTo: { portId: 7 } }),
    );
    expect(readNodeDragPayload(transfer)).toEqual({ type: "test.blur" });
  });
});
