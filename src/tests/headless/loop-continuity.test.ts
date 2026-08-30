import { beforeAll, describe, expect, it } from "vitest";
import { fixturePlan } from "../../runtime/backend/vgpu/plan-fixture.ts";
// §V3: `src/runtime/backend/vgpu/` is the only place a `vgpu` import is legal, and the
// node host lives behind that boundary. Aliased because every claim here is about Dawn.
import { nodeGpuHost as dawnGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { PARITY_SIZE } from "../fixtures/parity-graphs.ts";
import { pixelAt } from "./pixel-compare.ts";
import { renderPlanHeadless } from "./render-harness.ts";

/**
 * A LAP DOES NOT RESTART THE FEEDBACK — ON THE PIXELS (T464, §V147).
 *
 * ## Why this test and not the structural one
 *
 * `src/app/timeline-loop.test.tsx` proves the MECHANISM: at a lap nothing calls
 * `resetTemporalHistory`, nothing calls the CPU reset, and no frame is replayed. That is
 * necessary and it is not sufficient, and the reason is the whole of §V147: a feedback
 * that restarts every lap still renders a moving picture. Every structural assertion in
 * the tree stays green through it, which is exactly why the OWNER was the one who noticed
 * — "we're resetting feedbacks and all kinds of things whenever the timeline loops back".
 *
 * The only thing that can tell the two apart is the ACCUMULATED VALUE across the boundary,
 * read off a real device. `fixturePlan` mixes a scene into a ping-pong pair 50/50 every
 * frame, so its red channel climbs geometrically towards the scene value and every step is
 * strictly larger than the last. Wrapping the timeline mid-run must not interrupt that:
 *
 *  - if the wrap CLEARED history, the series would fall back towards scene/2 at the wrap —
 *    a visible drop, which is the failure being gated;
 *  - if the wrap FROZE the pair, the series would go flat.
 *
 * Neither is possible without the series stopping its climb, so "still strictly
 * increasing, still converging" is the assertion.
 *
 * ## What it does NOT cover
 *
 * The live path's wrap runs through `liveClock.wrapTo`; this drives `offlineTransport`,
 * because the headless harness is where a device is. Both implement the same
 * `TransportSource.wrapTo` contract and `absolute-clock.test.ts` gates the live one's
 * behaviour directly, but a divergence between the two bodies would not be caught here.
 */

const SIZE = PARITY_SIZE;

let dawnError: string | undefined;
beforeAll(async () => {
  const probe = await probeDawn();
  dawnError = probe.error;
}, 60_000);

function requireDawn(): void {
  if (dawnError !== undefined) {
    throw new Error(
      `Dawn (vgpu/node) could not start, so the loop-continuity claim is unverified: ${dawnError}`,
    );
  }
}

describe("§V147/T464 — feedback survives a timeline wrap", () => {
  it("keeps accumulating across the lap instead of dropping back", async () => {
    requireDawn();
    const frames = 8;
    // Wrap after frame 3, which is the middle of the run: there is enough history before
    // it for a reset to be unmistakable, and enough after it to see the climb resume.
    const wrapAfter = 3;

    const { frames: captured, diagnostics } = await renderPlanHeadless({
      host: dawnGpuHost(),
      plan: fixturePlan({ size: [SIZE, SIZE] }),
      outputResourceId: "output",
      size: [SIZE, SIZE],
      format: "rgba8unorm",
      frames,
      capture: [0, 1, 2, 3, 4, 5, 6, 7],
      betweenFrames: (levers, index) => {
        // The lap: the timeline goes back to the in point and NOTHING else is touched.
        if (index === wrapAfter) levers.transport.wrapTo?.(0);
      },
    });

    expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(captured).toHaveLength(frames);

    const probeX = 48;
    const probeY = 32;
    const series = captured.map((frame) => pixelAt(frame, probeX, probeY)[0] ?? 0);

    // The claim, at the boundary specifically: frame 4 is the first frame of lap two and
    // must be BRIGHTER than frame 3, the last of lap one. A cleared history makes this the
    // one comparison in the series that goes the wrong way.
    expect(series[wrapAfter + 1]!).toBeGreaterThan(series[wrapAfter]!);

    // And across the whole run, so a wrap that half-cleared shows up too.
    for (let index = 1; index < series.length; index += 1) {
      expect(series[index]!, `frame ${String(index)} did not advance`).toBeGreaterThan(
        series[index - 1]!,
      );
    }

    // Non-vacuity: the series has to actually MOVE, or "strictly increasing" is being
    // satisfied by quantisation noise on a picture that never changed.
    expect(series.at(-1)! - series[0]!).toBeGreaterThan(0.1);
  }, 90_000);

  /**
   * SENSITIVITY, in a test rather than by breaking the tree (§V364).
   *
   * Without this the case above could be green because the fixture is insensitive to
   * temporal history rather than because the wrap preserved it. So the same run does what
   * a SEEK does — rewind the clock AND clear the history — at the same frame, and the
   * series has to fall. If this ever stops falling, the assertion above has stopped
   * measuring anything and both cases are worthless.
   */
  it("falls back when the history IS cleared, which is what makes the case above real", async () => {
    requireDawn();
    const frames = 8;
    const resetAfter = 3;

    const { frames: captured } = await renderPlanHeadless({
      host: dawnGpuHost(),
      plan: fixturePlan({ size: [SIZE, SIZE] }),
      outputResourceId: "output",
      size: [SIZE, SIZE],
      format: "rgba8unorm",
      frames,
      capture: [0, 1, 2, 3, 4, 5, 6, 7],
      betweenFrames: (levers, index) => {
        // Both halves of a seek — the rewind AND the clear (§V170, §V181). It is the
        // pairing that T464 says does not belong at a lap, performed here on purpose.
        if (index === resetAfter) {
          levers.transport.reset();
          levers.resetTemporalHistory();
        }
      },
    });

    const series = captured.map((frame) => pixelAt(frame, 48, 32)[0] ?? 0);
    // The drop. This is what the owner was seeing at every loop, and what the case above
    // asserts does NOT happen when the timeline merely wraps.
    expect(series[resetAfter + 1]!).toBeLessThan(series[resetAfter]!);
  }, 90_000);
});
