// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import { DEFAULT_BINDINGS, detectPlatform } from "@editor/keymap/index.ts";
import { App } from "./app.tsx";
import { createAppRuntime } from "./app-runtime.ts";
import type { AppRuntime } from "./app-runtime.ts";
import type { GpuStatus } from "./gpu-status.ts";
import type { PaneWindow } from "./pane-window.tsx";

/**
 * T394 — fullscreen the viewer.
 *
 * Three things this has to keep true, each of which has already gone wrong once in this
 * project:
 *
 *  - the control is a bus command named by a keymap ROW (§V52, §V78, §V307), so it shows
 *    up in the shortcut editor and rebinds like everything else;
 *  - it is not gated on a GPU. §B48: `registerTransportCommands` sits inside an effect
 *    that returns early with no backend, so `space`, `.` and the top bar's buttons are
 *    all dead on a machine with no WebGPU. Every mount below has NO backend on purpose;
 *  - the request targets the document that CONTAINS the surface, so a viewer floated into
 *    its own window (§V97, T393) fullscreens that window and not the app's.
 *
 * jsdom implements none of the Fullscreen API, so the browser half is stubbed here — the
 * stub is the BROWSER, not the wiring: what it records is which element the app asked, and
 * in which document. `keymap-dispatch.test.tsx` is the registration gate on the real
 * composition root; this file is the behaviour.
 */

const NO_WEBGPU: GpuStatus = { kind: "unavailable", reason: "No WebGPU in this environment." };

interface FullscreenSpy {
  /** Elements asked to go fullscreen, in order. */
  readonly requests: Element[];
  exits: number;
  current: Element | null;
  /** The browser leaving fullscreen on its own — Escape, F11, the window's chrome. */
  escape(): void;
  reset(): void;
}

const spy: FullscreenSpy = {
  requests: [],
  exits: 0,
  current: null,
  escape() {
    const element = spy.current;
    if (element === null) return;
    spy.current = null;
    element.dispatchEvent(new Event("fullscreenchange", { bubbles: true }));
  },
  reset() {
    spy.requests.length = 0;
    spy.exits = 0;
    spy.current = null;
  },
};

function installFullscreenStub(): void {
  Object.defineProperty(Document.prototype, "fullscreenElement", {
    configurable: true,
    get(this: Document) {
      // Per spec, each document reports only its OWN fullscreen element. That is exactly
      // the distinction the float case turns on, so the stub has to honour it.
      return spy.current !== null && spy.current.ownerDocument === this ? spy.current : null;
    },
  });
  Element.prototype.requestFullscreen = function requestFullscreen(this: Element) {
    spy.requests.push(this);
    spy.current = this;
    this.dispatchEvent(new Event("fullscreenchange", { bubbles: true }));
    return Promise.resolve();
  };
  Document.prototype.exitFullscreen = function exitFullscreen(this: Document) {
    // Spec-accurate on purpose: exiting a document that is not itself in fullscreen
    // REJECTS. That is the only way a request aimed at the wrong document is visible at
    // all — `element.requestFullscreen()` always uses the element's own document, so the
    // document a caller picked only shows up in the state it reads back and the exit it
    // asks for.
    if (this.fullscreenElement === null) {
      return Promise.reject(new TypeError("Document not active for fullscreen."));
    }
    spy.exits += 1;
    spy.escape();
    return Promise.resolve();
  };
}

beforeAll(() => {
  installDomStubs();
  installFlowStubs();
  installFullscreenStub();
});
beforeEach(() => spy.reset());
afterEach(cleanup);

function newRuntime(): AppRuntime {
  return createAppRuntime({
    identityStorage: null,
    actor: { kind: "human", id: "tester", label: "Tester" },
  });
}

async function mountApp(options: { openPaneWindow?: (request: { name: string }) => PaneWindow | null } = {}) {
  const runtime = newRuntime();
  await act(async () => {
    render(
      <App
        runtime={runtime}
        storage={createMemoryStorage()}
        gpuProbe={() => Promise.resolve(NO_WEBGPU)}
        {...(options.openPaneWindow === undefined ? {} : { openPaneWindow: options.openPaneWindow })}
      />,
    );
  });
  return runtime;
}

function surfaceElement(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[data-testid="viewer-surface"]');
  if (element === null) throw new Error("the viewer surface is not mounted");
  return element;
}

