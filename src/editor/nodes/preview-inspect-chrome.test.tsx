// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { createDomainBus } from "@domain/commands/index.ts";
import { createGraphStore } from "@domain/graph/store.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import { createSequentialIdFactory } from "@domain/graph/ids.ts";
import { createTestRegistry } from "@nodes/registry/test-nodes.ts";
import { CanvasFixture, fixtureContext, installFlowStubs, nodeProps } from "@editor/graph-canvas/testing.tsx";
import type { PreviewInspectSource } from "@editor/graph-canvas/canvas-context.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { NodeView } from "./node-view.tsx";

/**
 * T675 — THE INSPECTION CONTROL IS NOT INSIDE THE PREVIEW TILE, and it never can be again.
 *
 * ## The bug this gates, because it is not the one anyone was looking for
 *
 * The owner reported that they could not use camera controls on a geometry node. Geometry
 * has been orbitable since T561, so the first two explanations were both about loudness:
 * T664 had replaced a word with a 14px glyph at opacity 0.35 revealed on hover, and T669
 * had accepted the control vanishing on a suspended preview. Both were real and neither
 * was the cause. The owner found the cause by looking: "it maybe hidden behind the preview
 * or something."
 *
 * It is. The shared preview surface (`app/panes.module.css .previewSurface`, T185) is a
 * full-pane canvas at `--z-canvas-overlay` — 30 — and it composites each live tile at that
 * node's slot rect. Everything inside a node is sealed inside `.react-flow__viewport`,
 * which sets `z-index: 2` on a transformed element and therefore forms a stacking context
 * no descendant can escape. The toggle sat inside that at `z-index: 1`. 1 against 30,
 * across stacking contexts: the tile paints over the whole slot, so the control was
 * visible on tiles with NOTHING to inspect and gone on every tile that had something.
 *
 * ## Why this test is shaped like this and not like the obvious one
 *
 * §V461 has now caught this subsystem seven times (§V628 is the most recent), and the
 * shape is always the same: a fixture that cannot distinguish the fault. Three candidate
 * gates, and why two of them are blind:
 *
 *  - QUERY THE BUTTON AND CLICK IT — what T656's suite did. It passed throughout, because
 *    the surface carries `pointer-events: none`, so the button was invisible but still
 *    LIVE. A DOM query cannot see paint.
 *  - `elementFromPoint` AT THE CONTROL'S CENTRE — the obvious upgrade, and it is blind for
 *    exactly the same reason: hit testing SKIPS a `pointer-events: none` element, so it
 *    would return the button both before and after the fix. It would also need layout,
 *    which jsdom does not do. Recorded here so nobody reaches for it later thinking this
 *    file simply did not try.
 *  - THE CONTAINMENT RELATIONSHIP — what this file asserts. The tile is composited at the
 *    published rect of the node's preview slot, so "is this control inside the slot?" IS
 *    the occlusion question, restated in something a DOM can answer. It fails on the tree
 *    as it stood before T675 (the button was a child of the slot) and it fails again the
 *    moment anyone moves a control back in there.
 *
 * The invariant, stated once for whoever adds the next piece of preview chrome:
 * ANY CONTROL THAT MUST BE LEGIBLE OVER A LIVE TILE MUST BE RENDERED OUTSIDE THE NODE'S
 * PREVIEW SLOT. Inside it, it is painted over — silently, with every test still green.
 */

beforeAll(() => {
  installDomStubs();
  installFlowStubs();
});
afterEach(cleanup);

const NODE = "n1" as NodeId;

