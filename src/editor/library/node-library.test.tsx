// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { testNodeDefinitions } from "@nodes/registry/test-nodes.ts";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { NodeLibrary } from "./node-library.tsx";
import { readNodeDragPayload } from "./drag-payload.ts";
import type { DragDataCarrier } from "./drag-payload.ts";
import type { NodeDefinition } from "@domain/types/node-definition.ts";

beforeAll(installDomStubs);
afterEach(cleanup);

const rgba = { kind: "texture2d", sample: "float", channels: 4 } as const;

function fakeDataTransfer(): DragDataCarrier & { effectAllowed: string } {
  const store = new Map<string, string>();
  return {
    effectAllowed: "none",
    setData: (format, data) => void store.set(format, data),
    getData: (format) => store.get(format) ?? "",
  };
}

describe("T39 — node library pane", () => {
  it("lists every registered node, grouped by category", () => {
    render(<NodeLibrary definitions={testNodeDefinitions} />);
    const filters = screen.getByRole("region", { name: "filter" });
    expect(within(filters).getByText("Blur")).toBeDefined();
    expect(screen.getByRole("region", { name: "generator" })).toBeDefined();
  });

  it("filters as the user types", () => {
    render(<NodeLibrary definitions={testNodeDefinitions} />);
    fireEvent.change(screen.getByLabelText("Search nodes"), { target: { value: "blur" } });
    expect(screen.getByText("Blur")).toBeDefined();
    expect(screen.queryByText("Solid")).toBeNull();
  });

  it("filters by category chip, and toggles the chip off again", () => {
    render(<NodeLibrary definitions={testNodeDefinitions} />);
    // T427: the chips live behind an on-demand trigger, so the category set cannot grow
    // into a permanent chip wall. Reaching them is one click, and the trigger names the
    // ACTIVE filter — asserted below, because a trigger that always reads "all" would
    // leave the user unable to tell what they are looking at.
    const openFilters = () =>
      fireEvent.click(screen.getByRole("button", { name: /^(Filter by category|Category: )/ }));
    openFilters();
    fireEvent.click(screen.getByRole("button", { name: "generator" }));
    expect(screen.queryByText("Blur")).toBeNull();
    expect(screen.getByRole("button", { name: "Category: generator" })).toBeDefined();
    openFilters();
    fireEvent.click(screen.getByRole("button", { name: "generator" }));
    expect(screen.getByText("Blur")).toBeDefined();
  });

  it("says so, in §V13's terms, when nothing matches a port drag", () => {
    render(
      <NodeLibrary
        definitions={testNodeDefinitions}
        portDrag={{ type: { kind: "matrix", columns: 4, rows: 4 }, direction: "output" }}
      />,
    );
    expect(screen.getByText(/insert a conversion node/i)).toBeDefined();
  });

  it("adds a node on click, through the caller's bus-backed handler (§V29)", () => {
    const onAddNode = vi.fn();
    render(<NodeLibrary definitions={testNodeDefinitions} onAddNode={onAddNode} />);
    fireEvent.click(screen.getByText("Blur"));
    expect(onAddNode).toHaveBeenCalledWith("test.blur");
  });

  it("a double-click adds exactly ONCE — the second click of the burst is not an add (T635)", () => {
    // The file-browser habit: a double-click is two click events, detail 1 then 2.
    // Treating both as adds stacked two identical nodes on one spot (the ~20-blur
    // pile-up was this gesture repeated). Single click is the stated gesture; the
    // burst's later clicks are swallowed, while deliberate separate clicks (each a
    // fresh burst, detail 1) still add one each.
    const onAddNode = vi.fn();
    render(<NodeLibrary definitions={testNodeDefinitions} onAddNode={onAddNode} />);
    const item = screen.getByText("Blur");
    fireEvent.click(item, { detail: 1 });
    fireEvent.click(item, { detail: 2 });
    expect(onAddNode).toHaveBeenCalledTimes(1);
    // A later, separate click is a new gesture and adds again.
    fireEvent.click(item, { detail: 1 });
    expect(onAddNode).toHaveBeenCalledTimes(2);
  });

  it("adds the top hit on Enter, so typing never needs a pointer (§V19)", () => {
    const onAddNode = vi.fn();
    render(<NodeLibrary definitions={testNodeDefinitions} onAddNode={onAddNode} />);
    const search = screen.getByLabelText("Search nodes");
    fireEvent.change(search, { target: { value: "blur" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onAddNode).toHaveBeenCalledWith("test.blur");
  });

  it("puts the node type on the drag, for the canvas to drop", () => {
    render(<NodeLibrary definitions={testNodeDefinitions} />);
    const dataTransfer = fakeDataTransfer();
    fireEvent.dragStart(screen.getByText("Blur"), { dataTransfer });
    expect(readNodeDragPayload(dataTransfer)).toEqual({ type: "test.blur" });
  });
});

/**
 * T427 (§V90). The owner's report was that the category badges "eat the top-left", and
 * the shape of the fix matters more than the pixels: a strip of one chip per category is
 * sized BY THE CATALOGUE, so shrinking today's twelve only buys time — at eighty node
 * types it is crowded again. What is gated here is therefore the BOUND, not the look.
 *
 * The fixture runs the same assertion at two catalogue sizes an order of magnitude
 * apart, because the claim is about GROWTH and one size can only ever report a count
 * (§V461): "three categories cost one control" is consistent with a wall that has not
 * grown yet. The chips live in a Radix PORTAL, so `container` is exactly the pane's own
 * chrome, and counting inside it is counting what sits in the top-left.
 *
 * NOT gated here: the popover's own ceiling, which is `max-height` + scroll on the
 * popover primitive. jsdom does no layout, so that one is verified in the running app.
 */
describe("T427 — the filter is bounded by the pane, not sized by the catalogue (§V90)", () => {
  function catalogueOf(categories: number): NodeDefinition[] {
    return Array.from({ length: categories }, (_, index) => ({
      type: `test.cat${index}`,
      version: 1,
      title: `Node ${index}`,
      category: `category-${String(index).padStart(2, "0")}`,
      inputs: [],
      outputs: [{ id: "out", label: "Out", type: rgba }],
      parameters: {},
      compile: () => ({ passes: [] }),
    }));
  }

  it("costs the pane ONE control at 3 categories and still ONE at 40", () => {
    for (const size of [3, 40]) {
      const { container } = render(<NodeLibrary definitions={catalogueOf(size)} />);
      // The trigger, and nothing else: `aria-pressed` is what a category chip carries,
      // so a strip of them in the toolbar would count here and does not.
      expect(container.querySelectorAll("[aria-expanded]")).toHaveLength(1);
      expect(container.querySelectorAll("[aria-pressed]")).toHaveLength(0);
      cleanup();
    }
  });

  it("moves the set out of the way without shrinking it — all 40 are one click away", () => {
    render(<NodeLibrary definitions={catalogueOf(40)} />);
    fireEvent.click(screen.getByRole("button", { name: "Filter by category" }));
    // 40 categories, plus "all" — which is the pressed one while nothing is filtered.
    expect(screen.getAllByRole("button", { pressed: false })).toHaveLength(40);
    expect(screen.getAllByRole("button", { pressed: true })).toHaveLength(1);
  });

  it("names the ACTIVE filter on the trigger, so the pane still says what it is showing", () => {
    render(<NodeLibrary definitions={catalogueOf(40)} />);
    fireEvent.click(screen.getByRole("button", { name: "Filter by category" }));
    fireEvent.click(screen.getByRole("button", { name: "category-07" }));
    const trigger = screen.getByRole("button", { name: "Category: category-07" });
    // One name, not a list: the trigger's label is O(1) in the catalogue too.
    expect(trigger.textContent).toBe("category-07");
    expect(screen.getByRole("region", { name: "category-07" })).toBeDefined();
  });
});

describe("§V13 — port-drag mode narrows the catalogue to what will actually connect", () => {
  const portDrag = { type: rgba, direction: "output" } as const;

  it("shows only exactly-compatible nodes, and names the type being dragged in a short, human label (T167)", () => {
    render(<NodeLibrary definitions={testNodeDefinitions} portDrag={portDrag} />);
    // Short label for the user, not the diagnostic-shaped `texture2d<float,4,linear>`.
    const chip = screen.getByText("RGBA texture");
    expect(chip).toBeDefined();
    expect(chip.textContent).not.toMatch(/[<>]/);
    // The precise, diagnostic-shaped form (§V57) is still reachable, as a tooltip.
    expect(chip.title).toBe("texture2d<float,4,linear>");
    expect(screen.getByText("Blur")).toBeDefined();
    expect(screen.getByText("Composite")).toBeDefined();
    // Near misses stay out: a different channel count or sample type is not "close".
    expect(screen.queryByText("Mono")).toBeNull();
    expect(screen.queryByText("Depth")).toBeNull();
    expect(screen.queryByText("Scalar f32")).toBeNull();
  });

  it("carries the port to wire on both the click and the drag", () => {
    const onAddNode = vi.fn();
    render(
      <NodeLibrary definitions={testNodeDefinitions} portDrag={portDrag} onAddNode={onAddNode} />,
    );

    fireEvent.click(screen.getByText("Blur"));
    expect(onAddNode).toHaveBeenCalledWith("test.blur", { portId: "source", direction: "input" });

    const dataTransfer = fakeDataTransfer();
    fireEvent.dragStart(screen.getByText("Blur"), { dataTransfer });
    expect(readNodeDragPayload(dataTransfer)).toEqual({
      type: "test.blur",
      connectTo: { portId: "source", direction: "input" },
    });
  });

  it("still narrows by search inside port-drag mode", () => {
    render(<NodeLibrary definitions={testNodeDefinitions} portDrag={portDrag} />);
    fireEvent.change(screen.getByLabelText("Search nodes"), { target: { value: "composite" } });
    expect(screen.getByText("Composite")).toBeDefined();
    expect(screen.queryByText("Blur")).toBeNull();
  });

  it("offers a way back to browsing", () => {
    const onClearPortDrag = vi.fn();
    render(
      <NodeLibrary
        definitions={testNodeDefinitions}
        portDrag={portDrag}
        onClearPortDrag={onClearPortDrag}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear port filter" }));
    expect(onClearPortDrag).toHaveBeenCalled();
  });
});
