// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import { nodeTypeLabelStore } from "@editor/nodes/node-type-labels.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { App } from "../../app/app.tsx";
import { createAppRuntime } from "../../app/app-runtime.ts";
import type { AppRuntime } from "../../app/app-runtime.ts";
import type { GpuStatus } from "../../app/gpu-status.ts";

/**
 * CAN A USER ACTUALLY RENAME A NODE (B60, §V220, §V342, T415)?
 *
 * ## What this gate refuses to assume
 *
 * `node.rename` was registered on the bus, bound to `n`, and listed in the node context
 * menu as "Rename…" with an ellipsis promising a prompt — and the command was invokable by
 * nobody, because no surface in the entire tree collected the `label` it takes. Every unit
 * suite involved was green: `node-output-commands.test.ts` calls `bus.execute("node.rename",
 * { nodeId, label })` and proves the command works, which was never in doubt; the keymap
 * suite proves `n` names it; the menu suite proves the item exists. Each of them SUPPLIES
 * the wiring it is testing, so the one thing none of them can observe is whether anything
 * else supplies it.
 *
 * §V342 is the correction: registration proves nothing about invocability, and a gate for a
 * command taking a user-supplied argument must find the SURFACE that supplies it.
 *
 * So this file mounts the real `<App>` and supplies NOTHING — no context value, no bus
 * command, no store, no fixture rename. It uses the app's own registry, its own keymap, its
 * own canvas, and it types into whatever the app puts on screen. If the argument-collecting
 * surface is missing or unmounted, every case here fails.
 *
 * ## What it does not cover
 *
 * jsdom paints nothing (§V339). Nothing here is evidence that the input BOX is visible,
 * legible, or correctly sized inside a 178px title bar; it is evidence that the element
 * exists, takes text, and that the text reaches the document through `node.rename`. The
 * geometry of the header row at real widths and zooms is not asserted anywhere and is
 * reported as uncovered.
 */

beforeAll(() => {
  installDomStubs();
  installFlowStubs();
});
afterEach(() => {
  cleanup();
  // The type-label preference is per-person chrome in `localStorage`, so it is genuinely
  // shared across mounts; leaving it off would silently disarm the T416 cases below.
  nodeTypeLabelStore().set(true);
});

const NO_WEBGPU: GpuStatus = { kind: "unavailable", reason: "No WebGPU in this environment." };

function newRuntime(): AppRuntime {
  return createAppRuntime({
    identityStorage: null,
    actor: { kind: "human", id: "tester", label: "Tester" },
  });
}

async function seed(runtime: AppRuntime, operations: GraphPatchOperation[]) {
  return runtime.bus.execute(
    "graph.applyPatch",
    { baseRevision: runtime.bus.store.getRevision(), operations, label: "seed" },
    runtime.invocation,
  );
}

/** The real app, around real nodes from the real registry. */
async function mountWithNodes(types: readonly string[]) {
  const runtime = newRuntime();
  const seeded = await seed(
    runtime,
    types.map((type, index) => ({
      op: "addNode" as const,
      ref: `$n${index}`,
      type,
      position: { x: index * 240, y: 0 },
    })),
  );
  const ids = types.map((_type, index) => seeded.output.createdIds[`$n${index}`] as string);
  const probe = () => Promise.resolve(NO_WEBGPU);
  const view = await act(async () =>
    render(<App runtime={runtime} storage={createMemoryStorage()} gpuProbe={probe} />),
  );
  return { runtime, ids, container: view.container };
}

const nameOf = (container: Element, id: string) =>
  container.querySelector(`[data-testid="node-name-${id}"]`);
const inputOf = (container: Element, id: string) =>
  container.querySelector<HTMLInputElement>(`[data-testid="node-name-input-${id}"]`);
const errorOf = (container: Element, id: string) =>
  container.querySelector(`[data-testid="node-name-error-${id}"]`);
const typeOf = (container: Element, id: string) =>
  container.querySelector(`[data-testid="node-type-${id}"]`);

async function type(input: HTMLInputElement, text: string) {
  await act(async () => {
    fireEvent.change(input, { target: { value: text } });
  });
}

async function press(element: Element, key: string) {
  await act(async () => {
    fireEvent.keyDown(element, { key });
  });
}

