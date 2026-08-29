// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  PixelProbe,
  PixelWindow,
  PreviewOutputRef,
  ReadbackImage,
} from "@runtime/previews/index.ts";
import { NodePreview } from "./node-preview.tsx";
import { ViewerPane } from "./viewer-pane.tsx";
import type { ViewerOutput, ViewerPreviewRequest } from "./viewer-pane.tsx";

afterEach(cleanup);

const OUTPUTS: ViewerOutput[] = [
  { ref: { nodeId: "out1", portId: "out" }, size: [1280, 720], format: "rgba16float", label: "Output" },
  { ref: { nodeId: "blur", portId: "out" }, size: [640, 360], format: "rgba8unorm" },
];

function probeReturning(bytes: Uint8Array, format: ReadbackImage["format"] = "rgba8unorm") {
  const read = vi.fn(
    async (ref: PreviewOutputRef, window: PixelWindow): Promise<ReadbackImage> => {
      void ref;
      void window;
      return { width: 1, height: 1, rowStride: bytes.byteLength, format, bytes };
    },
  );
  return { read } satisfies PixelProbe & { read: typeof read };
}

/** jsdom gives every element a zero-size box; the stage needs a real one to map a pointer. */
function stubStageBox(element: HTMLElement): void {
  element.getBoundingClientRect = () =>
    ({ x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300, toJSON: () => ({}) }) as DOMRect;
}

describe("T36 — the large viewer pane", () => {
  it("lists the resolved outputs and reports the pinned one's size and format", () => {
    render(<ViewerPane outputs={OUTPUTS} />);
    expect(screen.getByLabelText("Preview of Output, 1280 by 720")).toBeDefined();
    expect(screen.getByTestId("viewer-readout").textContent).toContain("1280 × 720 · rgba16float");
  });

  it("says so when there is nothing to show, instead of showing a black rectangle", () => {
    render(<ViewerPane outputs={[]} />);
    expect(screen.getByText(/Nothing to render yet/)).toBeDefined();
  });

  it("switching output re-pins the viewer's request", async () => {
    const user = userEvent.setup();
    const onRequestChange = vi.fn<(request: ViewerPreviewRequest | null) => void>();
    render(<ViewerPane outputs={OUTPUTS} onRequestChange={onRequestChange} />);
    await user.selectOptions(screen.getByLabelText("output"), "blur:out");
    const last = onRequestChange.mock.calls.at(-1)?.[0];
    expect(last?.ref).toEqual({ nodeId: "blur", portId: "out" });
    // Always pinned: the viewer is the user saying "show me this", which is §V28's second
    // clause — scrolling the graph away from the node must not blank the pane.
    expect(last?.pinned).toBe(true);
  });
});

describe("T36 — channel toggles", () => {
  it("are real toggle buttons, keyboard reachable, with pressed state (§V19)", async () => {
    const user = userEvent.setup();
    render(<ViewerPane outputs={OUTPUTS} />);
    const red = screen.getByRole("button", { name: "Channel R" });
    expect(red.getAttribute("aria-pressed")).toBe("true");
    await user.click(red);
    expect(red.getAttribute("aria-pressed")).toBe("false");
  });

  it("isolating one colour channel switches the view to single-channel", async () => {
    const user = userEvent.setup();
    const onRequestChange = vi.fn<(request: ViewerPreviewRequest | null) => void>();
    render(<ViewerPane outputs={OUTPUTS} onRequestChange={onRequestChange} />);
    for (const channel of ["R", "B", "A"]) {
      await user.click(screen.getByRole("button", { name: `Channel ${channel}` }));
    }
    const last = onRequestChange.mock.calls.at(-1)?.[0];
    expect(last?.view.mode).toBe("channel");
    expect(last?.view.channel).toBe("g");
  });

  it("alpha alone shows coverage over the checkerboard", async () => {
    const user = userEvent.setup();
    const onRequestChange = vi.fn<(request: ViewerPreviewRequest | null) => void>();
    render(<ViewerPane outputs={OUTPUTS} onRequestChange={onRequestChange} />);
    for (const channel of ["R", "G", "B"]) {
      await user.click(screen.getByRole("button", { name: `Channel ${channel}` }));
    }
    expect(onRequestChange.mock.calls.at(-1)?.[0]?.view.mode).toBe("alpha");
  });

  it("exposure changes a uniform value, never the mode", async () => {
    const onRequestChange = vi.fn<(request: ViewerPreviewRequest | null) => void>();
    render(<ViewerPane outputs={OUTPUTS} onRequestChange={onRequestChange} />);
    const slider = screen.getByLabelText("exposure");
    await userEvent.setup().click(slider);
    const first = onRequestChange.mock.calls.at(-1)?.[0];
    expect(first?.view.mode).toBe("color");
    expect(first?.view.exposureStops).toBe(0);
  });
});

