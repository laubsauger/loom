// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { AgentPorts, PreviewExport } from "@agent/index.ts";
import { createAppRuntime, type AppRuntime } from "./app-runtime.ts";
import { PAGE_GRANT_ROUTES, useAgentSurface, type AgentSurfaceState } from "./use-agent-surface.ts";

/**
 * T1097 (§V38): WHAT A BROWSER TAB IS TOLD WHEN IT ASKS FOR PIXELS.
 *
 * The finding: `render_preview` is published to this page's WebMCP and bridge transports,
 * and the `export` grant it checks is issuable ONLY by `--grant-export` on the stdio
 * server's own invocation. There is no in-page grant UI, so no tab can ever hold it — and
 * the refusal used to say "only the user can grant it, through the app's confirm flow", a
 * flow that has never existed. A check with no reachable grant path is not a permission,
 * it is a refusal wearing one; §V38's own phrase is "permanent denial in a costume".
 *
 * ## Why this test builds the REAL hook rather than a surface of its own
 *
 * The route table is data the COMPOSITION ROOT declares, and a route table that is written,
 * unit-tested and never passed is this project's dominant bug class ("built, tested, never
 * wired"). So the assertion goes through `useAgentSurface` — the one caller the app uses —
 * against a real `AppRuntime`, and reads back the sentence a caller receives. Deleting
 * `grantRoutes` from that call fails this file.
 *
 * The preview port is attached because a tab HAS one: without it the surface answers
 * `unavailable` first and the capability gate is never reached, which is exactly how this
 * gap stayed invisible.
 */

afterEach(cleanup);

const previewPort: PreviewExport = {
  renderPreview: ({ ref }) =>
    Promise.resolve({
      ref,
      mimeType: "image/png" as const,
      width: 1,
      height: 1,
      bytes: new Uint8Array([137, 80, 78, 71]),
    }),
};

const STATE: AgentSurfaceState = {
  selection: [],
  playing: false,
  diagnostics: [],
  diagnosticsRevision: 0,
};

function pageSurface(): { runtime: AppRuntime; surface: ReturnType<typeof useAgentSurface> } {
  const runtime = createAppRuntime({
    identityStorage: null,
    actor: { kind: "human", id: "tester", label: "Tester" },
  });
  const ports: AgentPorts = { preview: previewPort };
  const { result } = renderHook(() => useAgentSurface(runtime, STATE, ports));
  return { runtime, surface: result.current };
}

describe("the tab's agent surface tells the truth about grants it can never hold (T1097)", () => {
  it("refuses render_preview as PERMANENT, names export, and does not send the caller back for approval", async () => {
    const { surface } = pageSurface();
    const outcome = await surface.callTool("render_preview", { nodeId: "n1" });
    const [first] = outcome.diagnostics;

    expect(outcome.status).toBe("denied");
    expect(first?.code).toBe("capability.unobtainable");
    expect(first?.message).toContain("export");
    expect(first?.message).toContain("can never be granted on this surface");
    // What the caller has to know to stop looping: there is no prompt coming.
    expect(first?.suggestion).toContain("Do not retry");
    // The sentence that sent §T1096's worker at a wall. It must not come back.
    expect(JSON.stringify(outcome)).not.toContain("confirm flow");
  });

  it("points at what to use instead, which is the half a refusal usually omits", async () => {
    const { surface } = pageSurface();
    const outcome = await surface.callTool("render_preview", { nodeId: "n1" });

    expect(outcome.diagnostics[0]?.message).toContain(PAGE_GRANT_ROUTES.export.guidance);
    expect(PAGE_GRANT_ROUTES.export.guidance).toContain("export and record controls");
  });

  it("marks all four capability-gated tools, not just the one someone tried", () => {
    const { surface } = pageSurface();
    const gated = surface
      .listTools()
      .filter((tool) => tool.capabilities.length > 0)
      .map((tool) => ({ name: tool.name, unobtainable: [...tool.unobtainable] }));

    // A one-off fix to render_preview leaves the other three on the same wall. Pinned by
    // name so a fifth gated tool arriving on this surface is a decision, not a diff.
    expect(gated).toEqual([
      { name: "render_preview", unobtainable: ["export"] },
      { name: "describe_output", unobtainable: ["export"] },
      { name: "read_points", unobtainable: ["export"] },
      { name: "save_project", unobtainable: ["localFile"] },
    ]);
  });

  it("stops saying it the moment a route exists — the note tracks the gate, not the tool", async () => {
    const { runtime, surface } = pageSurface();
    // Standing in for the in-page grant this task recommends BUILDING: the grant store's
    // owner issues it (§V67), and the refusal disappears with no other change.
    runtime.bus.grants.grant(surface.actor, "export");

    const outcome = await surface.callTool("render_preview", { nodeId: "n1" });
    expect(outcome.status).not.toBe("denied");
    expect(surface.describeTool("render_preview")?.grantRefusal).toBeNull();
  });
});