describe("the node title is an editable field (T415, B60)", () => {
  it("double-clicking the title opens an editor holding the current name", async () => {
    const { ids, container } = await mountWithNodes(["solid"]);
    const [id] = ids as [string];

    expect(inputOf(container, id)).toBeNull();
    const title = nameOf(container, id);
    expect(title).not.toBeNull();
    await act(async () => {
      fireEvent.doubleClick(title as Element);
    });

    const input = inputOf(container, id);
    expect(input).not.toBeNull();
    expect(input?.value).toBe("solid1");
  });

  it("Enter commits the typed name to the DOCUMENT and closes the editor", async () => {
    const { runtime, ids, container } = await mountWithNodes(["solid"]);
    const [id] = ids as [string];

    await act(async () => {
      fireEvent.doubleClick(nameOf(container, id) as Element);
    });
    const input = inputOf(container, id) as HTMLInputElement;
    await type(input, "Bloom pass");
    await press(input, "Enter");

    await waitFor(() => {
      expect(runtime.bus.store.getGraph().nodes[id]?.label).toBe("Bloom pass");
    });
    await waitFor(() => {
      expect(inputOf(container, id)).toBeNull();
    });
    expect(nameOf(container, id)?.textContent).toBe("Bloom pass");
  });

  it("Escape cancels and restores the name the node had", async () => {
    const { runtime, ids, container } = await mountWithNodes(["solid"]);
    const [id] = ids as [string];
    const before = runtime.bus.store.getRevision();

    await act(async () => {
      fireEvent.doubleClick(nameOf(container, id) as Element);
    });
    const input = inputOf(container, id) as HTMLInputElement;
    await type(input, "Discarded");
    await press(input, "Escape");

    expect(inputOf(container, id)).toBeNull();
    expect(nameOf(container, id)?.textContent).toBe("solid1");
    expect(runtime.bus.store.getGraph().nodes[id]?.label).toBe("solid1");
    // Not even a rejected command: a cancel produces no revision at all (§V33).
    expect(runtime.bus.store.getRevision()).toBe(before);
  });

  it("blur commits, like every other deferred field in the app", async () => {
    const { runtime, ids, container } = await mountWithNodes(["solid"]);
    const [id] = ids as [string];

    await act(async () => {
      fireEvent.doubleClick(nameOf(container, id) as Element);
    });
    const input = inputOf(container, id) as HTMLInputElement;
    await type(input, "Backdrop");
    await act(async () => {
      fireEvent.blur(input);
    });

    await waitFor(() => {
      expect(runtime.bus.store.getGraph().nodes[id]?.label).toBe("Backdrop");
    });
  });

  /**
   * §V325 — an explicit name is REFUSED on collision, never suffixed. This asserts the
   * WHOLE consequence at the surface: the document is untouched, the editor stays open
   * holding what the user typed, and the message says which name is taken (§V288).
   */
  it("refuses a name that is taken, keeps the text, and says what is taken", async () => {
    const { runtime, ids, container } = await mountWithNodes(["solid", "solid"]);
    const [first, second] = ids as [string, string];
    expect(runtime.bus.store.getGraph().nodes[first]?.label).toBe("solid1");

    await act(async () => {
      fireEvent.doubleClick(nameOf(container, second) as Element);
    });
    const input = inputOf(container, second) as HTMLInputElement;
    await type(input, "solid1");
    await press(input, "Enter");

    await waitFor(() => {
      expect(errorOf(container, second)).not.toBeNull();
    });
    expect(errorOf(container, second)?.textContent).toContain("solid1");
    // Not renamed, and NOT silently minted as `solid12` either.
    expect(runtime.bus.store.getGraph().nodes[second]?.label).toBe("solid2");
    expect(inputOf(container, second)?.value).toBe("solid1");
  });

  it("refuses a blank name by name rather than clearing the node's identity", async () => {
    const { runtime, ids, container } = await mountWithNodes(["solid"]);
    const [id] = ids as [string];

    await act(async () => {
      fireEvent.doubleClick(nameOf(container, id) as Element);
    });
    const input = inputOf(container, id) as HTMLInputElement;
    await type(input, "   ");
    await press(input, "Enter");

    await waitFor(() => {
      expect(errorOf(container, id)).not.toBeNull();
    });
    expect(runtime.bus.store.getGraph().nodes[id]?.label).toBe("solid1");
  });

  /**
   * §V128/§V316 — a rename repoints every reference naming that node, in the same patch,
   * and the inline editor gets that for free BECAUSE it runs `node.rename` rather than
   * writing a `setNodeLabel` of its own (§V61). Asserted here rather than trusted: a
   * second rename path is exactly how this clause would come undone.
   */
  it("rewrites an expression reference to the old name, from the inline editor", async () => {
    const { runtime, ids, container } = await mountWithNodes(["solid", "blur"]);
    const [source, consumer] = ids as [string, string];
    await seed(runtime, [
      {
        op: "setParameters",
        nodeId: consumer,
        parameters: {
          size: {
            mode: "expression",
            bindings: {
              expression: { kind: "expression", source: "op('solid1').par.size * 2" },
            },
          },
        } as never,
      },
    ]);

    await act(async () => {
      fireEvent.doubleClick(nameOf(container, source) as Element);
    });
    const input = inputOf(container, source) as HTMLInputElement;
    await type(input, "backdrop");
    await press(input, "Enter");

    await waitFor(() => {
      expect(runtime.bus.store.getGraph().nodes[source]?.label).toBe("backdrop");
    });
    const rewritten = runtime.bus.store.getGraph().nodes[consumer]?.parameters["size"] as {
      bindings: { expression: { source: string } };
    };
    expect(rewritten.bindings.expression.source).toBe("op('backdrop').par.size * 2");
  });
});

/**
 * THE KEYSTROKE, which is the half B60 was actually about: `n` was bound, dispatched, and
 * reached a command that could do nothing with what the binding sent it.
 */
