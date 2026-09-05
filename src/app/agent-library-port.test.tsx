// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { createAppRuntime } from "./app-runtime.ts";
import { useAgentPorts } from "./agent-ports.ts";
import { useAgentSurface, type AgentSurfaceState } from "./use-agent-surface.ts";
import { tagsOf } from "../examples/capabilities.ts";

/**
 * T1211 — THE TAB'S AGENT CAN SEE THE ASSEMBLIES TOO, AND FROM THE FIRST RENDER.
 *
 * `bridge.test.ts` proves the headless half over real JSON-RPC. This is the OTHER
 * composition root, and it is the half that would have been forgotten: the pixel ports are
 * built only once a backend exists, so a library port written beside them would report
 * `unavailable` on every machine without WebGPU and on every tab before its first device —
 * which is precisely the session where an agent most needs to be shown a working graph.
 *
 * "Built, tested, never wired" is this project's dominant bug class (§V193), so the
 * assertion goes through the REAL hook the app calls, with `backend: undefined`, and reads
 * the answer back off the REAL surface. Deleting the port from `useAgentPorts` fails here.
 */

afterEach(cleanup);

const STATE: AgentSurfaceState = { selection: [], playing: false, diagnostics: [], diagnosticsRevision: 0 };

function pageSurface() {
  const runtime = createAppRuntime({
    identityStorage: null,
    actor: { kind: "human", id: "tester", label: "Tester" },
  });
  return renderHook(() => {
    // Exactly the app's own call, minus a GPU: `app.tsx` builds ports here and hands them on.
    const ports = useAgentPorts({ backend: undefined, compiled: null, playing: false, graph: runtime.bus.store.getGraph });
    return useAgentSurface(runtime, STATE, ports);
  }).result.current;
}

describe("the tab publishes the shipped corpus with no GPU attached (T1211)", () => {
  it("lists examples and components, with tags earned by each file's own graph", async () => {
    const surface = pageSurface();
    const outcome = await surface.callTool("list_examples", {});
    const data = outcome.data as { entries: Array<{ fileName: string; kind: string; tags: string[]; nodeCount: number }> };

    // Not `unavailable`: the port is attached before any device report exists.
    expect(outcome.status).toBe("ok");
    expect(data.entries.some((entry) => entry.kind === "example")).toBe(true);
    expect(data.entries.some((entry) => entry.kind === "component")).toBe(true);

    /*
     * The claim that costs something, and the reason it is repeated on this side: the browser
     * reads the corpus through a Vite glob and the MCP server through `readdirSync`, so the
     * two roots could describe one file differently. Both derive their rows from the same
     * table, and here that is checked against the graph `get_example` returns for each file.
     */
    for (const entry of data.entries) {
      const opened = await surface.callTool("get_example", { fileName: entry.fileName });
      const nodes = (opened.data as { nodes: Array<{ type: string }> }).nodes;
      expect(opened.status).toBe("ok");
      expect(nodes).toHaveLength(entry.nodeCount);
      expect([...entry.tags].sort()).toEqual([...tagsOf(nodes.map((node) => node.type))].sort());
    }
  });

  it("refuses a file it does not ship rather than answering with an empty graph", async () => {
    const surface = pageSurface();
    const outcome = await surface.callTool("get_example", { fileName: "E999-Nope.loom.json" });
    expect(outcome.status).toBe("error");
    expect(outcome.diagnostics[0]?.code).toBe("example.unknown");
  });
});
