// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { alice, contextFor } from "@domain/commands/test-support.ts";
import { createDomainBus } from "@domain/commands/index.ts";
import { createGraphStore } from "@domain/graph/store.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import { createTestRegistry } from "@nodes/registry/test-nodes.ts";
import { AppRuntimeContext } from "./app-context.ts";
import type { AppRuntime } from "./app-runtime.ts";
import { ShaderPane } from "./dock-panes.tsx";

/**
 * §T219/B11 — data loss, and worth a COMPOSED test rather than another per-module one:
 * every module underneath this (the bus, `commitShaderSource`, `ShaderEditor` itself)
 * already passes its own suite. The bug was in how `ShaderPane` reacts to its `nodeId`
 * prop changing while a draft is still uncommitted — exactly what "click empty canvas"
 * does to it (blurs the editor AND clears the selection in the same tick) — so this
 * drives that prop transition directly rather than trying to reproduce a CodeMirror
 * blur race in jsdom.
 *
 * `ShaderEditor` (real CodeMirror) is replaced with a plain textarea: the defect and
 * the fix are in `ShaderPane`'s own state machine, not in CodeMirror's DOM.
 */

vi.mock("@editor/shader-editor/index.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@editor/shader-editor/index.ts")>();
  return {
    ...actual,
    ShaderEditor: ({
      value,
      onChange,
      onBlur,
      label,
    }: {
      value: string;
      onChange?: (value: string) => void;
      onBlur?: () => void;
      label?: string;
    }) => (
      <textarea
        aria-label={label}
        value={value}
        onChange={(event) => onChange?.(event.target.value)}
        onBlur={onBlur}
      />
    ),
  };
});

afterEach(cleanup);

function graphWith(): GraphDocument {
  return {
    revision: 1,
    nodes: {
      n1: {
        id: "n1",
        type: "test.customWgsl",
        definitionVersion: 1,
        position: { x: 0, y: 0 },
        parameters: {},
      },
    },
    edges: {},
    groups: {},
  };
}

function Harness({ runtime }: { runtime: AppRuntime }) {
  const [nodeId, setNodeId] = useState<string | null>("n1");
  return (
    <AppRuntimeContext.Provider value={runtime}>
      <button type="button" onClick={() => setNodeId(null)}>
        click empty canvas
      </button>
      <ShaderPane nodeId={nodeId as never} graph={runtime.bus.store.getGraph()} diagnostics={[]} />
    </AppRuntimeContext.Provider>
  );
}

function fakeRuntime(): AppRuntime {
  const store = createGraphStore({ initialGraph: graphWith() });
  const { bus } = createDomainBus({ store, registry: createTestRegistry().view() });
  return {
    bus,
    registry: bus.registry,
    invocation: contextFor(alice),
  } as unknown as AppRuntime;
}

describe("ShaderPane — a subject switch commits the outgoing draft (§T219, B11)", () => {
  it("does not discard an unblurred edit when the node is deselected before blur fires", async () => {
    const runtime = fakeRuntime();
    render(<Harness runtime={runtime} />);

    const editor = screen.getByLabelText(/WGSL source for n1/i);
    fireEvent.change(editor, { target: { value: "@fragment fn fs() {}" } });

    // The click both blurs the editor (simulated: never fires here) and clears the
    // selection — `nodeId` goes to null WITHOUT `onBlur` ever running, which is the
    // exact race §T219 closes.
    fireEvent.click(screen.getByRole("button", { name: "click empty canvas" }));

    await vi.waitFor(() => {
      const value = runtime.bus.store.getGraph().nodes["n1"]?.parameters["source"];
      expect(value).toBe("@fragment fn fs() {}");
    });
  });
});

/**
 * T337 / B35 — the §V9 and §V27 strip, on the pane the app actually mounts.
 *
 * These assertions used to live against `ShaderEditorPanel`, which nothing rendered. Its
 * own module docblock claimed the app filled both the shader and problems slots with it,
 * and that sentence is what kept anyone from checking — fourteenth instance of §V220.
 * The behaviour was real and worth keeping, so it moved to `ShaderPane` with the tests
 * that prove it, rather than being deleted with the pane that could not show it.
 */
function paneWith(props: { diagnostics?: RuntimeDiagnostic[]; stale?: boolean } = {}) {
  const runtime = fakeRuntime();
  return render(
    <AppRuntimeContext.Provider value={runtime}>
      <ShaderPane
        nodeId={"n1" as never}
        graph={runtime.bus.store.getGraph()}
        diagnostics={props.diagnostics ?? []}
        {...(props.stale === undefined ? {} : { stale: props.stale })}
      />
    </AppRuntimeContext.Provider>,
  );
}

const shaderDiagnostic = (
  severity: RuntimeDiagnostic["severity"],
  message: string,
): RuntimeDiagnostic => ({ severity, code: "shader.test", message, nodeId: "n1" });

describe("ShaderPane — the status strip (§V9, §V27)", () => {
  it("says the output is stale, and says why, when the backend retained a program", () => {
    // §V9: the render did not stop and did not go black — it is still running the last
    // shader that compiled. Silent here, the user reads a working output as proof their
    // broken edit was fine.
    paneWith({ stale: true, diagnostics: [shaderDiagnostic("error", "expected '}'")] });
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("stale");
    expect(status.textContent).toContain("last valid shader");
  });

  it("shows no stale notice while everything compiles", () => {
    paneWith();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("counts errors and warnings separately (§V27)", () => {
    paneWith({
      diagnostics: [
        shaderDiagnostic("error", "e1"),
        shaderDiagnostic("error", "e2"),
        shaderDiagnostic("warning", "w1"),
      ],
    });
    expect(screen.getByLabelText("2 errors")).toBeDefined();
    expect(screen.getByLabelText("1 warnings")).toBeDefined();
  });

  it("counts only THIS node's diagnostics, not the whole graph's", () => {
    // The strip sits above one node's source. A count that included the rest of the graph
    // would send the user hunting through a shader that is fine.
    paneWith({
      diagnostics: [
        shaderDiagnostic("error", "mine"),
        { severity: "error", code: "other", message: "someone else's", nodeId: "n2" },
      ],
    });
    expect(screen.getByLabelText("1 errors")).toBeDefined();
  });
});
