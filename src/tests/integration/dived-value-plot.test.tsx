// @vitest-environment jsdom
import { createRef } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import { KeymapProvider } from "@editor/keymap/index.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { ValueHistorySource } from "@editor/nodes/value-history.ts";
import { AppRuntimeContext } from "../../app/app-context.ts";
import { createAppRuntime } from "../../app/app-runtime.ts";
import type { AppRuntime } from "../../app/app-runtime.ts";
import { GraphPane } from "../../app/graph-pane.tsx";
import type { GraphActions } from "../../app/graph-pane.tsx";

/**
 * T1029 — A VALUE PLOT INSIDE A COMPONENT READS THE RING THE FRAME LOOP WRITES.
 *
 * T615 keys the history by FLAT id on purpose ("the flat document is what brings a
 * value node inside a component into the window at all" — its own comment), but the
 * pane's read side used the CANVAS id, so every value node in a dived interior
 * subscribed to a ring nobody writes: the owner's screenshot of TimeGrid's `churnx1` /
 * `churny1` showing "VALUE —" over an empty plot while the signal demonstrably ran the
 * wall. The write half shipped without its read half — the value-system twin of
 * T1019's texture fix, at the same seam, with the same identity-at-root property.
 */

beforeAll(() => {
  installDomStubs();
  installFlowStubs();
});
afterEach(cleanup);

function newRuntime(): AppRuntime {
  return createAppRuntime({
    identityStorage: null,
    actor: { kind: "human", id: "tester", label: "Tester" },
  });
}

/** A history that records which ids the pane READS. The snapshot is ONE stable object —
 *  useSyncExternalStore requires identity stability, as the real ring's own comment says. */
const EMPTY_SNAPSHOT = { channels: [], series: [], latest: null, timeSeconds: null };
function recordingHistory(reads: string[]): ValueHistorySource {
  return {
    push: () => {},
    retain: () => {},
    latestSeconds: () => 0,
    subscribe: (nodeId: NodeId, listener: () => void) => {
      void listener;
      reads.push(`subscribe:${nodeId}`);
      return () => {};
    },
    get: (nodeId: NodeId) => {
      reads.push(`get:${nodeId}`);
      return EMPTY_SNAPSHOT as never;
    },
  } as never;
}

/** The canvas renders from the runtime's store, so the LFO is added through the bus —
 *  the pane's `graph` prop rides along as the same document, exactly as the app wires
 *  the dived pane (editing.runtime's store IS what the canvas lists). */
async function addLfo(runtime: AppRuntime): Promise<NodeId> {
  const added = await runtime.bus.execute(
    "graph.applyPatch",
    {
      baseRevision: runtime.bus.store.getRevision(),
      operations: [{ op: "addNode", ref: "$n", type: "lfo", position: { x: 0, y: 0 } }],
    },
    runtime.invocation,
  );
  return added.output.createdIds["$n"] as NodeId;
}

function paneAt(runtime: AppRuntime, path: readonly NodeId[], reads: string[]) {
  const interior: GraphDocument = runtime.bus.store.getGraph();
  return (
    <AppRuntimeContext.Provider value={runtime}>
      <KeymapProvider bus={runtime.bus} invocationContext={runtime.invocation}>
        <GraphPane
          selection={[]}
          onSelectionChange={() => {}}
          onHoveredNodeChange={() => {}}
          portDrag={null}
          onPortDragChange={() => {}}
          onPatchResult={() => {}}
          actionsRef={createRef<GraphActions | null>()}
          graph={interior}
          componentPath={path}
          valueHistory={recordingHistory(reads)}
        />
      </KeymapProvider>
    </AppRuntimeContext.Provider>
  );
}

describe("T1029 — the dived value plot reads the flat ring", () => {
  it("inside an instance, the plot subscribes under the FLAT id the frame loop pushes", async () => {
    const runtime = newRuntime();
    const lfo = await addLfo(runtime);
    const reads: string[] = [];
    await act(async () => render(paneAt(runtime, ["wall" as NodeId], reads)));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
    const touched = new Set(reads.map((entry) => entry.split(":").slice(1).join(":")));
    expect([...touched]).toContain(`wall/${lfo}`);
    // And never the un-prefixed id: a read of a ring nobody writes is the whole bug.
    expect([...touched]).not.toContain(lfo);
  });

  it("at the root the id is unchanged — prefix \"\" is the identity, byte for byte", async () => {
    const runtime = newRuntime();
    const lfo = await addLfo(runtime);
    const reads: string[] = [];
    await act(async () => render(paneAt(runtime, [], reads)));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
    const touched = new Set(reads.map((entry) => entry.split(":").slice(1).join(":")));
    expect([...touched]).toContain(lfo);
  });
});