describe("`n` opens the editor on the selected node (B60, §V342)", () => {
  it("selects a node, presses n, and gets a field it can type into", async () => {
    const { runtime, ids, container } = await mountWithNodes(["solid"]);
    const [id] = ids as [string];
    const element = container.querySelector(".react-flow__node") as Element;

    await act(async () => {
      fireEvent.click(element);
    });
    await press(element, "n");

    await waitFor(() => {
      expect(inputOf(container, id)).not.toBeNull();
    });
    const input = inputOf(container, id) as HTMLInputElement;
    await type(input, "Keyed");
    await press(input, "Enter");
    await waitFor(() => {
      expect(runtime.bus.store.getGraph().nodes[id]?.label).toBe("Keyed");
    });
  });

  /**
   * §V53, asserted rather than assumed: while the field has focus, the single-key graph
   * bindings must not fire. `b` is TD's bypass and the loudest possible failure — typing a
   * name containing a b would otherwise silently bypass the node being renamed.
   */
  it("typing in the field does not fire graph keybindings", async () => {
    const { runtime, ids, container } = await mountWithNodes(["solid"]);
    const [id] = ids as [string];
    const element = container.querySelector(".react-flow__node") as Element;

    await act(async () => {
      fireEvent.click(element);
    });
    await press(element, "n");
    const input = await waitFor(() => {
      const found = inputOf(container, id);
      expect(found).not.toBeNull();
      return found as HTMLInputElement;
    });

    await press(input, "b");
    await press(input, "d");
    await press(input, "r");

    expect(runtime.bus.store.getGraph().nodes[id]?.ui?.bypassed).toBeUndefined();
    expect(runtime.bus.store.getGraph().nodes[id]?.ui?.muted).toBeUndefined();
    expect(runtime.bus.store.getGraph().nodes[id]?.ui?.preview).toBeUndefined();
    // And the same keys DO act on the node once the editor is closed, so the assertion
    // above is about the field and not about a dead binding.
    await press(input, "Escape");
    await press(element, "b");
    await waitFor(() => {
      expect(runtime.bus.store.getGraph().nodes[id]?.ui?.bypassed).toBe(true);
    });
  });
});

/**
 * T416 — the TYPE beside the name.
 *
 * §V339 applies and is not dodged: these assert PRESENCE and TEXT, which jsdom can answer,
 * and say nothing about whether the chip is legible beside a name in a 178px title bar. It
 * is styled to give up its width before the name does, and that is a claim only a real
 * browser can check. Reported as uncovered.
 */
describe("the node type beside the name (T416)", () => {
  it("shows nothing extra while the name still carries the type", async () => {
    const { ids, container } = await mountWithNodes(["solid"]);
    const [id] = ids as [string];
    // `solid1` IS the type, so a chip reading "Solid" beside it is the same word twice.
    expect(nameOf(container, id)?.textContent).toBe("solid1");
    expect(typeOf(container, id)).toBeNull();
  });

  it("shows the type once a rename has taken the identification away", async () => {
    const { ids, container } = await mountWithNodes(["solid"]);
    const [id] = ids as [string];

    await act(async () => {
      fireEvent.doubleClick(nameOf(container, id) as Element);
    });
    const input = inputOf(container, id) as HTMLInputElement;
    await type(input, "Backdrop");
    await press(input, "Enter");

    await waitFor(() => {
      expect(typeOf(container, id)).not.toBeNull();
    });
    expect(typeOf(container, id)?.textContent).toBe("Solid");
  });

  /**
   * The SETTING, at the composed surface — the half that would otherwise be a store with
   * no reachable control, which is §V220 wearing a preference (§V233's shape: a switch
   * nothing can flip is not a setting).
   */
  it("is switched off from the settings dialog the app actually mounts", async () => {
    const { ids, container } = await mountWithNodes(["solid"]);
    const [id] = ids as [string];
    await act(async () => {
      fireEvent.doubleClick(nameOf(container, id) as Element);
    });
    await type(inputOf(container, id) as HTMLInputElement, "Backdrop");
    await press(inputOf(container, id) as HTMLInputElement, "Enter");
    await waitFor(() => {
      expect(typeOf(container, id)).not.toBeNull();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("open-project-settings"));
    });
    const toggle = screen.getByLabelText("Show each node's type beside its name");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      fireEvent.click(toggle);
    });

    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await waitFor(() => {
      expect(typeOf(container, id)).toBeNull();
    });
  });

  it("the setting hides it, and the name is untouched", async () => {
    const { ids, container } = await mountWithNodes(["solid"]);
    const [id] = ids as [string];
    await act(async () => {
      fireEvent.doubleClick(nameOf(container, id) as Element);
    });
    await type(inputOf(container, id) as HTMLInputElement, "Backdrop");
    await press(inputOf(container, id) as HTMLInputElement, "Enter");
    await waitFor(() => {
      expect(typeOf(container, id)).not.toBeNull();
    });

    await act(async () => {
      nodeTypeLabelStore().set(false);
    });

    expect(typeOf(container, id)).toBeNull();
    expect(nameOf(container, id)?.textContent).toBe("Backdrop");
  });
});