/** A stand-in for the pane's inspection store — the same three calls the header uses. */
function inspectSource(): PreviewInspectSource & { current: "home" | "adjustable" } {
  const listeners = new Set<() => void>();
  return {
    current: "home",
    mode() {
      return this.current;
    },
    setMode(_nodeId, next) {
      this.current = next;
      for (const listener of listeners) listener();
    },
    subscribe(_nodeId, listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** One node of a type whose output is previewable, against a real store (§V29). */
const GRAPH: GraphDocument = {
  revision: 1,
  nodes: {
    n1: { id: "n1", type: "test.blur", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
  },
  edges: {},
  groups: {},
};

function mount(options: { orbitable: boolean }) {
  const store = createGraphStore({ ids: createSequentialIdFactory("n"), initialGraph: GRAPH });
  const { bus } = createDomainBus({ store, registry: createTestRegistry().view() });
  const source = inspectSource();
  const { value } = fixtureContext({
    store: bus.store,
    registry: bus.registry,
    // The real slot's shape, minus the preview machinery: what matters here is that the
    // node renders a preview REGION at all, since that region is what a tile covers.
    renderPreview: () => <div data-testid={`preview-body-${NODE}`}>tile goes here</div>,
    previewInspect: () => (options.orbitable ? source : null),
  });
  render(
    <CanvasFixture value={value}>
      <NodeView {...nodeProps(NODE)} />
    </CanvasFixture>,
  );
  return { source };
}

describe("T675 — the inspection control is outside the tile it drives", () => {
  it("is NOT inside the preview slot the shared surface composites over", () => {
    mount({ orbitable: true });
    const control = screen.getByTestId(`preview-inspect-${NODE}`);
    const slot = screen.getByTestId(`node-preview-${NODE}`);

    // The whole gate, in one line. Before T675 this was `true` and every other assertion
    // in every other preview suite still passed.
    expect(slot.contains(control)).toBe(false);
  });

  it("is in the node's HEADER, beside the toggles the user already reads", () => {
    /*
     * Not merely "somewhere else". The header row is where P, B and M live, and being
     * beside them is what makes this control findable rather than merely present — the
     * failure T675 exists to fix was never that the control was missing.
     */
    mount({ orbitable: true });
    const control = screen.getByTestId(`preview-inspect-${NODE}`);
    const header = control.closest("header");
    expect(header).not.toBeNull();
    const labels = [...(header?.querySelectorAll("button") ?? [])].map(
      (button) => button.textContent,
    );
    expect(labels).toContain("C");
    expect(labels).toContain("P");
  });

  it("is ONE box in both states — no word, so no reflow (T664 survives the move)", () => {
    /*
     * T664's finding, carried over rather than dropped. The owner's report was "that
     * adjust button looks a bit wonk and huge": the label went HOME -> ADJUST, six
     * characters where there had been four, so the control grew by half the moment it was
     * pressed while its own CSS claimed state was carried by tone and never by size. The
     * claim is asserted here instead of commented — the rendered content must not vary
     * with the mode, which a one-letter label gives for free in any locale.
     */
    const { source } = mount({ orbitable: true });
    const control = screen.getByTestId(`preview-inspect-${NODE}`);
    const home = control.textContent;
    expect(control.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(control);

    expect(source.current).toBe("adjustable");
    expect(control.getAttribute("aria-pressed")).toBe("true");
    expect(control.textContent).toBe(home);
    // The name lives on the control, not in a word inside it, so it stays legible to a
    // screen reader while the row stays legible to everyone else.
    expect(control.getAttribute("aria-label")).toBeTruthy();
  });

  it("a node with nothing to inspect is offered no camera at all", () => {
    /*
     * T669, decided rather than left open. A suspended or non-3D preview publishes no
     * orbit, so there is no camera to offer and none is drawn — no disabled ghost, which
     * would be a control advertising a capability it does not have. The tile itself
     * already says WHY in words ("no signal", "paused", "over budget"), and with the
     * control in a fixed, always-scanned position its absence now reads as that state
     * rather than as the control having gone missing. §T639(a)'s rule, one affordance
     * over: a camera payload lands here too, and offering to override the matrix its tile
     * draws through would be an affordance that lies.
     */
    mount({ orbitable: false });
    expect(screen.queryByTestId(`preview-inspect-${NODE}`)).toBeNull();
    // And the other three are untouched, which is why this control is LAST in the row:
    // it is the one that comes and goes, so it must not move the ones that do not.
    expect(screen.getByLabelText("Preview")).toBeTruthy();
  });
});
