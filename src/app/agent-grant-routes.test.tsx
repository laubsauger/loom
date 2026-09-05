// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { AgentPorts, PointsExport, PreviewExport } from "@agent/index.ts";
import { applyBridgeOperatorConsent } from "@agent/index.ts";
import { MCP_HELPER_GRANT_EXPORT_COMMAND } from "../mcp/client-config.ts";
import { createAppRuntime, type AppRuntime } from "./app-runtime.ts";
import { PAGE_GRANT_ROUTES, useAgentSurface, type AgentSurfaceState } from "./use-agent-surface.ts";

/**
 * T1097, T1220 (§V38): WHAT A BROWSER TAB IS TOLD WHEN IT ASKS FOR PIXELS.
 *
 * T1097's finding: `render_preview` is published to this page's WebMCP and bridge
 * transports, and the `export` grant it checked was issuable ONLY by `--grant-export` on
 * the stdio server's own invocation. There is no in-page grant UI, so no tab could ever
 * hold it — and the refusal used to say "only the user can grant it, through the app's
 * confirm flow", a flow that has never existed. A check with no reachable grant path is
 * not a permission, it is a refusal wearing one; §V38's own phrase is "permanent denial in
 * a costume".
 *
 * T1220 closed half of that gap by splitting the CLASS rather than weakening the boundary:
 * a tile of a named output at the size the tab already draws it is not the act `export`
 * exists to guard, so the two tools that answer "what does it look like" moved to
 * `previewSnapshot`, which a paired tab CAN hold. The other half stayed shut — full
 * fidelity of arbitrary content (`read_points`) is still `export`, still unobtainable
 * here, and now says WHY as well as how. Both halves are asserted below, because the
 * failure mode of a split like this is that it quietly becomes a widening.
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

/**
 * A points port that ANSWERS, so it is the capability gate that refuses `read_points` and
 * not the missing port — availability is checked first, which is how T1097's gap stayed
 * invisible for the preview tools. It rejects if it is ever reached, because reaching it
 * would mean the gate let a full-fidelity readback through (T1220).
 */
const pointsPort: PointsExport = {
  read: () => Promise.reject(new Error("read_points ran without the export grant")),
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
  const ports: AgentPorts = { preview: previewPort, points: pointsPort };
  const { result } = renderHook(() => useAgentSurface(runtime, STATE, ports));
  return { runtime, surface: result.current };
}

describe("the tab's agent surface tells the truth about grants it can never hold (T1097)", () => {
  it("refuses read_points as PERMANENT, names export AND the reason, and sends nobody back for approval", async () => {
    const { surface } = pageSurface();
    const outcome = await surface.callTool("read_points", { nodeId: "n1" });
    const [first] = outcome.diagnostics;

    expect(outcome.status).toBe("denied");
    expect(first?.code).toBe("capability.unobtainable");
    expect(first?.message).toContain("export");
    expect(first?.message).toContain("can never be granted on this surface");
    // T1220's own finding about T1097's otherwise excellent refusal: it explained the
    // MECHANISM at length and never said WHY. This is the sentence that turns a
    // frustrating wall into an understandable one.
    expect(first?.message).toContain("camera");
    // What the caller has to know to stop looping: there is no prompt coming.
    expect(first?.suggestion).toContain("Do not retry");
    // The sentence that sent §T1096's worker at a wall. It must not come back.
    expect(JSON.stringify(outcome)).not.toContain("confirm flow");
  });

  it("points at what to use instead, which is the half a refusal usually omits", async () => {
    const { surface } = pageSurface();
    const outcome = await surface.callTool("read_points", { nodeId: "n1" });

    expect(outcome.diagnostics[0]?.message).toContain(PAGE_GRANT_ROUTES.export.guidance);
    expect(PAGE_GRANT_ROUTES.export.guidance).toContain("export and record controls");
  });

  /**
   * T1220: the snapshot refusal is a DIFFERENT KIND of refusal, and the difference is the
   * point of the row. "Not yet, and here is the gesture" and "never here" are different
   * instructions, and a caller that cannot tell them apart either loops on a wall or gives
   * up in front of an open door.
   */
  it("refuses a snapshot as NOT-YET, naming a gesture the person at the keyboard can perform", async () => {
    const { surface } = pageSurface();
    const outcome = await surface.callTool("render_preview", { nodeId: "n1" });
    const [first] = outcome.diagnostics;

    expect(outcome.status).toBe("denied");
    expect(first?.code).toBe("capability.denied");
    expect(first?.message).toContain("previewSnapshot");
    expect(first?.message).not.toContain("can never be granted");
    // The recipe, with the command spelled by the module that owns the command (T1110).
    expect(first?.message).toContain(MCP_HELPER_GRANT_EXPORT_COMMAND);
    expect(first?.message).toContain("Connections");
    // The residual, named to the caller rather than only in a docblock.
    expect(first?.message).toContain("camera frame");
  });

  it("marks all four capability-gated tools, not just the one someone tried", () => {
    const { surface } = pageSurface();
    const gated = surface.listTools()
      .filter((tool) => tool.capabilities.length > 0)
      .map((tool) => ({
        name: tool.name,
        ungranted: [...tool.ungranted],
        unobtainable: [...tool.unobtainable],
      }));

    // A one-off fix to render_preview leaves the other three on the same wall. Pinned by
    // name so a fifth gated tool arriving on this surface is a decision, not a diff — and
    // `ungranted` beside `unobtainable` is what makes T1220's split visible here: all four
    // are ungranted in a cold tab, and only two of them are ungrantABLE in one.
    expect(gated).toEqual([
      { name: "render_preview", ungranted: ["previewSnapshot"], unobtainable: [] },
      { name: "describe_output", ungranted: ["previewSnapshot"], unobtainable: [] },
      { name: "read_points", ungranted: ["export"], unobtainable: ["export"] },
      { name: "save_project", ungranted: ["localFile"], unobtainable: ["localFile"] },
    ]);
  });

  /**
   * THE WHOLE OF T1220 AT THE PAGE'S OWN SEAM, and the negative beside the positive.
   *
   * `applyBridgeOperatorConsent` is what `use-mcp-transports.ts` calls when the bridge
   * confirms an attach to a helper started with `--grant-export`. Here it is called with
   * the same argument, on the surface the app really builds: the tab can SEE, and the tab
   * still cannot read a point buffer out. If a future edit made the snapshot consent carry
   * `export` with it, this is the line that goes red.
   */
  it("lets a paired tab see, and still refuses the full-fidelity readback", async () => {
    const { runtime, surface } = pageSurface();

    applyBridgeOperatorConsent(runtime.bus.grants, surface.actor, { snapshots: true });

    const seen = await surface.callTool("render_preview", { nodeId: "n1" });
    expect(seen.status).not.toBe("denied");
    expect(surface.describeTool("render_preview")?.grantRefusal).toBeNull();

    const readOut = await surface.callTool("read_points", { nodeId: "n1" });
    expect(readOut.status).toBe("denied");
    expect(runtime.bus.grants.has(surface.actor, "export")).toBe(false);

    // And it goes when the attachment goes: a capability that outlived the consent that
    // produced it would be the bug this row is made of, one layer down.
    applyBridgeOperatorConsent(runtime.bus.grants, surface.actor, null);
    const after = await surface.callTool("render_preview", { nodeId: "n1" });
    expect(after.status).toBe("denied");
  });
});
