import { describe, expect, it } from "vitest";
import { DEFAULT_PROJECT_SETTINGS } from "../domain/types/graph.ts";
import { listExamples } from "./catalogue.ts";
import { messagesOf, runExample } from "./runner.ts";
import { exampleRuntimeRequirements } from "./runtime-requirements.ts";
import { tagsOf } from "./capabilities.ts";

function example(number: number) {
  const file = listExamples().find((entry) => entry.fileName.startsWith(`E${number}-`));
  if (file === undefined) throw new Error(`Missing technical example E${number}`);
  const result = runExample(file);
  expect(result.reason).toBeUndefined();
  expect(result.changed).toBe(false);
  expect(messagesOf(result.loadDiagnostics)).toEqual([]);
  if (result.document === undefined || result.plan === undefined) throw new Error("Example did not compile");
  expect(messagesOf(result.plan.diagnostics)).toEqual([]);
  expect(result.plan.passes.length).toBeGreaterThan(0);
  return result.document;
}

/**
 * T1332b — THE TWO BRANCHES ARE INDEPENDENT, asserted as reachability rather than as a
 * literal edge list.
 *
 * The old form listed all three edges, so it re-failed the moment the sent picture stopped
 * being a single `noise` node and became a reference chart — while the property it exists to
 * protect (nothing the receiver shows can have come from the sender in the same document,
 * or the example would appear to work with no transport at all) was never in question. This
 * walks the graph instead: it says WHAT must not be true.
 */
function feeds(graph: { edges: Record<string, { source: { nodeId: string }; target: { nodeId: string } }> }, from: string): Set<string> {
  const reached = new Set<string>([from]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const { source, target } of Object.values(graph.edges)) {
      if (reached.has(source.nodeId) && !reached.has(target.nodeId)) {
        reached.add(target.nodeId);
        grew = true;
      }
    }
  }
  return reached;
}

describe("desktop technical recipes", () => {
  it("E74 prepares Spout wiring without promising or enabling a native transport", () => {
    const doc = example(74);
    const { nodes } = doc.graph;
    expect(doc.name).toBe("E74 Spout Loopback Preparation");
    expect(doc.settings.outputResolution).toEqual({ width: 1920, height: 1080 });
    expect(doc.settings.workingFormat).toBe(DEFAULT_PROJECT_SETTINGS.workingFormat);
    expect(nodes["send"]?.type).toBe("spoutOut");
    expect(nodes["send"]?.parameters["enabled"]).toBe(false);
    expect(nodes["receive"]?.type).toBe("spoutIn");
    expect(nodes["receive"]?.parameters["source"]).toBe("");
    // The sent picture reaches the transport and the local reference, and NOTHING else.
    expect([...feeds(doc.graph, "signal")].sort()).toEqual(["out", "send", "signal"]);
    // What the receiver shows cannot have come from this document's own signal.
    expect([...feeds(doc.graph, "receive")].sort()).toEqual(["receive", "returnOut"]);
    expect(exampleRuntimeRequirements(doc).map(({ id }) => id)).toEqual(["desktop", "windows", "not-implemented"]);
    expect(tagsOf(Object.values(nodes).map(({ type }) => type))).toEqual(expect.arrayContaining(["video", "device"]));
  });

  it.each([[71, "syphon"], [72, "ndi"]] as const)("E%i has independent send and receive branches", (number, transport) => {
    const doc = example(number);
    const { nodes } = doc.graph;
    expect(doc.settings.outputResolution).toEqual({ width: 1920, height: 1080 });
    expect(doc.settings.workingFormat).toBe(DEFAULT_PROJECT_SETTINGS.workingFormat);
    /* T1332b: what goes out is a REFERENCE CHART, and each part of it answers a question a
       loopback poses — the checker resampling, the ramp orientation and channel order, the
       marker liveness and latency. A noise field answered none of them and failed §T521's
       contrast floor at 0.2646..0.2976 of 0.30 while it was at it. */
    expect(nodes["bars"]?.type).toBe("checker");
    expect(nodes["tint"]?.type).toBe("ramp");
    expect(nodes["mark"]?.type).toBe("circle");
    expect(nodes["signal"]?.type).toBe("over");
    expect(nodes["send"]?.type).toBe(`${transport}Out`);
    expect(nodes["send"]?.parameters["enabled"]).toBe(true);
    expect(nodes["receive"]?.type).toBe(`${transport}In`);
    expect(nodes["receive"]?.parameters["source"]).toBe("");
    expect([...feeds(doc.graph, "signal")].sort()).toEqual(["out", "send", "signal"]);
    expect([...feeds(doc.graph, "receive")].sort()).toEqual(["receive", "returnOut"]);
    expect(nodes["out"]?.label).toBe("reference1");
    expect(nodes["returnOut"]?.label).toBe("returned1");
  });

  it("E73 explicitly chooses native Vision and keeps the measurement float", () => {
    const doc = example(73);
    const { nodes, edges } = doc.graph;
    expect(doc.settings.outputResolution).toEqual(DEFAULT_PROJECT_SETTINGS.outputResolution);
    expect(doc.settings.workingFormat).toBe(DEFAULT_PROJECT_SETTINGS.workingFormat);
    expect(nodes["mask"]?.type).toBe("personMask");
    expect(nodes["mask"]?.parameters["transport"]).toBe("native");
    expect(nodes["mask"]?.format).toEqual({ mode: "fixed", format: "rgba16float" });
    expect(nodes["camera"]?.type).toBe("webcam");
    expect(nodes["camera"]?.parameters).toEqual({});
    expect(nodes["source"]?.parameters["index"]).toBe(0);
    expect(edges["calibration-source"]?.order).toBe(0);
    expect(edges["camera-source"]?.order).toBe(1);
    expect(edges["source-mask"]?.target).toEqual({ nodeId: "mask", portId: "input" });
    expect(edges["mask-key"]?.target).toEqual({ nodeId: "key", portId: "in2" });
    expect(edges["source-key"]?.target).toEqual({ nodeId: "key", portId: "in1" });
    expect(doc.assets).toEqual([]);
  });
});
