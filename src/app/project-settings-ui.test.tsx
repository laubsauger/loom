// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import { DEFAULT_PROJECT_FPS } from "@domain/types/graph.ts";
import { App } from "./app.tsx";
import { createAppRuntime } from "./app-runtime.ts";
import type { AppRuntime } from "./app-runtime.ts";
import type { GpuStatus } from "./gpu-status.ts";

/**
 * Project settings, in the composed app (T266, §V177, §V29).
 *
 * The owner asked for target fps and resolution controls a long time ago. The assertions
 * that matter are not "a dialog opens" — they are that an edit reaches the DOCUMENT
 * through the one mutation path, that the number the user typed is the number stored, and
 * that a field commits when they are done with it rather than on every keystroke.
 */

beforeAll(() => {
  installDomStubs();
  installFlowStubs();
});
afterEach(cleanup);

const NO_GPU: GpuStatus = { kind: "unavailable", reason: "No WebGPU in this environment." };

function newRuntime(): AppRuntime {
  return createAppRuntime({
    identityStorage: null,
    actor: { kind: "human", id: "tester", label: "Tester" },
  });
}

async function mount(runtime: AppRuntime) {
  await act(async () => {
    render(
      <App runtime={runtime} storage={createMemoryStorage()} gpuProbe={() => Promise.resolve(NO_GPU)} />,
    );
  });
  await act(async () => {
    fireEvent.click(screen.getByTestId("open-project-settings"));
  });
}

const field = (label: string): HTMLInputElement =>
  screen.getByLabelText(label) as HTMLInputElement;

describe("T266 — the settings a user asked for are reachable and land in the document", () => {
  it("opens from the top bar and shows the project's live values", async () => {
    const runtime = newRuntime();
    await mount(runtime);
    expect(screen.getByTestId("project-settings")).toBeDefined();
    expect(field("target fps").value).toBe(String(DEFAULT_PROJECT_FPS));
    expect(field("width").value).toBe(String(runtime.settings.outputResolution.width));
    runtime.dispose();
  });

  it("writes target fps to the DOCUMENT, through the command (§V29)", async () => {
    const runtime = newRuntime();
    await mount(runtime);
    const before = runtime.bus.store.getRevision();

    await act(async () => {
      fireEvent.change(field("target fps"), { target: { value: "30" } });
      fireEvent.blur(field("target fps"));
    });

    // Document state, not component state: the store has it and the revision moved
    // (§V177), which is what makes it save, autosave and undo like any other edit.
    expect(runtime.settings.fps).toBe(30);
    expect(runtime.bus.store.getRevision()).toBeGreaterThan(before);
    runtime.dispose();
  });

  it("commits on blur, not on every keystroke", async () => {
    const runtime = newRuntime();
    await mount(runtime);
    const before = runtime.bus.store.getRevision();

    // Typing 1280 one character at a time would otherwise apply 1, then 12, then 128 —
    // three recompiles at sizes nobody asked for, on the way to the one they did.
    await act(async () => {
      fireEvent.change(field("width"), { target: { value: "1" } });
      fireEvent.change(field("width"), { target: { value: "12" } });
      fireEvent.change(field("width"), { target: { value: "128" } });
      fireEvent.change(field("width"), { target: { value: "1280" } });
    });
    expect(runtime.bus.store.getRevision()).toBe(before);

    await act(async () => {
      fireEvent.blur(field("width"));
    });
    expect(runtime.settings.outputResolution.width).toBe(1280);
    runtime.dispose();
  });

  it("reverts on Escape rather than committing a half-typed number", async () => {
    const runtime = newRuntime();
    await mount(runtime);
    const original = runtime.settings.outputResolution.height;

    await act(async () => {
      fireEvent.change(field("height"), { target: { value: "9" } });
      fireEvent.keyDown(field("height"), { key: "Escape" });
    });

    expect(field("height").value).toBe(String(original));
    expect(runtime.settings.outputResolution.height).toBe(original);
    runtime.dispose();
  });

  it("keeps the OTHER half of the resolution when one is edited", async () => {
    const runtime = newRuntime();
    await mount(runtime);
    const height = runtime.settings.outputResolution.height;

    await act(async () => {
      fireEvent.change(field("width"), { target: { value: "640" } });
      fireEvent.keyDown(field("width"), { key: "Enter" });
    });

    // Width and height are one field in the document; editing one must not drop the other.
    expect(runtime.settings.outputResolution).toEqual({ width: 640, height });
    runtime.dispose();
  });

  it("changes the working format, which is a structural edit", async () => {
    const runtime = newRuntime();
    await mount(runtime);
    await act(async () => {
      fireEvent.change(screen.getByLabelText("working format"), {
        target: { value: "rgba8unorm" },
      });
    });
    expect(runtime.settings.workingFormat).toBe("rgba8unorm");
    runtime.dispose();
  });

  it("clamps to the project's own limit rather than accepting an impossible size", async () => {
    const runtime = newRuntime();
    await mount(runtime);
    const max = runtime.settings.limits.maxResolution;

    await act(async () => {
      fireEvent.change(field("width"), { target: { value: String(max * 4) } });
      fireEvent.blur(field("width"));
    });

    // §V24: the caps are the project's, so the control offers what the project allows
    // instead of a value the compiler would refuse afterwards.
    expect(runtime.settings.outputResolution.width).toBe(max);
    runtime.dispose();
  });
});
