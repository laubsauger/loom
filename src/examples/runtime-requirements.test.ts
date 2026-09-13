import { describe, expect, it } from "vitest";
import { componentNodeType } from "../domain/components/component-type.ts";
import { slotFromValue } from "../domain/parameters/slots.ts";
import { buildProjectFile } from "../domain/project/project-file.ts";
import type { GraphComponentDefinition } from "../domain/types/components.ts";
import type { GraphNode } from "../domain/types/graph.ts";
import { document, graph, node, settings } from "./documents/builders.ts";
import { exampleRuntimeRequirements } from "./runtime-requirements.ts";

function project(nodes: GraphNode[], components: GraphComponentDefinition[] = []): unknown {
  return JSON.parse(buildProjectFile({
    document: document("requirements", "Requirements", settings(), graph(nodes, [])), components,
  }).text);
}

const ids = (value: unknown): string[] => exampleRuntimeRequirements(value).map((entry) => entry.id);

function maskComponent(): GraphComponentDefinition {
  return {
    componentId: "mask", version: 1, name: "Mask", inputs: [], outputs: [],
    graph: graph([node("mask", "personMask", [0, 0])], []),
    parameters: [{
      key: "transport",
      definition: { type: "enum", label: "Transport", compileTime: true, default: "helper", options: [
        { value: "helper", label: "Helper" }, { value: "native", label: "Native" },
      ] },
      targets: [{ nodeId: "mask", key: "transport" }],
    }],
  };
}

describe("example runtime requirements", () => {
  it("does not mistake browser models, webcams or laser geometry for helper dependencies", () => {
    expect(ids(project(["depth", "matte", "webcam", "laserPath"].map((type, index) => node(String(index), type, [0, 0]))))).toEqual([]);
  });

  it.each(["oscIn", "oscOut", "laserOut"])("marks %s as helper-dependent", (type) => {
    expect(ids(project([node("device", type, [0, 0])]))).toEqual(["helper"]);
  });

  it.each(["syphonIn", "syphonOut"])("marks %s as macOS desktop-only", (type) => {
    expect(ids(project([node("device", type, [0, 0])]))).toEqual(["desktop", "macos"]);
  });

  it.each(["ndiIn", "ndiOut"])("marks %s with the current local SDK build requirement", (type) => {
    expect(ids(project([node("device", type, [0, 0])]))).toEqual(["desktop", "macos", "ndi-sdk"]);
  });

  it.each(["spoutIn", "spoutOut"])("marks %s as preparation only, including disabled nodes", (type) => {
    const value = project([node("device", type, [0, 0], type === "spoutOut" ? { enabled: false } : {})]);
    expect(ids(value)).toEqual(["desktop", "windows", "not-implemented"]);
    expect(exampleRuntimeRequirements(value).at(-1)?.label).toBe("Not implemented");
  });

  it("uses the actual helper default and resolves saved static transport envelopes", () => {
    expect(ids(project([node("mask", "personMask", [0, 0])]))).toEqual(["helper", "macos"]);
    expect(ids(project([node("mask", "personMask", [0, 0], {}, {
      parameters: { transport: slotFromValue("native") },
    })]))).toEqual(["desktop", "macos", "apple-silicon"]);
  });

  it("deduplicates and orders dependencies independently of node order", () => {
    const nodes = [node("osc", "oscIn", [0, 0]), node("ndi", "ndiOut", [0, 0]), node("syphon", "syphonIn", [0, 0])];
    expect(ids(project(nodes))).toEqual(["helper", "desktop", "macos", "ndi-sdk"]);
    expect(ids(project(nodes.toReversed()))).toEqual(ids(project(nodes)));
    for (const entry of exampleRuntimeRequirements(project(nodes))) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  it("ignores unused embedded definitions", () => {
    expect(ids(project([], [maskComponent()]))).toEqual([]);
  });

  it("resolves published transport values through two nested instances", () => {
    const inner = maskComponent();
    const outer: GraphComponentDefinition = {
      componentId: "outer", version: 1, name: "Outer", inputs: [], outputs: [],
      graph: graph([node("inner", componentNodeType("mask", 1), [0, 0])], []),
      parameters: [{ ...inner.parameters[0]!, targets: [{ nodeId: "inner", key: "transport" }] }],
    };
    const value = project([node("outer", componentNodeType("outer", 1), [0, 0], { transport: "native" })], [inner, outer]);
    expect(ids(value)).toEqual(["desktop", "macos", "apple-silicon"]);
  });

  it("includes muted/bypassed authored components without changing their saved flags", () => {
    const inner = maskComponent();
    inner.graph.nodes["mask"]!.ui = { muted: true };
    const value = project([node("instance", componentNodeType("mask", 1), [0, 0], { transport: "native" }, {
      ui: { bypassed: true },
    })], [inner]);
    const before = JSON.stringify(value);
    expect(ids(value)).toEqual(["desktop", "macos", "apple-silicon"]);
    expect(JSON.stringify(value)).toBe(before);
  });

  it("honors internal instance overrides", () => {
    const component = maskComponent();
    component.parameters = [];
    const value = project([node("instance", componentNodeType("mask", 1), [0, 0], {}, {
      state: { componentOverrides: { "mask/transport": "native" } },
    })], [component]);
    expect(ids(value)).toEqual(["desktop", "macos", "apple-silicon"]);
  });

  it("refuses missing component definitions instead of promising browser support", () => {
    expect(() => ids(project([node("unknown", componentNodeType("missing", 1), [0, 0])]))).toThrow(/unavailable node/);
  });

  it("refuses an unavailable operator inside an instantiated component", () => {
    const component = maskComponent();
    component.graph.nodes["mask"]!.type = "futureVision";
    component.parameters = [];
    expect(() => ids(project([node("instance", componentNodeType("mask", 1), [0, 0])], [component]))).toThrow(/Cannot determine/);
  });

  it("does not silently classify an invalid transport using its default", () => {
    expect(() => ids(project([node("mask", "personMask", [0, 0], { transport: "automatic" })]))).toThrow(/Cannot determine/);
  });

  it("refuses invalid documents and unimplemented node types", () => {
    expect(() => ids({})).toThrow(/Cannot determine/);
    const future = { ...node("future", "syphonOut", [0, 0]), type: "futureVideoOut" };
    expect(() => ids(project([future]))).toThrow(/unavailable node futureVideoOut/);
  });
});
