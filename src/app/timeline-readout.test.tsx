// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { TooltipProvider } from "@ui/primitives/tooltip.tsx";
import type { FrameInputs } from "@domain/types/backend.ts";
import { type FrameClockVerdict, frameClockVerdict } from "@runtime/telemetry/frame-clock.ts";
import { TimelineReadout } from "./timeline-readout.tsx";

/**
 * T265 / §V169 — the readout shows the frame that was RENDERED.
 *
 * The failure this guards is a display fed by `performance.now()`: it looks right, drifts
 * from the picture, and drifts worst exactly when someone is staring at it because they no
 * longer trust what they see. Frame and time come from the rendered input; throughput
 * comes from the existing frame clock's complete rendered-frame window.
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
  it.each([0.01, 0.02])("does not alias 60 FPS to the sampled frame's %s-second duration", (wallDelta) => {
    vi.useFakeTimers();
    try {
      let index = 0;
      // Ninety rendered frames in 1.5 seconds, quantized to 100 Hz display ticks.
      // The 10 Hz UI sampler can repeatedly land on only 10 ms or only 20 ms gaps.
      const recentFrameTimes = Array.from({ length: 90 }, (_, i) => Math.round((i + 1) * 5 / 3) * 10);
      mount(<TimelineReadout
        latestFrame={() => frame(index++, 1 / 60, wallDelta)}
        frameClock={() => frameClockVerdict({
          playing: true, hidden: false, settings: { fps: 60 }, recentFrameTimes, now: 1500,
        })}
      />);
      act(() => vi.advanceTimersByTime(1_000));
      expect(screen.getByLabelText("Frames per second").textContent).toBe("60.0");
    } finally {
      vi.useRealTimers();
    }
  });

  it("says nothing rather than zero before a frame has been rendered", () => {
    mount(<TimelineReadout latestFrame={() => null} frameClock={() => ({ kind: "live", observedFps: 0, realtime: false })} />);
    expect((screen.getByLabelText("Frame") as HTMLInputElement).value).toBe("");
    expect(screen.getByLabelText("Elapsed time").textContent).toBe("—");
    expect(screen.getByLabelText("Frames per second").textContent).toBe("—");
  });

  it("shows the frame index and time the graph was evaluated at", () => {
    vi.useFakeTimers();
    try {
      let current = frame(0, 1 / 60);
      mount(<TimelineReadout latestFrame={() => current} frameClock={() => ({ kind: "live", observedFps: 60, realtime: true })} intervalMs={100} />);

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
          frameClock={() => ({ kind: "live", observedFps: 30, realtime: false })}
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

  it("updates throughput when no new frame arrives, without advancing the timeline", () => {
    vi.useFakeTimers();
    try {
      let observedFps = 30;
      mount(<TimelineReadout latestFrame={() => frame(42, 1 / 30)} frameClock={() => ({ kind: "live", observedFps, realtime: false })} intervalMs={100} />);
      expect(screen.getByLabelText("Frames per second").textContent).toBe("30.0");
      observedFps = 0;
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      expect(screen.getByLabelText("Frames per second").textContent).toBe("0.0");
      expect((screen.getByLabelText("Frame") as HTMLInputElement).value).toBe("42");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops counting when the loop stops, instead of drifting upward", () => {
    vi.useFakeTimers();
    try {
      const stalled = frame(42, 1 / 60);
      mount(<TimelineReadout latestFrame={() => stalled} frameClock={() => ({ kind: "paused", realtime: false })} intervalMs={100} />);
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      // Paused transport has no live throughput. The frame number must not move.
      expect((screen.getByLabelText("Frame") as HTMLInputElement).value).toBe("42");
      expect(screen.getByLabelText("Frames per second").textContent).toBe("—");
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
    mount(<TimelineReadout latestFrame={() => frame(0, 1 / 60)} frameClock={() => ({ kind: "paused", realtime: false })} onSeek={(n) => seeks.push(n)} />);

    const field = screen.getByLabelText("Frame");
    fireEvent.change(field, { target: { value: "240" } });
    fireEvent.keyDown(field, { key: "Enter" });

    expect(seeks).toEqual([240]);
  });

  it("abandons the edit on Escape without seeking", () => {
    const seeks: number[] = [];
    mount(<TimelineReadout latestFrame={() => frame(7, 1 / 60)} frameClock={() => ({ kind: "paused", realtime: false })} onSeek={(n) => seeks.push(n)} />);

    const field = screen.getByLabelText("Frame") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "999" } });
    fireEvent.keyDown(field, { key: "Escape" });

    expect(seeks).toEqual([]);
    expect(field.value).toBe("7");
  });

  it("ignores input that is not a frame rather than seeking somewhere arbitrary", () => {
    const seeks: number[] = [];
    mount(<TimelineReadout latestFrame={() => frame(0, 1 / 60)} frameClock={() => ({ kind: "paused", realtime: false })} onSeek={(n) => seeks.push(n)} />);

    const field = screen.getByLabelText("Frame");
    for (const value of ["", "-4", "abc"]) {
      fireEvent.change(field, { target: { value } });
      fireEvent.keyDown(field, { key: "Enter" });
    }
    expect(seeks).toEqual([]);
  });

  it("is read-only, and offers no start button, when nothing can seek", () => {
    mount(<TimelineReadout latestFrame={() => frame(0, 1 / 60)} frameClock={() => ({ kind: "paused", realtime: false })} />);
    expect(screen.getByLabelText("Frame").hasAttribute("readonly")).toBe(true);
    expect(screen.queryByLabelText("Go to start")).toBeNull();
  });
});

/**
 * T304/T1300 — the frame clock is a PERMANENT FIELD, not a notice that pops in.
 *
 * The owner: *"the 'running behind' text is silly and breaks the layout when it appears.
 * instead I want an indicator that is already there."* So the assertion that matters most
 * here is the boring one: the element is in the document in EVERY state, including the
 * healthy one. §V461's concern (a notice that can never turn off) is met by the WORD and
 * the dot state changing, not by the element disappearing — which is what used to shove
 * the row at the exact moment someone was reading it.
 */
