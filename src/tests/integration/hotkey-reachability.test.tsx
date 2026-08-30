// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import { DEFAULT_BINDINGS } from "@editor/keymap/defaults.ts";
import { KEYMAP_CONTEXT_ATTRIBUTE, activeContextsFor, detectPlatform } from "@editor/keymap/index.ts";
import type { KeyContext } from "@editor/keymap/index.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { App } from "../../app/app.tsx";
import { createAppRuntime } from "../../app/app-runtime.ts";
import type { AppRuntime } from "../../app/app-runtime.ts";
import type { GpuStatus } from "../../app/gpu-status.ts";

/**
 * HOTKEY REACHABILITY (T430, §V351, B66).
 *
 * `keymap-dispatch.test.tsx` proves the other three quarters of a working hotkey:
 * the binding names a command, the command is on the mounted app's bus, and the
 * environment carries the selection the binding resolves its input from. Every one of
 * those was already true of `mod+a` on the day the owner reported that select-all does
 * nothing.
 *
 * What nothing checked is REACHABILITY: a `graph`-context binding only fires when the
 * event target resolves to the `graph` context, and that resolution runs
 * `target.closest('[data-keymap-context]')`. The graph pane declared the attribute and
 * could not hold focus, so a user who clicked the empty canvas — which is exactly what
 * you do before pressing select-all — left `document.activeElement` on `<body>`, the
 * lookup returned null, the fallback was `global`, and all 26 `graph` bindings were
 * unreachable.
 *
 * §V351 is why every test here presses its key at `document.activeElement` after a
 * pointer gesture a USER makes. A test that focuses the pane itself supplies the very
 * wiring under test and would have stayed green through the whole bug.
 */

/** jsdom has no layout engine and CodeMirror measures what it renders. */
function installCodeMirrorStubs(): void {
  const range = Range.prototype as unknown as Record<string, unknown>;
  range["getClientRects"] ??= () => ({
    length: 0,
    item: () => null,
    [Symbol.iterator]: function* () {},
  });
  range["getBoundingClientRect"] ??= () => ({
    x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}),
  });
}

beforeAll(() => {
  installDomStubs();
  installFlowStubs();
  installCodeMirrorStubs();
});
afterEach(cleanup);

const NO_WEBGPU: GpuStatus = { kind: "unavailable", reason: "No WebGPU in this environment." };
const MOD = detectPlatform() === "mac" ? { metaKey: true } : { ctrlKey: true };

function newRuntime(): AppRuntime {
  return createAppRuntime({
    identityStorage: null,
    actor: { kind: "human", id: "tester", label: "Tester" },
  });
}

async function mountWithNodes(count: number) {
  const runtime = newRuntime();
  const operations: GraphPatchOperation[] = Array.from({ length: count }, (_unused, index) => ({
    op: "addNode",
    ref: `$n${String(index)}`,
    type: "solid",
    position: { x: index * 220, y: 0 },
  }));
  await runtime.bus.execute(
    "graph.applyPatch",
    { baseRevision: runtime.bus.store.getRevision(), operations, label: "seed" },
    runtime.invocation,
  );
  const probe = () => Promise.resolve(NO_WEBGPU);
  const view = await act(async () =>
    render(<App runtime={runtime} storage={createMemoryStorage()} gpuProbe={probe} />),
  );
  return { runtime, container: view.container };
}

/**
 * What a user does before reaching for a shortcut: press the pointer down on the empty
 * canvas. Deliberately NOT `element.focus()` — where focus lands afterwards is the thing
 * under test (§V351).
 */
async function clickBackgroundOf(container: Element, selector: string): Promise<void> {
  const background = container.querySelector(selector);
  if (background === null) throw new Error(`no ${selector} to click`);
  await act(async () => {
    fireEvent.pointerDown(background, { button: 0, isPrimary: true });
    fireEvent.click(background);
  });
}

/** Where the browser will send the next keystroke. */
function focusTarget(): Element {
  return document.activeElement ?? document.body;
}

describe("§V351/B66 — select-all works from where a user leaves focus", () => {
  it("selects every node when mod+a is pressed after a click on the empty canvas", async () => {
    const { container } = await mountWithNodes(2);
    expect(container.querySelectorAll(".react-flow__node")).toHaveLength(2);

    await clickBackgroundOf(container, ".react-flow__pane");

    await act(async () => {
      fireEvent.keyDown(focusTarget(), { key: "a", ...MOD });
    });

    const selected = container.querySelectorAll(".react-flow__node.selected");
    expect(
      selected.length,
      "mod+a after clicking the empty canvas selected nothing — the `graph` context never matched",
    ).toBe(2);
  });

  it("consumes mod+a rather than letting the browser select the page's text as well", async () => {
    const { container } = await mountWithNodes(1);
    await clickBackgroundOf(container, ".react-flow__pane");

    // `fireEvent` returns false when a listener called preventDefault. Without it the
    // native select-all runs too and the whole UI ends up highlighted.
    const notPrevented = fireEvent.keyDown(focusTarget(), { key: "a", ...MOD });
    expect(notPrevented, "mod+a was dispatched but not consumed — the browser selects the page too").toBe(
      false,
    );
  });
});

