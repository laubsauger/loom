// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { createDomainBus } from "@domain/commands/index.ts";
import { createGraphStore } from "@domain/graph/store.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import { createSequentialIdFactory } from "@domain/graph/ids.ts";
import { createTestRegistry } from "@nodes/registry/test-nodes.ts";
import { CanvasFixture, fixtureContext, installFlowStubs, nodeProps } from "@editor/graph-canvas/testing.tsx";
import type { PreviewLensSource } from "@editor/graph-canvas/canvas-context.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { NodeView } from "./node-view.tsx";

/**
 * T892 — THE CAMERA TOGGLE IS NOT IN THE NODE HEADER, and its absence is the point.
 *
 * ## What the owner asked for, three times
 *
 * "the camera toggle still sits in the header of nodes that support camera movement in
 * their preview. i asked to have that moved out of there and overlaid on the actual
 * preview canvas bottom right as a overlay button so we can gain more space for the node
 * title." The complaint is about WIDTH: the header of a 178px node was carrying `P B M C`,
 * and a node called `hatch` rendered as `ha…` to pay for the fourth button.
 *
 * ## Why this file now asserts an absence, having previously asserted the opposite
 *
 * T675 put the control here deliberately and the reasoning was sound as far as it went:
 * the shared preview surface composites over every pixel of a node's preview slot, so a
 * control drawn inside the slot is invisible exactly when the tile is live. That fact is
 * unchanged. What was wrong was the conclusion that the header was therefore the only
 * place left — the third option is a layer that is a SIBLING of the compositing surface
 * rather than a descendant of React Flow's viewport, which is where the control lives now
 * (`editor/viewer/preview-inspect-overlay.tsx`, gated by its own suite).
 *
 * So the invariant this file holds has flipped, and it is worth stating in one line for
 * whoever reads the two suites side by side:
 *
 *   THE NODE RENDERS THREE HEADER TOGGLES — P, B, M — AND NEVER A FOURTH.
 *
 * The count is the gate, not just the identity of the buttons: `C` was the ONLY member of
 * that row whose presence varied, and a conditional item in a fixed row is precisely what
 * made the header's width unpredictable from one node to the next.
 *
 * The LENS mark (T685) is still in the header and is asserted here unchanged. It is a
 * warning about what the picture IS rather than a control, it renders only when a lens is
 * actually set, and moving it was not asked for — see the note in `viewer.module.css`.
 */

beforeAll(() => {
  installDomStubs();
  installFlowStubs();
});
afterEach(cleanup);

const NODE = "n1" as NodeId;

/** One node of a type whose output is previewable, against a real store (§V29). */
const GRAPH: GraphDocument = {
  revision: 1,
  nodes: {
    n1: { id: "n1", type: "test.blur", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
  },
  edges: {},
  groups: {},
};

/** A stand-in for the pane's lens store — the two calls the header's mark uses. */
function lensSource(marker: string | null): PreviewLensSource {
  return { marker: () => marker, subscribe: () => () => {} };
}

function mount(options: { lens?: string | null } = {}) {
  const store = createGraphStore({ ids: createSequentialIdFactory("n"), initialGraph: GRAPH });
  const { bus } = createDomainBus({ store, registry: createTestRegistry().view() });
  const { value } = fixtureContext({
    store: bus.store,
    registry: bus.registry,
    // The real slot's shape, minus the preview machinery: what matters here is that the
    // node renders a preview REGION at all, since that region is what a tile covers.
    renderPreview: () => <div data-testid={`preview-body-${NODE}`}>tile goes here</div>,
    previewLens: () => lensSource(options.lens ?? null),
  });
  render(
    <CanvasFixture value={value}>
      <NodeView {...nodeProps(NODE)} />
    </CanvasFixture>,
  );
}

describe("T892 — the camera toggle has left the node header", () => {
  it("renders NO camera toggle anywhere in the node, orbitable preview or not", () => {
    /*
     * The node no longer asks whether this preview has a camera — there is no
     * `previewInspect` on the canvas context for it to ask through — so there is no
     * fixture flag to vary here, and that IS the fix: the header's contents cannot depend
     * on a fact about the preview any more.
     */
    mount();
    expect(screen.queryByTestId(`preview-inspect-${NODE}`)).toBeNull();
    expect(screen.queryByText("C")).toBeNull();
  });

  it("leaves EXACTLY the three stable flag toggles — P, B, M — in the header", () => {
    /*
     * The count, not just the membership. `C` was the one conditional member of this row
     * (offered only where the compiler published an orbit), and the owner's report is what
     * a conditional member costs: the title's width varied with whether the node had a
     * camera, and lost. A fourth button of any kind arriving here fails this.
     */
    mount();
    const header = screen.getByTestId(`node-name-${NODE}`).closest("header");
    expect(header).not.toBeNull();
    const labels = [...(header?.querySelectorAll("button") ?? [])].map(
      (button) => button.textContent,
    );
    expect(labels).toEqual(["P", "B", "M"]);
  });

  it("keeps the toggles as direct siblings of the title — no group to hold a gap", () => {
    /*
     * The owner's complaint was `ha…`, the name truncating to two characters, so removing
     * the button is only half the fix: the width it occupied has to reach the TITLE.
     *
     * jsdom does no layout, so what is asserted is the structural fact that makes that
     * true. `.title` is a plain flex row where the name is the only `flex: 1 1 auto` child
     * and each toggle is `flex: 0 0 auto`: with the buttons as direct siblings, a button
     * leaving genuinely shortens the row and the name absorbs the difference. Wrap the
     * toggles in a group — the obvious tidy-up, and the one that would silently reinstate
     * the bug — and the group's own width becomes the thing that shrinks, or does not.
     */
    mount();
    const name = screen.getByTestId(`node-name-${NODE}`);
    const header = name.closest("header");
    const buttons = [...(header?.querySelectorAll("button") ?? [])];
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) expect(button.parentElement).toBe(header);
    expect(name.parentElement).toBe(header);
  });
});

describe("T685 — the LENS warning is in the header, and it stays there", () => {
  /**
   * §V70a: a preview shown through a lens is not the node's output, and a display
   * transform that outlives the inspection hides WHICH NODE IS WRONG. Drawn in the tile's
   * corner it was visible on exactly the previews that were NOT live. T892 moved the
   * TOGGLE onto the tile through a layer that composites nothing over it; the mark was not
   * part of that request and is deliberately untouched, so this suite is unchanged.
   */
  it("renders in the header, never inside the preview slot", () => {
    mount({ lens: "A +1 EV" });
    const mark = screen.getByTestId(`preview-lens-${NODE}`);
    const slot = screen.getByTestId(`node-preview-${NODE}`);

    expect(mark.textContent).toBe("A +1 EV");
    expect(slot.contains(mark)).toBe(false);
    expect(mark.closest("header")).not.toBeNull();
  });

  it("says nothing at all while the picture is unaltered (§V90)", () => {
    // The quiet case has to stay quiet, or the warning stops meaning anything: a mark on
    // every node is a mark on no node.
    mount({ lens: null });
    expect(screen.queryByTestId(`preview-lens-${NODE}`)).toBeNull();
  });
});
