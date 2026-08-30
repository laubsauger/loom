// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { TooltipProvider } from "@ui/primitives/tooltip.tsx";
import type { FrameInputs } from "@domain/types/backend.ts";
import { DEFAULT_FRAME_RANGE } from "@domain/types/graph.ts";
import { TimelineScrubber, frameAtFraction, fractionOfRange } from "./timeline-scrubber.tsx";

/**
 * The header timeline (T433).
 *
 * ## What this file proves, and what it CANNOT
 *
 * §V339: jsdom paints nothing and measures nothing. Every `getBoundingClientRect()` here
 * is zero, so nothing in this file is evidence that the strip is VISIBLE, that it fits a
 * 32px header, or that a click at x=120 lands on frame 300. Those are pixel claims and
 * they live in `src/tests/e2e/header-timeline.spec.ts`, in a real browser, measured.
 *
 * What is provable without a layout engine is the part with the arithmetic in it — which
 * frame a fraction of the track means, and in which direction — and the part with the
 * COMMANDS in it: that a gesture asks for a seek, that it asks for exactly one, and that
 * the range's ends write the document rather than a local copy.
 */

beforeAll(() => {
  installDomStubs();
});
afterEach(cleanup);

/** The strip uses tooltips, which Radix requires a provider for. The shell has one. */
function mount(element: ReactElement) {
  return render(<TooltipProvider>{element}</TooltipProvider>);
}

const RANGE = { start: 0, end: 599 };

function frameAt(frameIndex: number): FrameInputs {
  return {
    frame: {
      frameIndex,
      timeSeconds: frameIndex / 60,
      deltaSeconds: 1 / 60,
      wallTimeSeconds: frameIndex / 60,
      wallDeltaSeconds: 1 / 60,
      randomSeed: 1,
    },
    pointer: { x: 0, y: 0, buttons: 0 },
    resolution: [16, 16],
  } as unknown as FrameInputs;
}

/** jsdom returns a zero box, which would make every drag map to the in point. */
function stubTrackWidth(width: number): void {
  const track = screen.getByRole("slider", { name: "Playhead" });
  vi.spyOn(track, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: width,
    bottom: 10,
    width,
    height: 10,
    toJSON: () => ({}),
  });
}

describe("the track maps pointer position to a frame in the range", () => {
  it("puts the in point at the left edge and the out point at the right", () => {
    expect(frameAtFraction(RANGE, 0)).toBe(0);
    expect(frameAtFraction(RANGE, 1)).toBe(599);
    expect(fractionOfRange(RANGE, 0)).toBe(0);
    expect(fractionOfRange(RANGE, 599)).toBe(1);
  });

  it("is the inverse of itself at the halfway mark, for a range that does not start at zero", () => {
    const offset = { start: 100, end: 200 };
    expect(frameAtFraction(offset, 0)).toBe(100);
    expect(frameAtFraction(offset, 0.5)).toBe(150);
    expect(fractionOfRange(offset, 150)).toBeCloseTo(0.5, 10);
  });

  it("never points outside the range, however far the pointer travelled", () => {
    expect(frameAtFraction(RANGE, -3)).toBe(0);
    expect(frameAtFraction(RANGE, 4)).toBe(599);
    expect(fractionOfRange(RANGE, -50)).toBe(0);
    expect(fractionOfRange(RANGE, 5000)).toBe(1);
  });
});