describe("T1300 — the readout always shows the frame clock, and says whether it is realtime", () => {
  const anyFrame = {
    frame: { frameIndex: 5, timeSeconds: 0.08, deltaSeconds: 1 / 60, mode: "live", randomSeed: 7 },
  } as never;

  function readIndicator(clock: FrameClockVerdict) {
    cleanup();
    render(
      <TooltipProvider>
        <TimelineReadout latestFrame={() => anyFrame} frameClock={() => clock} intervalMs={5} />
      </TooltipProvider>,
    );
    const el = screen.getByTestId("frame-clock-notice");
    return { word: el.textContent, state: el.getAttribute("data-state"), kind: el.getAttribute("data-kind") };
  }

  it("reads Realtime, with the ok dot, when the clock is at the project rate", () => {
    expect(readIndicator({ kind: "live", observedFps: 60, realtime: true })).toEqual({
      word: "Realtime",
      state: "realtime",
      kind: "live",
    });
  });

  it("reads Behind in the whole band between half rate and full rate — the band that used to show nothing", () => {
    // 31 of 60 is `live`: the clock is RUNNING. It is not realtime, and before T1300 the
    // strip said nothing at all here, which is the owner's "what does live even mean then".
    expect(readIndicator({ kind: "live", observedFps: 31, realtime: false })).toEqual({
      word: "Behind",
      state: "behind",
      kind: "live",
    });
  });

  it("names the BROWSER when the browser stopped the clock, and the machine when the machine did", () => {
    expect(readIndicator({ kind: "browser-throttled", observedFps: 0, realtime: false, suggestion: "Bring the window to the front." })).toEqual({
      word: "Throttled",
      state: "throttled",
      kind: "browser-throttled",
    });
    expect(readIndicator({ kind: "running-behind", observedFps: 4, realtime: false, suggestion: "Reduce steps." })).toEqual({
      word: "Behind",
      state: "behind",
      kind: "running-behind",
    });
  });

  it("reads Paused rather than vanishing when the transport is stopped", () => {
    expect(readIndicator({ kind: "paused", realtime: false })).toEqual({
      word: "Paused",
      state: "paused",
      kind: "paused",
    });
  });

  it("is present before the first frame has been rendered, so the row cannot grow a field later", () => {
    cleanup();
    mount(<TimelineReadout latestFrame={() => null} frameClock={() => ({ kind: "paused", realtime: false })} />);
    expect(screen.getByTestId("frame-clock-notice").textContent).toBe("Paused");
  });

  it("carries the verdict's own remedy as the tooltip, so the guidance still has one home", async () => {
    cleanup();
    render(
      <TooltipProvider>
        <TimelineReadout
          latestFrame={() => anyFrame}
          frameClock={() => ({
            kind: "browser-throttled",
            observedFps: 0,
            realtime: false,
            suggestion: "The browser suspends the frame clock for a hidden or occluded window.",
          })}
          intervalMs={5}
        />
      </TooltipProvider>,
    );
    const trigger = screen.getByTestId("frame-clock-notice");
    fireEvent.focus(trigger);
    const described = await screen.findByText("The browser suspends the frame clock for a hidden or occluded window.");
    expect(described).not.toBeNull();
  });
});
