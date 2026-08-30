// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import { App } from "../../app/app.tsx";
import { createAppRuntime } from "../../app/app-runtime.ts";
import type { GpuStatus } from "../../app/gpu-status.ts";

/**
 * IS THE BOUNDARY ACTUALLY BETWEEN THE APP AND ITS PANES (B79, §V220, §V342)?
 *
 * `error-boundary.test.tsx` proves the component contains a throw when something wraps
 * something. That is exactly the test this project has been burned by eighteen times: a
 * suite that SUPPLIES the wiring it is testing cannot observe whether anything else
 * supplies it. So this file supplies nothing. It mounts the real `<App>`, breaks a real
 * pane by making the module that pane renders throw, and asks the only question that
 * matters: is there still an app on the screen?
 *
 * Without the wrap in `app.tsx` the throw escapes to the root, `render` itself throws, and
 * every assertion below fails — which is the white screen, reproduced.
 *
 * ## What it does NOT prove
 *
 * §V339: jsdom paints nothing, so this is not evidence the failure panel is visible or
 * legible inside a pane's rectangle. And a boundary catches RENDER throws only — an
 * `onClick`/`onBlur` handler that throws is neither caught here nor a white screen in the
 * first place, so nothing in this file speaks to that case.
 */

vi.mock("../../app/side-panes.tsx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/side-panes.tsx")>();
  return {
    ...actual,
    // Stands in for whatever really throws — one pane's render, failing the way B79's
    // reporter saw. The identity of the bug is not the subject; the blast radius is.
    InspectorPane: () => {
      throw new Error("inspector exploded");
    },
  };
});

beforeAll(() => {
  installDomStubs();
  installFlowStubs();
});
afterEach(cleanup);

const NO_WEBGPU: GpuStatus = { kind: "unavailable", reason: "No WebGPU in this environment." };

describe("B79 — one pane's throw does not cost the app", () => {
  it("keeps the app mounted, names the failed pane, and leaves the graph standing", async () => {
    const runtime = createAppRuntime({
      identityStorage: null,
      actor: { kind: "human", id: "tester", label: "Tester" },
    });
    const view = await act(async () =>
      render(
        <App
          runtime={runtime}
          storage={createMemoryStorage()}
          gpuProbe={() => Promise.resolve(NO_WEBGPU)}
        />,
      ),
    );

    // The app is still on the screen. This single assertion is the whole bug: before the
    // boundary, the throw above unmounted the root and `container` was empty.
    expect(view.container.querySelector("[data-pane-host]")).not.toBeNull();
    // The other panes never even heard about it.
    expect(view.container.querySelector('[data-testid="graph-canvas"]')).not.toBeNull();

    // §V288 — the failure names itself where the pane was, instead of vanishing.
    const failure = screen.getByTestId("pane-error-Inspector");
    expect(failure.textContent).toContain("Inspector");
    expect(failure.textContent).toContain("inspector exploded");

    // And the document the user has not saved is exactly where it was.
    expect(runtime.bus.store.getRevision()).toBe(0);
  });
});