describe("scrubbing asks the transport to seek (§V170)", () => {
  it("issues ONE seek for a whole drag, on release, not one per pointer sample", () => {
    const onSeek = vi.fn();
    mount(
      <TimelineScrubber latestFrame={() => frameAt(0)} range={RANGE} onSeek={onSeek} />,
    );
    stubTrackWidth(600);
    const track = screen.getByRole("slider", { name: "Playhead" });

    fireEvent.pointerDown(track, { button: 0, pointerId: 1, clientX: 60 });
    fireEvent.pointerMove(track, { pointerId: 1, clientX: 150 });
    fireEvent.pointerMove(track, { pointerId: 1, clientX: 240 });
    fireEvent.pointerMove(track, { pointerId: 1, clientX: 300 });
    // A seek REPLAYS from frame zero, so one per pointer sample would replay the graph
    // four times for this gesture and a few hundred times for a real one.
    expect(onSeek).not.toHaveBeenCalled();

    fireEvent.pointerUp(track, { pointerId: 1, clientX: 300 });
    expect(onSeek).toHaveBeenCalledTimes(1);
    expect(onSeek).toHaveBeenCalledWith(frameAtFraction(RANGE, 0.5));
  });

  it("seeks to where the pointer ENDED, not to where the drag began", () => {
    const onSeek = vi.fn();
    mount(
      <TimelineScrubber latestFrame={() => frameAt(0)} range={RANGE} onSeek={onSeek} />,
    );
    stubTrackWidth(600);
    const track = screen.getByRole("slider", { name: "Playhead" });

    fireEvent.pointerDown(track, { button: 0, pointerId: 1, clientX: 0 });
    fireEvent.pointerUp(track, { pointerId: 1, clientX: 600 });
    expect(onSeek).toHaveBeenCalledWith(599);
  });

  it("is inert when nothing can seek, rather than a control that does nothing", () => {
    mount(<TimelineScrubber latestFrame={() => frameAt(0)} range={RANGE} />);
    const track = screen.getByRole("slider", { name: "Playhead" });
    expect(track.getAttribute("aria-disabled")).toBe("true");
    expect(track.tabIndex).toBe(-1);
  });

  it("reports the playhead's frame to assistive technology, from the rendered frame", () => {
    mount(
      <TimelineScrubber latestFrame={() => frameAt(300)} range={RANGE} onSeek={vi.fn()} />,
    );
    const track = screen.getByRole("slider", { name: "Playhead" });
    expect(track.getAttribute("aria-valuenow")).toBe("300");
    expect(track.getAttribute("aria-valuemin")).toBe("0");
    expect(track.getAttribute("aria-valuemax")).toBe("599");
  });
});

describe("the range's ends are ONE value with three meanings (T433)", () => {
  it("writes the whole range when the out point is committed, keeping the in point", () => {
    const onChangeRange = vi.fn();
    mount(
      <TimelineScrubber
        latestFrame={() => frameAt(0)}
        range={{ start: 30, end: 599 }}
        onSeek={vi.fn()}
        onChangeRange={onChangeRange}
      />,
    );
    const out = screen.getByLabelText("Out point");
    fireEvent.change(out, { target: { value: "240" } });
    fireEvent.keyDown(out, { key: "Enter" });
    expect(onChangeRange).toHaveBeenCalledWith({ start: 30, end: 240 });
  });

  it("refuses an out point at or before the in point rather than writing an inverted range", () => {
    const onChangeRange = vi.fn();
    mount(
      <TimelineScrubber
        latestFrame={() => frameAt(0)}
        range={{ start: 100, end: 200 }}
        onSeek={vi.fn()}
        onChangeRange={onChangeRange}
      />,
    );
    const out = screen.getByLabelText("Out point");
    fireEvent.change(out, { target: { value: "40" } });
    fireEvent.keyDown(out, { key: "Enter" });
    expect(onChangeRange).not.toHaveBeenCalled();
  });

  it("abandons an edit on Escape without writing the document", () => {
    const onChangeRange = vi.fn();
    mount(
      <TimelineScrubber
        latestFrame={() => frameAt(0)}
        range={DEFAULT_FRAME_RANGE}
        onSeek={vi.fn()}
        onChangeRange={onChangeRange}
      />,
    );
    const inPoint = screen.getByLabelText("In point");
    fireEvent.change(inPoint, { target: { value: "12" } });
    fireEvent.keyDown(inPoint, { key: "Escape" });
    expect(onChangeRange).not.toHaveBeenCalled();
    expect((inPoint as HTMLInputElement).value).toBe("0");
  });

  it("is read-only when the document cannot be written", () => {
    mount(
      <TimelineScrubber latestFrame={() => frameAt(0)} range={RANGE} onSeek={vi.fn()} />,
    );
    expect((screen.getByLabelText("Out point") as HTMLInputElement).readOnly).toBe(true);
  });
});
