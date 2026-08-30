// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./error-boundary.tsx";

/**
 * B79's SECOND question, which matters more than the first: why did a throw in one pane
 * take the WHOLE APP down?
 *
 * Because nothing caught it. Measured before this file existed: `componentDidCatch` and
 * `getDerivedStateFromError` appeared ZERO times in `src/`, so React's documented behaviour
 * — unmount the entire root — was the app's crash behaviour, and a white screen with no
 * message was the user's whole diagnostic.
 *
 * These cases are about CONTAINMENT, not about any particular bug: the sibling keeps
 * rendering, the failure names itself, and the pane can be brought back without reloading
 * the tab (which would cost the unsaved graph).
 *
 * §V339: jsdom paints nothing, so none of this is evidence that the failure panel is
 * legible, sized, or visible inside a pane's rectangle. A THROW, though, is a throw in any
 * environment — that part is genuinely observable here, and it is the part being asserted.
 */

/** React logs caught errors itself; the noise is expected and not the thing under test. */
let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  consoleError.mockRestore();
  cleanup();
});

function Boom({ fail }: { fail: boolean }) {
  if (fail) throw new Error("the preview tile has no backend");
  return <p>pane content</p>;
}

describe("B79 — a throw in one pane is not a throw in the app", () => {
  it("keeps the sibling panes rendering when one pane throws", () => {
    render(
      <>
        <ErrorBoundary name="Inspector">
          <Boom fail />
        </ErrorBoundary>
        <ErrorBoundary name="Graph">
          <p>the graph is still here</p>
        </ErrorBoundary>
      </>,
    );

    // The whole point: without a boundary this render throws out of `render` itself and
    // NEITHER of these exists, which is the white screen.
    expect(screen.getByText("the graph is still here")).toBeDefined();
    expect(screen.getByRole("alert")).toBeDefined();
  });

  it("names the pane and says what it said (§V288)", () => {
    render(
      <ErrorBoundary name="Inspector">
        <Boom fail />
      </ErrorBoundary>,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Inspector");
    expect(alert.textContent).toContain("the preview tile has no backend");
    // The sentence a user needs most: their unsaved work is not gone.
    expect(alert.textContent).toContain("your graph has not been changed");
  });

  it("writes the throw and the component stack to the console, named", () => {
    render(
      <ErrorBoundary name="Viewer">
        <Boom fail />
      </ErrorBoundary>,
    );
    const named = consoleError.mock.calls.filter((call) =>
      String(call[0]).includes("the Viewer pane failed to render"),
    );
    expect(named).toHaveLength(1);
    expect((named[0] as unknown[])[1]).toBeInstanceOf(Error);
  });

  /**
   * The case the button is FOR: a transient failure — one frame of bad runtime data, a
   * half-applied hot update — where the subtree renders fine the moment it is asked again.
   * Retrying must not cost a tab reload, because a tab reload costs the unsaved graph.
   */
  it("brings the pane back without reloading the app", () => {
    let broken = true;
    const Host = () => (
      <ErrorBoundary name="Inspector">
        <Boom fail={broken} />
      </ErrorBoundary>
    );

    const view = render(<Host />);
    expect(screen.getByRole("alert")).toBeDefined();

    // The upstream cause clears — a backend arrives, a hot update settles — and the panel
    // is STILL showing, because a boundary does not un-fail on its own. That is the state
    // the button exists for.
    broken = false;
    view.rerender(<Host />);
    expect(screen.getByRole("alert")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Reload this pane" }));

    expect(screen.getByText("pane content")).toBeDefined();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("passes the failure on to a caller that wants to surface it elsewhere", () => {
    const onError = vi.fn();
    render(
      <ErrorBoundary name="Problems" onError={onError}>
        <Boom fail />
      </ErrorBoundary>,
    );
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0] as unknown[])[0]).toBeInstanceOf(Error);
  });
});
