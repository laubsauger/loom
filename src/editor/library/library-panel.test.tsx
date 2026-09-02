// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { LibraryGroups, LibraryPanel, useLibraryHoverCard } from "./library-panel.tsx";
import type { LibraryHoverCard } from "./library-panel.tsx";

/**
 * The shared library panel (§T877).
 *
 * The panel exists because four surfaces shared a stylesheet and copied its structure,
 * and every bug the owner reported — the sticky header (§T876), the one-row filter that
 * landed in one pane (§T855), the hover card's position (§T858/§T862) — was that copy
 * showing. What is gated here is therefore the two properties a copy would break:
 * the toolbar is OUTSIDE the scroller, and the hover anchor is captured ONCE.
 *
 * The panes' own suites are the other half, and the load-bearing fact about them is that
 * NONE of them were edited for this extraction (§V748): node 15/15, component 7/7,
 * example 13/13 all still pass against the assertions they had before.
 */

beforeAll(installDomStubs);
afterEach(cleanup);

interface Row {
  readonly id: string;
  readonly category: string;
}

const ROWS: readonly Row[] = [
  { id: "alpha", category: "one" },
  { id: "beta", category: "two" },
];

function Harness({ onReady }: { onReady?: (hover: LibraryHoverCard<Row>) => void }) {
  const hover = useLibraryHoverCard<Row>();
  onReady?.(hover);
  return (
    <LibraryPanel
      hover={hover}
      renderCard={(row) => <span>card for {row.id}</span>}
      toolbar={<input aria-label="Search rows" readOnly value="" />}
    >
      <LibraryGroups
        items={ROWS}
        keyOf={(row) => row.id}
        empty="nothing"
        renderItem={(row) => (
          <button type="button" {...hover.rowProps(row)}>
            {row.id}
          </button>
        )}
      />
    </LibraryPanel>
  );
}

/** jsdom lays nothing out, so the row's box is stated rather than measured. */
function boxOf(element: Element, top: number, height: number, left: number): void {
  element.getBoundingClientRect = () =>
    ({
      x: left,
      y: top,
      left,
      top,
      right: left + 400,
      bottom: top + height,
      width: 400,
      height,
      toJSON: () => ({}),
    }) as DOMRect;
}

describe("§T877 — the panel's structure, so no surface can copy it wrong again", () => {
  it("keeps the toolbar OUT of the scrolling list", () => {
    render(<Harness />);
    const search = screen.getByRole("textbox", { name: "Search rows" });
    const scroller = screen.getByRole("region", { name: "one" }).parentElement;

    // This is §T876's fix expressed structurally: a sticky header can only be safe at
    // `top: 0` if nothing above it scrolls. Inherited by every pane that uses the panel,
    // rather than re-established in each one.
    expect(scroller).not.toBeNull();
    expect(scroller?.contains(search)).toBe(false);
    expect(scroller?.contains(screen.getByRole("heading", { name: /one/ }))).toBe(true);
  });

  it("groups with a count, and keeps categories alphabetical", () => {
    render(<Harness />);
    const headings = screen.getAllByRole("heading").map((node) => node.textContent ?? "");
    expect(headings).toEqual(["one1", "two1"]);
  });
});

describe("§T862 — the hover anchor is the POINTER, captured ONCE on entry", () => {
  it("anchors at the cursor's x, not at the row's edge", () => {
    let hover: LibraryHoverCard<Row> | undefined;
    render(<Harness onReady={(controller) => (hover = controller)} />);

    const row = screen.getByRole("button", { name: "alpha" });
    boxOf(row, 100, 20, 0);
    fireEvent.pointerOver(row, { clientX: 40, clientY: 105 });

    // A one-pixel column at the cursor, spanning the row. `side="right"` off THAT is
    // beside the cursor; off the row it is off the far edge of a full-width box, which
    // is how the card ended up over the inspector.
    const rect = hover?.anchorRef.current.getBoundingClientRect();
    expect(rect?.left).toBe(40);
    expect(rect?.width).toBe(1);
    expect(rect?.top).toBe(100);
    expect(rect?.height).toBe(20);
  });

  it("does NOT follow the pointer once the card is open", () => {
    let hover: LibraryHoverCard<Row> | undefined;
    render(<Harness onReady={(controller) => (hover = controller)} />);

    const row = screen.getByRole("button", { name: "alpha" });
    boxOf(row, 100, 20, 0);
    fireEvent.pointerOver(row, { clientX: 40 });
    fireEvent.pointerMove(row, { clientX: 900 });

    // THE WHOLE POINT. A tracked anchor reads a live coordinate at the element edge —
    // exactly where hover flickers — so it jitters by construction. Captured once is
    // near AND stable, and this is the assertion that says the tracking never came back.
    expect(hover?.anchorRef.current.getBoundingClientRect().left).toBe(40);
  });

  it("anchors at the row's near edge for the keyboard, which has no pointer", () => {
    let hover: LibraryHoverCard<Row> | undefined;
    render(<Harness onReady={(controller) => (hover = controller)} />);

    const row = screen.getByRole("button", { name: "beta" });
    boxOf(row, 300, 20, 12);
    fireEvent.focus(row);

    expect(hover?.anchorRef.current.getBoundingClientRect().left).toBe(12);
    expect(screen.getByText(/card for beta/)).toBeDefined();
  });

  it("opens the card on hover and closes it on leave", () => {
    render(<Harness />);
    const row = screen.getByRole("button", { name: "alpha" });
    boxOf(row, 100, 20, 0);

    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.pointerOver(row, { clientX: 40 });
    expect(screen.getByRole("tooltip").textContent).toContain("card for alpha");
    fireEvent.pointerOut(row);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});
