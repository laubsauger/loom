// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ViewerPane } from "./side-panes.tsx";
import { AppRuntimeContext } from "./app-context.ts";
import { createAppRuntime } from "./app-runtime.ts";
import { TooltipProvider } from "@ui/primitives/tooltip.tsx";
import { NO_FLATTENING } from "@domain/parameters/index.ts";
import { SINK_TARGET_PORT } from "@compiler/resources.ts";
import type { CompiledGraph } from "@compiler/index.ts";
import type { GraphDocument } from "@domain/types/graph.ts";

const native = vi.hoisted(() => ({ available: true, active: true, ready: true,
  status: "Native GPU: 1 published, 0 dropped; 533 rendered, 1 transferred", toggle: vi.fn() }));
const selections = vi.hoisted(() => [] as unknown[]);
vi.mock("./use-native-output.ts", () => ({ useNativeOutput: (_backend: unknown, selection: unknown) => {
  selections.push(selection); return native;
} }));
afterEach(cleanup);

describe("native output toolbar", () => {
  it("keeps changing diagnostic text out of toolbar layout and names the compact toggle", () => {
    const runtime = createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "test", label: "Test" } });
    try {
      render(<TooltipProvider><AppRuntimeContext.Provider value={runtime}>
        <ViewerPane compiled={null} graph={runtime.bus.store.getGraph()} backend={null} pointer={null} probe={undefined} liveReads={{ channels: () => undefined, flattening: () => NO_FLATTENING, frame: () => undefined }} />
      </AppRuntimeContext.Provider></TooltipProvider>);
      const button = screen.getByRole("button", { name: "Stop native SDR output" });
      expect(button.textContent).toBe("SDR");
      expect(button.getAttribute("aria-pressed")).toBe("true");
      expect(button.getAttribute("data-native-output-status")).toBe(native.status);
      expect(screen.queryByText(native.status)).toBeNull();
      expect(button.parentElement?.textContent).not.toContain(native.status);
      expect(screen.getByTestId("viewer-output-select")).toBeTruthy();
      expect(screen.getByTestId("viewer-fullscreen")).toBeTruthy();
    } finally { cleanup(); runtime.dispose(); }
  });
});

/*
 * VNB25: the viewer's SDR toggle sends what the Output node shows, as Syphon Out does. The
 * selection it hands the native session carries the encode decided from the space the
 * compiler published for the viewed output and the project's display transform.
 */
describe("native output selection", () => {
  it("encodes a linear viewed output, sends an encoded one as is, and follows the display transform", async () => {
    const runtime = createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "test", label: "Test" } });
    const graph: GraphDocument = { revision: 1, groups: {}, edges: {}, nodes: {
      output_main: { id: "output_main", type: "output", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} } } };
    const compiled = (format: string, space: string) => ({ outputs: [{ nodeId: "output_main", portId: SINK_TARGET_PORT,
      resourceId: "output_main:$target", resourceKind: "target", size: [4, 4], format, space, temporal: false }] }) as unknown as CompiledGraph;
    const pane = (plan: CompiledGraph) => <TooltipProvider><AppRuntimeContext.Provider value={runtime}>
      <ViewerPane compiled={plan} graph={graph} backend={null} pointer={null} probe={undefined} liveReads={{ channels: () => undefined, flattening: () => NO_FLATTENING, frame: () => undefined }} />
    </AppRuntimeContext.Provider></TooltipProvider>;
    const last = () => selections.at(-1);
    try {
      const view = render(pane(compiled("rgba16float", "encoded")));
      expect(last()).toEqual({ resourceId: "output_main:$target", size: [4, 4], encode: false });
      view.rerender(pane(compiled("rgba16float", "linear")));
      expect(last()).toEqual({ resourceId: "output_main:$target", size: [4, 4], encode: true });
      // An `-srgb` target is presented through a non-decoding view: already display bytes.
      view.rerender(pane(compiled("rgba8unorm-srgb", "linear")));
      expect(last()).toEqual({ resourceId: "output_main:$target", size: [4, 4], encode: false });
      const result = await runtime.bus.execute("project.setSettings",
        { settings: { colorPolicy: { workingSpace: "linear", displayTransform: "none" } } } as never, runtime.invocation);
      expect(result.status).toBe("applied");
      view.rerender(pane(compiled("rgba16float", "linear")));
      expect(last()).toEqual({ resourceId: "output_main:$target", size: [4, 4], encode: false });
    } finally { cleanup(); runtime.dispose(); }
  });
});
