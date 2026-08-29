// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { TooltipProvider } from "@ui/primitives/tooltip.tsx";
import type { FrameInputs } from "@domain/types/backend.ts";
import { TimelineReadout } from "./timeline-readout.tsx";

/**
 * T265 / §V169 — the readout shows the frame that was RENDERED.
 *
 * The failure this guards is a display fed by `performance.now()`: it looks right, drifts
 * from the picture, and drifts worst exactly when someone is staring at it because they no
 * longer trust what they see. So every number here is asserted to come from the
 * `FrameEvaluationInput` the render consumed — including fps, which is derived from that
 * frame's own `deltaSeconds` and not from a wall clock this component reads.
 */

beforeAll(installDomStubs);
afterEach(cleanup);

/** The readout uses tooltips, which Radix requires a provider for. The shell has one. */
function mount(element: ReactElement) {
  return render(<TooltipProvider>{element}</TooltipProvider>);
}

function frame(frameIndex: number, deltaSeconds: number, wallDeltaSeconds = deltaSeconds): FrameInputs {
  return {
    frame: {
      frameIndex,
      timeSeconds: frameIndex * deltaSeconds,
      deltaSeconds,
      mode: "realtime",
      randomSeed: 1,
      wallSeconds: frameIndex * wallDeltaSeconds,
      wallDeltaSeconds,
    },
    pointer: { x: 0, y: 0, buttons: 0 },
    resolution: [64, 64],
  };
}

describe("the timeline readout reads the rendered frame (§V169)", () => {
  it("says nothing rather than zero before a frame has been rendered", () => {
    mount(<TimelineReadout latestFrame={() => null} />);
    expect((screen.getByLabelText("Frame") as HTMLInputElement).value).toBe("");
    expect(screen.getByLabelText("Elapsed time").textContent).toBe("—");
    expect(screen.getByLabelText("Frames per second").textContent).toBe("—");
  });

  it("shows the frame index and time the graph was evaluated at", () => {
    vi.useFakeTimers();
    try {
      let current = frame(0, 1 / 60);
      mount(<TimelineReadout latestFrame={() => current} intervalMs={100} />);

      expect((screen.getByLabelText("Frame") as HTMLInputElement).value).toBe("0");

      current = frame(120, 1 / 60);
      act(() => {
        vi.advanceTimersByTime(100);
      });

      expect((screen.getByLabelText("Frame") as HTMLInputElement).value).toBe("120");
      expect(screen.getByLabelText("Elapsed time").textContent).toBe("2.00s");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports the WALL rate for fps, so a dropped frame is visible (T271)", () => {
    vi.useFakeTimers();
    try {
      // The timeline steps at a constant 1/60 whatever happens, so an fps computed from
      // it would read a flat 60 while the app was actually managing 30. `time` stays on
      // the timeline — where the animation is — and `fps` reports the throughput.
      let index = 0;
      mount(
        <TimelineReadout
          latestFrame={() => frame(index++, 1 / 60, 1 / 30)}
          intervalMs={100}
        />,
      );
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      expect(screen.getByLabelText("Frames per second").textContent).toBe("30.0");
    } finally {
      vi.useRealTimers();
    }
  });

  it("derives fps from the rendered frame's delta, not from a clock of its own", () => {
    vi.useFakeTimers();
    try {
      // Every frame took 1/30 s. Advancing the sampler's timer by whole seconds must not
      // change the answer — a readout wired to wall time would report ~10 fps here,
      // because that is how often IT ticks.
      let index = 0;
      mount(<TimelineReadout latestFrame={() => frame(index++, 1 / 30)} intervalMs={100} />);
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      expect(screen.getByLabelText("Frames per second").textContent).toBe("30.0");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops counting when the loop stops, instead of drifting upward", () => {
    vi.useFakeTimers();
    try {
      const stalled = frame(42, 1 / 60);
      mount(<TimelineReadout latestFrame={() => stalled} intervalMs={100} />);
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      // The same frame sampled ten times is still one frame: fps must not be recomputed
      // from repeats, and the frame number must not move.
      expect((screen.getByLabelText("Frame") as HTMLInputElement).value).toBe("42");
      expect(screen.getByLabelText("Frames per second").textContent).toBe("60.0");
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * §V170 — the frame field seeks, and seeking is a REPLAY. This asserts the request, which
 * is this component's whole responsibility; what a seek does to temporal state is
 * `transport.seek`'s, and is tested where that lives.
 */
describe("the frame field seeks (§V170)", () => {
  it("asks to seek to the frame that was typed, on Enter", () => {
    const seeks: number[] = [];
    mount(<TimelineReadout latestFrame={() => frame(0, 1 / 60)} onSeek={(n) => seeks.push(n)} />);

    const field = screen.getByLabelText("Frame");
    fireEvent.change(field, { target: { value: "240" } });
    fireEvent.keyDown(field, { key: "Enter" });

    expect(seeks).toEqual([240]);
  });

  it("abandons the edit on Escape without seeking", () => {
    const seeks: number[] = [];
    mount(<TimelineReadout latestFrame={() => frame(7, 1 / 60)} onSeek={(n) => seeks.push(n)} />);

    const field = screen.getByLabelText("Frame") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "999" } });
    fireEvent.keyDown(field, { key: "Escape" });

    expect(seeks).toEqual([]);
    expect(field.value).toBe("7");
  });

  it("ignores input that is not a frame rather than seeking somewhere arbitrary", () => {
    const seeks: number[] = [];
    mount(<TimelineReadout latestFrame={() => frame(0, 1 / 60)} onSeek={(n) => seeks.push(n)} />);

    const field = screen.getByLabelText("Frame");
    for (const value of ["", "-4", "abc"]) {
      fireEvent.change(field, { target: { value } });
      fireEvent.keyDown(field, { key: "Enter" });
    }
    expect(seeks).toEqual([]);
  });

  it("is read-only, and offers no start button, when nothing can seek", () => {
    mount(<TimelineReadout latestFrame={() => frame(0, 1 / 60)} />);
    expect(screen.getByLabelText("Frame").hasAttribute("readonly")).toBe(true);
    expect(screen.queryByLabelText("Go to start")).toBeNull();
  });
});
