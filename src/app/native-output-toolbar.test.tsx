// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ViewerPane } from "./side-panes.tsx";
import { AppRuntimeContext } from "./app-context.ts";
import { createAppRuntime } from "./app-runtime.ts";
import { TooltipProvider } from "@ui/primitives/tooltip.tsx";

const native = vi.hoisted(() => ({ available: true, active: true, ready: true,
  status: "Native GPU: 1 published, 0 dropped; 533 rendered, 1 transferred", toggle: vi.fn() }));
vi.mock("./use-native-output.ts", () => ({ useNativeOutput: () => native }));
afterEach(cleanup);

describe("native output toolbar", () => {
  it("keeps changing diagnostic text out of toolbar layout and names the compact toggle", () => {
    const runtime = createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "test", label: "Test" } });
    try {
      render(<TooltipProvider><AppRuntimeContext.Provider value={runtime}>
        <ViewerPane compiled={null} graph={runtime.bus.store.getGraph()} backend={null} pointer={null} probe={undefined} />
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
