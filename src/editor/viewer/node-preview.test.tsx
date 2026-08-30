import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PREVIEW_LENS } from "@runtime/previews/index.ts";
import { NodePreview, lensMarker } from "./node-preview.tsx";

/**
 * T336 — the lens MARKER on the slot.
 *
 * §V70a's argument, applied one level in: a display transform that outlives the inspection
 * hides which node is wrong. A preview being shown through a lens is exactly that, so it says
 * so on the picture it is altering — otherwise someone isolates alpha on a node, forgets, and
 * spends an afternoon debugging a shader that was always fine.
 *
 * The other half is §V90: it must cost NOTHING when no lens is on. An always-present badge on
 * every node is the ambient chrome this project keeps refusing.
 */

afterEach(cleanup);

const output = { nodeId: "n1", portId: "out" };

describe("lensMarker", () => {
  it("says nothing when the preview is the plain picture", () => {
    expect(lensMarker(undefined)).toBeNull();
    expect(lensMarker(DEFAULT_PREVIEW_LENS)).toBeNull();
  });

  it("names the isolated channel", () => {
    expect(lensMarker({ ...DEFAULT_PREVIEW_LENS, lens: "g" })).toBe("G");
    expect(lensMarker({ ...DEFAULT_PREVIEW_LENS, lens: "luminance" })).toBe("LUM");
  });

  it("signs the exposure, because -1 and +1 are opposite mistakes", () => {
    expect(lensMarker({ ...DEFAULT_PREVIEW_LENS, exposureStops: 2 })).toBe("+2 EV");
    expect(lensMarker({ ...DEFAULT_PREVIEW_LENS, exposureStops: -2 })).toBe("-2 EV");
  });

  it("reports everything that is on at once", () => {
    expect(lensMarker({ lens: "a", exposureStops: 1, tonemap: true })).toBe("A +1 EV TM");
  });
});

describe("NodePreview", () => {
  it("shows no marker on an unfiltered preview", () => {
    render(<NodePreview output={output} state={{ kind: "live" }} />);
    expect(screen.queryByTestId("preview-lens-n1:out")).toBeNull();
  });

  it("marks a filtered preview, and says so to a screen reader too (§V19)", () => {
    render(
      <NodePreview
        output={output}
        state={{ kind: "live" }}
        lens={{ lens: "b", exposureStops: 0, tonemap: false }}
      />,
    );
    expect(screen.getByTestId("preview-lens-n1:out").textContent).toBe("B");
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("lens B");
  });

  it("keeps marking a preview that is suspended — the lens outlives the picture", () => {
    // The trap this exists for is a lens left on and forgotten, and a scrolled-off preview is
    // the easiest way to forget one.
    render(
      <NodePreview
        output={output}
        state={{ kind: "suspended", reason: "offscreen" }}
        facts={{ width: 64, height: 64, format: "rgba16float" }}
        lens={{ lens: "a", exposureStops: 0, tonemap: false }}
      />,
    );
    expect(screen.getByTestId("preview-lens-n1:out").textContent).toBe("A");
  });
});
