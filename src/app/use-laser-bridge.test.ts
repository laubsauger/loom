import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createNodeRegistry } from "../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import type { GraphDocument } from "../domain/types/graph.ts";
import { laserPumpDiagnostics, laserPumpNodeTypes } from "./use-laser-bridge.ts";

/**
 * T950 — the laser pump, in its no-transport build: the refusal is consulted, the
 * honest state reaches the surface, and the no-fire mechanism is CHECKABLE — this
 * module constructs no sender, and a test reads the source to hold that (§V840: name
 * the mechanism per path; here every path shares one, so one check covers them all).
 */

const registry = createNodeRegistry(allNodeDefinitions).view();

const graph = {
  revision: 1,
  nodes: {
    beam: { id: "beam", type: "laserPath", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {}, label: "beam1" },
    out: { id: "out", type: "laserOut", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {}, label: "laserout1" },
  },
  edges: {},
  groups: {},
} as never as GraphDocument;

describe("T950 — the laser pump consults the refusal and says the honest thing", () => {
  it("derives its node set from EMISSION_PUMPS, never a hand-list (§T1006)", () => {
    expect(laserPumpNodeTypes()).toEqual(["laserOut"]);
  });

  it("under a blocked policy, every laserOut carries emissionRefusal's own sentence", () => {
    const diagnostics = laserPumpDiagnostics(graph, registry, "blocked");
    expect(diagnostics.length).toBe(1);
    expect(diagnostics[0]?.nodeId).toBe("out");
    expect(diagnostics[0]?.code).toBe("laser.emission.blocked");
    expect(diagnostics[0]?.message).toContain("only a live session");
    expect(diagnostics[0]?.message).toContain("Laser Out");
  });

  it("live, it says simulation-only and why — a silent dark rig reads as a broken rig (§V365)", () => {
    const diagnostics = laserPumpDiagnostics(graph, registry, "live-session");
    expect(diagnostics.length).toBe(1);
    expect(diagnostics[0]?.code).toBe("laser.driver.absent");
    expect(diagnostics[0]?.message).toContain("simulation-only");
    expect(diagnostics[0]?.message).toContain("nothing is transmitted");
  });

  it("says nothing about nodes that do not act on the world", () => {
    const inert = {
      revision: 1,
      nodes: {
        beam: { id: "beam", type: "laserPath", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {}, label: "beam1" },
      },
      edges: {},
      groups: {},
    } as never as GraphDocument;
    expect(laserPumpDiagnostics(inert, registry, "blocked")).toEqual([]);
  });

  it("constructs no transport: the mechanism is absent from the source, checkably", () => {
    // §V840 made concrete: the docblock CLAIMS every path is safe because no sender
    // exists; this reads the code (comments stripped) and holds the claim. When the
    // helper driver lands and a sender legitimately appears here, this test is the
    // reviewer's tap on the shoulder to replace it with per-path mechanism checks.
    const source = readFileSync(fileURLToPath(new URL("./use-laser-bridge.ts", import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/^[ \t]*\/\/.*$/gm, " ");
    for (const token of ["createDeviceClient", "BridgeSocketFactory", "WebSocket", "fetch(", "postMessage"]) {
      expect(source.includes(token), `the no-transport build must not name ${token}`).toBe(false);
    }
  });
});