function fullscreenButton(): HTMLButtonElement {
  const button = document
    .querySelector<HTMLButtonElement>('[data-testid="viewer-fullscreen"]');
  if (button === null) throw new Error("the viewer has no fullscreen control");
  return button;
}

describe("T394 — fullscreen the viewer", () => {
  it("binds the control in the KEYMAP, so it rebinds and appears in the shortcut editor", () => {
    const binding = DEFAULT_BINDINGS.find((entry) => entry.id === "view.fullscreen");
    expect(binding, "no default binding for fullscreen — the key would be hardcoded").toBeDefined();
    expect(binding?.command).toBe("view.toggleFullscreen");
    expect(binding?.context).toBe("global");
  });

  it("registers the command with NO GPU backend — §B48's shape, not repeated", async () => {
    const runtime = await mountApp();
    expect(
      runtime.bus.hasCommand("view.toggleFullscreen"),
      "unregistered at a GPU-less mount: the key AND the button would both be dead",
    ).toBe(true);
    expect(fullscreenButton().disabled).toBe(false);
    runtime.dispose();
  });

  it("fullscreens the viewer's surface from the bound key", async () => {
    const runtime = await mountApp();
    const surface = surfaceElement();

    // The bound chord, resolved from the table rather than typed in here.
    const mac = detectPlatform() === "mac";
    await act(async () => {
      fireEvent.keyDown(window, {
        key: "F",
        code: "KeyF",
        shiftKey: true,
        metaKey: mac,
        ctrlKey: !mac,
      });
    });

    await waitFor(() => expect(spy.requests).toEqual([surface]));
    runtime.dispose();
  });

  it("toggles back out, and the label follows the browser rather than the click", async () => {
    const user = userEvent.setup();
    const runtime = await mountApp();
    const surface = surfaceElement();

    await user.click(fullscreenButton());
    await waitFor(() => expect(spy.requests).toEqual([surface]));
    await waitFor(() => expect(fullscreenButton().getAttribute("aria-pressed")).toBe("true"));

    await user.click(fullscreenButton());
    await waitFor(() => expect(spy.exits).toBe(1));
    await waitFor(() => expect(fullscreenButton().getAttribute("aria-pressed")).toBe("false"));
    runtime.dispose();
  });

  it("follows the browser out of fullscreen when Escape does it behind our back", async () => {
    const user = userEvent.setup();
    const runtime = await mountApp();

    await user.click(fullscreenButton());
    await waitFor(() => expect(fullscreenButton().getAttribute("aria-pressed")).toBe("true"));

    // Escape is the browser's, not ours: it never runs the command. A control whose state
    // is set by the click desyncs here and then reads "leave fullscreen" over a window
    // that already left.
    await act(async () => spy.escape());

    expect(fullscreenButton().getAttribute("aria-pressed")).toBe("false");
    expect(spy.exits, "our exit path ran — then this proves nothing about Escape").toBe(0);
    runtime.dispose();
  });

  /**
   * T813 — the owner's gesture: "double click to fullscreen would be a neat thing for
   * both viewer and floating viewer anyway". A pointer gesture on the surface needs no
   * chrome and no keymap to reach a floated window, so the SAME handler is the whole of
   * the perform-mode entry. The guard is the half that can silently rot: an orbit nudge
   * that the browser still counts as two clicks must not fling the pane fullscreen.
   */
  it("double-click on the surface toggles fullscreen (T813)", async () => {
    const runtime = await mountApp();
    const surface = surfaceElement();

    await act(async () => {
      fireEvent.pointerDown(surface, { clientX: 10, clientY: 10 });
      fireEvent.pointerUp(surface, { clientX: 10, clientY: 10 });
      fireEvent.doubleClick(surface, { clientX: 10, clientY: 10 });
    });

    await waitFor(() => expect(spy.requests).toEqual([surface]));
    runtime.dispose();
  });

  it("a drag's tail never fullscreens: past the 3px threshold the double-click is suppressed", async () => {
    const runtime = await mountApp();
    const surface = surfaceElement();

    await act(async () => {
      // An orbit-sized nudge: down at 10, up at 40 — far past DRAG_THRESHOLD_PX, close
      // enough in time that a browser could still synthesize a dblclick from its clicks.
      fireEvent.pointerDown(surface, { clientX: 10, clientY: 10 });
      fireEvent.pointerUp(surface, { clientX: 40, clientY: 10 });
      fireEvent.doubleClick(surface, { clientX: 40, clientY: 10 });
    });

    expect(spy.requests).toEqual([]);
    runtime.dispose();
  });

  it("targets the CHILD document once the viewer is floated into its own window (T393)", async () => {
    // delay: null and a widened budget: this test mounts the full App and walks three
    // real clicks; under a parallel suite the default 5s timeout flaked for three
    // different sessions before anyone fixed the clock instead of re-attributing it.
    const user = userEvent.setup({ delay: null });
    const childDocument = document.implementation.createHTMLDocument("floated viewer");
    const child: PaneWindow = {
      document: childDocument,
      addEventListener: () => {},
      removeEventListener: () => {},
      close: () => {},
    };
    const runtime = await mountApp({ openPaneWindow: () => child });

    const surface = surfaceElement();
    await user.click(screen.getByRole("tab", { name: "viewer" }));
    await user.click(screen.getByRole("button", { name: "Move viewer" }));
    await user.click(screen.getByRole("button", { name: "Float in its own window" }));
    await act(async () => {
      await Promise.resolve();
    });

    // The pane's live DOM really moved — otherwise the assertion below is vacuous.
    expect(surface.ownerDocument, "the viewer never reached the child window").toBe(childDocument);

    const button = childDocument.querySelector<HTMLButtonElement>('[data-testid="viewer-fullscreen"]');
    expect(button, "the floated viewer lost its fullscreen control").not.toBeNull();
    // React attaches its listeners to the PORTAL container, which is the element that
    // moved — so a click inside the floated window still reaches the same handler.
    await act(async () => {
      button?.click();
    });

    await waitFor(() => expect(spy.requests).toEqual([surface]));
    // The request went to the document that CONTAINS the element. The app's own document
    // knows nothing about it — which is exactly why the state must be read from the
    // child's document and not from the app's.
    expect(spy.requests[0]?.ownerDocument).toBe(childDocument);
    expect(document.fullscreenElement).toBeNull();
    expect(childDocument.fullscreenElement).toBe(surface);

    // And back out again. This is where a command that read `document.fullscreenElement`
    // instead of the element's own would show itself: the app's document reports null, so
    // it would ask for fullscreen a SECOND time and try to exit a document that never
    // entered one.
    await act(async () => {
      button?.click();
    });
    await waitFor(() => expect(spy.exits).toBe(1));
    expect(spy.requests, "asked for fullscreen again instead of leaving it").toEqual([surface]);
    expect(childDocument.fullscreenElement).toBeNull();
    runtime.dispose();
  }, 20_000);

  it("target 'app' fullscreens the DOCUMENT ELEMENT — the whole app, browser bar gone (T551)", async () => {
    const runtime = await mountApp();
    await act(async () => {
      await runtime.bus.execute("view.toggleFullscreen", { target: "app" }, runtime.invocation);
    });
    await waitFor(() => expect(spy.requests).toEqual([document.documentElement]));
    runtime.dispose();
  });

  it("the DEFAULT target is still the viewer — T394's behaviour is unchanged (T551)", async () => {
    const runtime = await mountApp();
    const surface = surfaceElement();
    await act(async () => {
      await runtime.bus.execute("view.toggleFullscreen", {}, runtime.invocation);
    });
    await waitFor(() => expect(spy.requests).toEqual([surface]));
    runtime.dispose();
  });

  it("binds the app target to its own rebindable key (T551, §V307)", () => {
    const binding = DEFAULT_BINDINGS.find((entry) => entry.id === "view.fullscreenApp");
    expect(binding?.command).toBe("view.toggleFullscreen");
    expect(binding?.input).toEqual({ target: "app" });
    expect(binding?.keys.length).toBeGreaterThan(0);
  });

  it("refuses by NAME where the browser has no Fullscreen API (§V288)", async () => {
    const runtime = await mountApp();
    const surface = surfaceElement();
    const request = surface.requestFullscreen;
    // Not a browser that has it. The honest answer is a named diagnostic, never a
    // reported state change that did not happen.
    (surface as unknown as { requestFullscreen?: unknown }).requestFullscreen = undefined;

    const result = await act(async () =>
      runtime.bus.execute("view.toggleFullscreen", {}, runtime.invocation),
    );

    expect(result.status).toBe("rejected");
    expect(result.diagnostics?.map((entry) => entry.code)).toContain("view.fullscreenUnsupported");
    (surface as unknown as { requestFullscreen?: unknown }).requestFullscreen = request;
    runtime.dispose();
  });
});