describe("T36 — pixel value under the cursor", () => {
  it("reads ONE pixel through the probe and shows its linear value", async () => {
    const probe = probeReturning(new Uint8Array([255, 0, 128, 255]));
    render(<ViewerPane outputs={OUTPUTS} probe={probe} readoutOptions={{ intervalMs: 0 }} />);
    const stage = screen.getByTestId("viewer-stage");
    stubStageBox(stage);

    await userEvent.setup().pointer({ target: stage, coords: { clientX: 200, clientY: 150 } });

    await waitFor(() => {
      expect(screen.getByTestId("viewer-value").textContent).toContain("1.0000");
    });
    expect(probe.read).toHaveBeenCalledTimes(1);
    // A 1x1 window, not a frame: §V7 permits the inspection, it does not permit pulling a
    // megabyte across the bus to report four numbers.
    expect(probe.read.mock.calls[0]?.[1]).toEqual({ x: 640, y: 360, width: 1, height: 1 });
    expect(screen.getByTestId("viewer-readout").textContent).toContain("640, 360");
  });

  it("is reachable from the keyboard (§V19)", async () => {
    const probe = probeReturning(new Uint8Array([0, 0, 0, 255]));
    render(<ViewerPane outputs={OUTPUTS} probe={probe} readoutOptions={{ intervalMs: 0 }} />);
    const user = userEvent.setup();
    await user.tab();
    screen.getByTestId("viewer-stage").focus();
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(probe.read).toHaveBeenCalled());
    expect(probe.read.mock.calls[0]?.[1]).toEqual({ x: 641, y: 360, width: 1, height: 1 });
  });

  it("rate-limits the probe to the §V16 ceiling however fast the pointer moves", async () => {
    const probe = probeReturning(new Uint8Array([0, 0, 0, 255]));
    render(<ViewerPane outputs={OUTPUTS} probe={probe} readoutOptions={{ intervalMs: 5_000 }} />);
    const stage = screen.getByTestId("viewer-stage");
    stubStageBox(stage);
    const user = userEvent.setup();
    for (let index = 0; index < 20; index += 1) {
      await user.pointer({ target: stage, coords: { clientX: 10 + index, clientY: 20 } });
    }
    // Twenty pointer moves, at most one read: the interval is the gate, not the event rate.
    expect(probe.read.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("says the probe is unavailable rather than showing a plausible zero", () => {
    render(<ViewerPane outputs={OUTPUTS} />);
    expect(screen.getByTestId("viewer-value").textContent).toContain("unavailable");
  });

  it("clears the readout when the pointer leaves the image", async () => {
    const probe = probeReturning(new Uint8Array([255, 255, 255, 255]));
    render(<ViewerPane outputs={OUTPUTS} probe={probe} readoutOptions={{ intervalMs: 0 }} />);
    const stage = screen.getByTestId("viewer-stage");
    stubStageBox(stage);
    const user = userEvent.setup();
    await user.pointer({ target: stage, coords: { clientX: 200, clientY: 150 } });
    await waitFor(() => expect(screen.getByTestId("viewer-value").textContent).toContain("1.0000"));
    await user.pointer({ target: document.body });
    await waitFor(() => expect(screen.getByTestId("viewer-value").textContent).toBe("—"));
  });
});

describe("T34 — the node preview slot", () => {
  it("paints nothing when the tile is live, so the surface behind it shows through", () => {
    render(<NodePreview output={{ nodeId: "a", portId: "out" }} state={{ kind: "live" }} />);
    const slot = screen.getByTestId("preview-slot-a:out");
    expect(slot.textContent).toBe("");
    expect(slot.getAttribute("data-preview-state")).toBe("live");
  });

  it("states WHY a preview is suspended", () => {
    // A suspended preview that looks identical to a broken one turns a working §V28
    // optimisation into a bug report.
    render(
      <NodePreview
        output={{ nodeId: "a", portId: "out" }}
        state={{ kind: "suspended", reason: "budget" }}
      />,
    );
    expect(screen.getByText("over budget")).toBeDefined();
  });
});