/**
 * The other half of the fix, and the one that could quietly cost more than B66 did.
 *
 * Making the graph surface take focus on pointer-down is exactly the move that breaks
 * text entry: click into a field, the container grabs focus, and the next letter you type
 * fires a single-key graph binding instead of being typed. §V53 promises that never
 * happens, and the node's inline name editor is the only text field that lives INSIDE the
 * graph surface — so it is the only place that promise can actually be broken.
 */
describe("§V53 — taking focus for the graph context does not steal it from a field inside it", () => {
  it("leaves the node name editor focused, and types into it, when it is clicked", async () => {
    const { runtime, container } = await mountWithNodes(1);
    const node = container.querySelector(".react-flow__node");
    if (node === null) throw new Error("expected a node to render");
    await act(async () => {
      fireEvent.pointerDown(node, { button: 0, isPrimary: true });
      fireEvent.click(node);
    });

    // `n` opens the inline editor (T415). The key itself has to reach the graph context
    // first, which is the same reachability this file is about.
    await act(async () => {
      fireEvent.keyDown(focusTarget(), { key: "n" });
    });
    const editor = container.querySelector<HTMLInputElement>("input[data-testid^='node-name-input-']");
    expect(editor, "pressing `n` on a selected node opened no name editor").not.toBeNull();
    if (editor === null) return;

    // The gesture that would trigger the grab: a pointer-down landing IN the field from
    // outside it. Focus is deliberately elsewhere first — that is the real first click,
    // and it is the case where nothing else is holding the surface back.
    const surface = container.querySelector('[data-keymap-context="graph"]');
    await act(async () => {
      (document.activeElement as HTMLElement | null)?.blur();
      fireEvent.pointerDown(editor, { button: 0, isPrimary: true });
    });
    expect(
      document.activeElement,
      "the graph surface took focus on a pointer-down that was landing in the name editor",
    ).not.toBe(surface);

    // And `b` is a letter here, not TD's bypass.
    const nodeId = Object.keys(runtime.bus.store.getGraph().nodes)[0] ?? "";
    await act(async () => {
      fireEvent.keyDown(editor, { key: "b" });
    });
    expect(runtime.bus.store.getGraph().nodes[nodeId]?.ui?.bypassed).toBeUndefined();
  });
});

describe("§V351/T430 — every context a binding names is reachable by a user's click", () => {
  /**
   * `text` is excluded on purpose: it is derived from the event target (an `<input>`,
   * a `<textarea>`, a contenteditable), not from a container that has to hold focus.
   * `global` needs no container at all — it is the fallback.
   */
  const SCOPED_CONTEXTS: KeyContext[] = [
    ...new Set(
      DEFAULT_BINDINGS.map((binding) => binding.context).filter(
        (context) => context !== "global" && context !== "text",
      ),
    ),
  ].sort();

  /**
   * Where a user's pointer lands inside each pane when they are not aiming at a widget.
   * The graph's is React Flow's own background pane, not our container: a test that
   * clicked the container would be choosing a target the product never gets.
   */
  const BACKGROUND: Record<string, string> = { graph: ".react-flow__pane" };

  it("is reading the real binding table, or it is measuring nothing", () => {
    expect(SCOPED_CONTEXTS).toContain("graph");
    const scoped = DEFAULT_BINDINGS.filter((binding) => SCOPED_CONTEXTS.includes(binding.context));
    expect(scoped.length).toBeGreaterThan(20);
  });

  it("resolves to that context after a click on the pane's background", async () => {
    const { container } = await mountWithNodes(1);

    for (const context of SCOPED_CONTEXTS) {
      const pane = container.querySelector(`[${KEYMAP_CONTEXT_ATTRIBUTE}="${context}"]`);
      expect(pane, `no mounted surface declares the \`${context}\` keymap context`).not.toBeNull();

      const selector = BACKGROUND[context] ?? `[${KEYMAP_CONTEXT_ATTRIBUTE}="${context}"]`;
      await clickBackgroundOf(container, selector);

      // The same call the engine makes, with the same fallback the app supplies.
      const contexts = activeContextsFor(focusTarget(), "global");
      expect(
        contexts,
        `after clicking the ${context} pane's background, focus is on <${focusTarget().tagName.toLowerCase()}> and the \`${context}\` context does not resolve — every ${context} binding is dead`,
      ).toContain(context);
    }
  });
});
