import { afterEach, describe, expect, it, vi } from "vitest";

import { mockGpuHost } from "./mock-gpu-host.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";

/**
 * T933 — THE WIRING, not the gate.
 *
 * `frame-pacing.test.ts` already proves the gate's arithmetic against synthetic tick
 * trains. What was never covered is the question one level up: does `backend.loop()`
 * BUILD a gate at all, and with which number. It used to answer "no gate" whenever the
 * caller omitted `fps` — so a document with no `fps` key (which is every shipped
 * document) rendered at display rate while the settings pane and the clock, both reading
 * the same absent field through `projectFps`, said 60.
 *
 * The display here is a fake: the test owns `requestAnimationFrame` and the clock the
 * gate reads, so "how many of these 240 ticks became frames" is an exact number rather
 * than a timing race.
 */

/** A display the test steps by hand, at a refresh rate it chooses. */
function fakeDisplay(refreshHz: number) {
  let pending: ((timestampMs: number) => void) | null = null;
  let nowMs = 0;
  const realRaf = globalThis.requestAnimationFrame;
  const realCancel = globalThis.cancelAnimationFrame;
  const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => nowMs);
  globalThis.requestAnimationFrame = ((fn: (t: number) => void) => {
    pending = fn;
    return 1;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => {
    pending = null;
  }) as typeof cancelAnimationFrame;

  return {
    /** Advances the display by `count` refreshes, delivering each to the loop. */
    tick(count: number): void {
      for (let i = 0; i < count; i += 1) {
        nowMs += 1000 / refreshHz;
        const fn = pending;
        pending = null;
        fn?.(nowMs);
      }
    },
    restore(): void {
      nowSpy.mockRestore();
      if (realRaf) globalThis.requestAnimationFrame = realRaf;
      else delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
      if (realCancel) globalThis.cancelAnimationFrame = realCancel;
      else delete (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame;
    },
  };
}

const teardown: Array<() => void> = [];
afterEach(() => {
  while (teardown.length > 0) teardown.pop()?.();
});

async function pacedHarness(settings: { fps?: number }) {
  const backend = createVgpuBackend({ host: mockGpuHost() });
  await backend.initialize({});
  teardown.push(() => backend.dispose());
  // Installed AFTER initialize so device setup keeps the real clock.
  const display = fakeDisplay(120);
  teardown.push(() => display.restore());

  let rendered = 0;
  const control = backend.loop(() => {
    rendered += 1;
  }, settings);
  teardown.push(() => control.stop());
  return { display, frames: () => rendered, control };
}

describe("the scheduler's rate comes from projectFps (T933)", () => {
  it("a document with NO fps renders at the project default, not at display rate", async () => {
    // The owner's report, as arithmetic: 60 asked for, 90-105 measured. On this 120 Hz
    // display the unpaced branch rendered all 240 ticks.
    const { display, frames } = await pacedHarness({});
    display.tick(240);
    expect(Math.abs(frames() - 120)).toBeLessThanOrEqual(2);
  });

  it("an explicit fps is the rate that runs", async () => {
    const { display, frames } = await pacedHarness({ fps: 30 });
    display.tick(240);
    expect(Math.abs(frames() - 60)).toBeLessThanOrEqual(2);
  });

  it("fps 0 is nonsense, not a request to run unpaced", async () => {
    // The old branch read `fps === undefined || fps <= 0` as "uncapped". Neither an
    // absence nor a zero can say which of two things it meant, so neither is allowed
    // to mean the rare one: both take the default.
    const { display, frames } = await pacedHarness({ fps: 0 });
    display.tick(240);
    expect(Math.abs(frames() - 120)).toBeLessThanOrEqual(2);
  });

  it("a live fps change takes effect WITHOUT a loop restart", async () => {
    // The interval is read per tick off the registration, so the same handle keeps
    // running while the rate changes underneath it — the clock reads its rate the same
    // way (T271) and the two must not disagree.
    const settings: { fps?: number } = { fps: 60 };
    const { display, frames, control } = await pacedHarness(settings);
    display.tick(120);
    const atSixty = frames();
    expect(Math.abs(atSixty - 60)).toBeLessThanOrEqual(2);

    settings.fps = 120;
    display.tick(120);
    expect(Math.abs(frames() - atSixty - 120)).toBeLessThanOrEqual(2);

    // Same handle throughout: nothing was stopped and re-registered to pick this up.
    control.stop();
    const settled = frames();
    display.tick(60);
    expect(frames()).toBe(settled);
  });
});
