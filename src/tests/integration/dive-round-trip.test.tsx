// @vitest-environment jsdom
import { createRef } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import { KeymapProvider } from "@editor/keymap/index.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { AppRuntimeContext } from "../../app/app-context.ts";
import { createAppRuntime } from "../../app/app-runtime.ts";
import type { AppRuntime } from "../../app/app-runtime.ts";
import { GraphPane } from "../../app/graph-pane.tsx";
import type { GraphActions } from "../../app/graph-pane.tsx";

/**
 * T639(e) — A DIVE ROUND TRIP IS TWO GESTURES, NOT FIVE.
 *
 * The commands never required more: `graph.jumpUp` takes no input at all, and
 * `graph.diveIn` takes a node id. What the owner called "stumbly" was the UI leaking
 * requirements the commands do not have — entering a component moved focus off the
 * graph pane (so `u` was dead until a canvas click), and leaving one cleared the
 * selection (so the next `i` needed a hunt for the instance you were just inside).
 *
 * The gate drives the pane the way navigation does — the `componentPath` prop moving —
 * and holds the two properties: on every depth change the pane holds focus, and coming
 * UP leaves the exited instance selected.
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

function paneAt(runtime: AppRuntime, path: readonly NodeId[], onSelectionChange: (ids: readonly NodeId[]) => void) {
  return (
    <AppRuntimeContext.Provider value={runtime}>
      <KeymapProvider bus={runtime.bus} invocationContext={runtime.invocation}>
        <GraphPane
          selection={[]}
          onSelectionChange={onSelectionChange}
          onHoveredNodeChange={() => {}}
          portDrag={null}
          onPortDragChange={() => {}}
          onPatchResult={() => {}}
          actionsRef={createRef<GraphActions | null>()}
          componentPath={path}
        />
      </KeymapProvider>
    </AppRuntimeContext.Provider>
  );
}

describe("T639(e) — dive navigation holds focus and hands the selection back", () => {
  it("focus follows every depth change; jumping up selects the exited instance", async () => {
    const runtime = newRuntime();
    const onSelectionChange = vi.fn();
    const instance = "c1" as NodeId;

    const view = await act(async () => render(paneAt(runtime, [], onSelectionChange)));
    const surface = view.container.querySelector<HTMLElement>('[data-keymap-context="graph"]');
    if (surface === null) throw new Error("expected the graph surface to declare its context");

    // DOWN: the pane takes focus so `u` works immediately — no canvas click first.
    await act(async () => {
      view.rerender(paneAt(runtime, [instance], onSelectionChange));
    });
    expect(document.activeElement).toBe(surface);

    // Focus wanders (an inspector field, a palette) — the property is about the
    // TRANSITION, so losing focus between moves must not defeat the next one.
    await act(async () => {
      surface.blur();
    });
    expect(document.activeElement).not.toBe(surface);

    // UP: focus returns AND the instance just exited becomes the selection, so the
    // next dive-in needs no hunt.
    await act(async () => {
      view.rerender(paneAt(runtime, [], onSelectionChange));
    });
    expect(document.activeElement).toBe(surface);
    expect(onSelectionChange).toHaveBeenCalledWith([instance]);
  });

  it("an edit at one depth is not a transition — focus is not stolen", async () => {
    const runtime = newRuntime();
    const onSelectionChange = vi.fn();
    const view = await act(async () => render(paneAt(runtime, [], onSelectionChange)));
    const surface = view.container.querySelector<HTMLElement>('[data-keymap-context="graph"]');
    if (surface === null) throw new Error("expected the graph surface to declare its context");
    await act(async () => {
      surface.blur();
    });

    // Same depth, new array identity — the shape every unrelated re-render has.
    await act(async () => {
      view.rerender(paneAt(runtime, [], onSelectionChange));
    });
    expect(document.activeElement).not.toBe(surface);
    // The canvas reports its own (empty) selection as part of normal mounting; the
    // property is that no NODE got selected by a non-transition.
    expect(onSelectionChange.mock.calls.filter((call) => (call[0] as unknown[]).length > 0)).toEqual([]);
  });
});
