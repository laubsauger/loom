import { describe, expect, it } from "vitest";
import { liveClock } from "./live-clock.ts";

/** §V45: same seed and frame index must reproduce the same frame input. */
describe("liveClock", () => {
  it("advances frameIndex monotonically from zero", () => {
    let t = 0;
    const clock = liveClock({ now: () => (t += 16.67) });

    expect(clock.next().frameIndex).toBe(0);
    expect(clock.next().frameIndex).toBe(1);
    expect(clock.next().frameIndex).toBe(2);
  });

  it("reports realtime mode and carries the project seed", () => {
    const clock = liveClock({ seed: 4242, now: () => 0 });
    const frame = clock.next();

    expect(frame.mode).toBe("realtime");
    expect(frame.randomSeed).toBe(4242);
  });

  it("clamps delta so a backgrounded tab cannot hand a simulation a huge step", () => {
    let t = 0;
    const clock = liveClock({ maxDeltaSeconds: 0.25, now: () => t });

    clock.next();
    t = 60_000; // tab slept a minute
    expect(clock.next().deltaSeconds).toBe(0.25);
  });

  it("first frame has zero delta rather than a jump from an unset baseline", () => {
    const clock = liveClock({ now: () => 999_999 });
    expect(clock.next().deltaSeconds).toBe(0);
  });

  it("reset restarts frame index and reseeds", () => {
    let t = 0;
    const clock = liveClock({ seed: 1, now: () => (t += 10) });
    clock.next();
    clock.next();

    clock.reset(7);
    const frame = clock.next();
    expect(frame.frameIndex).toBe(0);
    expect(frame.randomSeed).toBe(7);
    expect(frame.deltaSeconds).toBe(0);
  });
});
