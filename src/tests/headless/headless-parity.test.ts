import { beforeAll, describe, expect, it } from "vitest";
import { mockGpuHost } from "../../runtime/backend/vgpu/mock-gpu-host.ts";
import { fixturePlan } from "../../runtime/backend/vgpu/plan-fixture.ts";
import { offlineTransport } from "../../runtime/execution/offline-transport.ts";
import {
  PARITY_CASES,
  nominalCapabilities,
  paritySettings,
} from "../fixtures/parity-graphs.ts";
// The sanctioned Dawn host (T160): `src/runtime/backend/vgpu/` is the only place a
// `vgpu` import is legal (§V3), and the node entry point now lives behind that
// boundary like every other one. Aliased to `dawnGpuHost` because every claim in
// this file is about Dawn specifically, not about "some node-side host".
import {
  nodeGpuHost as dawnGpuHost,
  probeDawn,
} from "../../runtime/backend/vgpu/node-gpu-host.ts";
import {
  TOLERANCE_CROSS_GPU,
  TOLERANCE_EXACT,
  compareFrames,
  describeDifference,
  imageDigest,
} from "./pixel-compare.ts";
import {
  compileParityGraph,
  renderHeadless,
  renderOnce,
  renderPlanHeadless,
} from "./render-harness.ts";

/**
 * T69 — headless parity (§V47, §V45).
 *
 * THE CLAIM UNDER TEST. The offline-render architecture rests on one sentence: the same
 * domain graph, through the same compiler, produces the same pixels in the browser and in
 * headless Node. Until this file existed, nothing checked any part of it.
 *
 * WHAT THIS FILE ACTUALLY EXECUTES, and what it does not:
 *
 *   EXECUTED — the compiler is device-agnostic for these graphs, no surface is involved in
 *   producing pixels, the same seed and frame indices replay byte-for-byte, and two
 *   independently created GPU devices agree exactly. Those are four of the five things
 *   "parity" means, and all four are real assertions against a real GPU (Dawn).
 *
 *   NOT EXECUTED — a real BROWSER WebGPU implementation compared against Dawn. That needs
 *   a browser with WebGPU that automation can drive, and this environment has none: every
 *   Chromium reachable from Playwright here reports `navigator.gpu === undefined`, headed
 *   or headless, bundled or system. The `it.todo` at the bottom of this file names that
 *   precisely rather than dressing a skip up as a pass. Everything it needs already exists
 *   in this directory; see the comment there for the exact remaining step.
 *
 * The line between the two is drawn where it is on purpose. A test that cannot fail is
 * worse than no test, so nothing here is written in a way that goes green when the GPU is
 * absent: `requireDawn()` throws with the verbatim init error instead.
 */

let dawnError: string | undefined;
let dawnAdapter: string | undefined;

beforeAll(async () => {
  const probe = await probeDawn();
  dawnError = probe.error;
  dawnAdapter = probe.adapter;
}, 60_000);

function requireDawn(): void {
  if (dawnError !== undefined) {
    throw new Error(`Dawn (vgpu/node) could not start; headless parity is unverified: ${dawnError}`);
  }
}

describe("T69 — the compiler is the same on both sides (§V47)", () => {
  /**
   * §V47 says "headless path = same graph + same compiler". If the plan differed at all
   * between the two paths, pixel parity would be meaningless — you would be comparing two
   * different programs. So the plan is compared first, and structurally, not by hash alone.
   */
  it.each(PARITY_CASES)("$name compiles identically twice, key order and all", ({ graph }) => {
    const first = compileParityGraph(graph(), nominalCapabilities());
    const second = compileParityGraph(graph(), nominalCapabilities());

    expect(first.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(first.signature).toBe(second.signature);
    expect(JSON.stringify(first.passes)).toBe(JSON.stringify(second.passes));
    expect(JSON.stringify(first.resources)).toBe(JSON.stringify(second.resources));
    expect(JSON.stringify(first.outputs)).toBe(JSON.stringify(second.outputs));
    expect(first.order).toEqual(second.order);
  });

  /**
   * The plan a real Dawn device produces must match the plan a nominal browser-tier
   * capability report produces. If it does not, cross-implementation parity is impossible
   * BY CONSTRUCTION for that graph and no amount of pixel tolerance would rescue it — the
   * two sides would be running different shaders into differently-formatted targets.
   *
   * This is allowed to legitimately fail for a graph whose format falls back on one device
   * and not the other (§V12/§V51). That would be a finding about the fixture, not a bug —
   * which is why the parity corpus deliberately sticks to core formats.
   */
  it.each(PARITY_CASES)("$name compiles the same against Dawn's real capabilities", async ({ graph }) => {
    requireDawn();
    const rendered = await renderHeadless({ host: dawnGpuHost(), graph: graph() });
    const nominal = compileParityGraph(graph(), nominalCapabilities());

    expect(rendered.capabilities.tier).not.toBe("C");
    expect(rendered.plan.signature).toBe(nominal.signature);
    expect(JSON.stringify(rendered.plan.passes)).toBe(JSON.stringify(nominal.passes));
    expect(JSON.stringify(rendered.plan.resources)).toBe(JSON.stringify(nominal.resources));
  }, 90_000);

  /**
   * The compiler must not require a GPU at all. The mock host has no device worth the name,
   * and the plan it yields still has to be the plan Dawn compiles — this is what lets a
   * headless renderer, an agent tool or a CI lint compile a project without hardware.
   */
  it.each(PARITY_CASES)("$name compiles to the same plan on the mock device", async ({ graph }) => {
    const mock = await renderHeadless({
      host: mockGpuHost(),
      graph: graph(),
      // The mock device cannot read a texture back, so nothing is captured.
      frames: 1,
      capture: [],
    });
    const nominal = compileParityGraph(graph(), nominalCapabilities());
    expect(mock.plan.signature).toBe(nominal.signature);
    expect(mock.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });
});

describe("T69 — pixels are the same with and without a surface (§V47)", () => {
  /**
   * The literal §V47 claim: the plan renders into offscreen targets whether or not a canvas
   * was supplied, so headless is the same code path rather than a variant of it.
   *
   * The canvas here is a structural stub, which is the right shape for this assertion: the
   * point is that `initialize()` must never REACH for the canvas to decide a format, a
   * size or a swap-chain configuration. If someone later makes initialization consult it,
   * this test fails by throwing on a property the stub does not have — which is the
   * failure mode you want, because that change is precisely what would break offline
   * rendering.
   *
   * Tolerance is EXACT (0). Same device, same commands; there is no float budget to spend.
   */
  it.each(PARITY_CASES)("$name is byte-identical offscreen and canvas-supplied", async ({ graph }) => {
    requireDawn();
    const offscreen = await renderOnce({ host: dawnGpuHost(), graph: graph() });
    const surfaced = await renderOnce({
      host: dawnGpuHost(),
      graph: graph(),
      canvas: { width: 64, height: 64 } as unknown as HTMLCanvasElement,
    });

    const difference = compareFrames(offscreen, surfaced, TOLERANCE_EXACT);
    expect(
      difference.matches,
      describeDifference(`offscreen vs canvas-supplied (${imageDigest(offscreen)})`, difference),
    ).toBe(true);
  }, 90_000);
});

describe("T69 — deterministic replay (§V45)", () => {
  /**
   * Same seed, same frame indices, two INDEPENDENT devices, byte-identical output.
   *
   * Two separate `init()` calls mean two GPUDevices, two sets of allocations and two
   * pipeline compilations — so this fails if anything in the path depends on allocation
   * order, on a pointer value, on wall-clock time (§V44) or on an unseeded random. It is
   * the closest thing to cross-machine parity that a single machine can honestly assert.
   */
  it.each(PARITY_CASES)("$name renders identically on two independent devices", async ({ graph }) => {
    requireDawn();
    const first = await renderOnce({ host: dawnGpuHost(), graph: graph() });
    const second = await renderOnce({ host: dawnGpuHost(), graph: graph() });

    const difference = compareFrames(first, second, TOLERANCE_EXACT);
    expect(
      difference.matches,
      describeDifference(`replay on a second device (${dawnAdapter ?? "unknown"})`, difference),
    ).toBe(true);
  }, 90_000);

  /**
   * A multi-frame sequence replays frame-for-frame — and the frames are not all the same.
   *
   * The second half matters as much as the first. A plan whose output never changes would
   * satisfy "replays identically" trivially, so the fixture is driven through a
   * time-dependent plan and the test insists the sequence actually MOVES before it insists
   * the movement repeats. Both halves come from `offlineTransport`, which divides rather
   * than accumulates: frame N lands on exactly N/fps with no clock read anywhere (§V49).
   */
  /**
   * A CHANGING frame sequence replays exactly.
   *
   * "Replays identically" is trivially true of a plan whose output never moves, so this
   * uses `fixturePlan()` — whose blue channel carries `tint + frameU.time` and whose red
   * carries a feedback accumulation — and asserts BOTH halves: the sequence genuinely
   * differs frame to frame, and running it again on a second device reproduces every
   * captured frame byte for byte. Drop either half and the test stops meaning anything.
   */
  it("a CHANGING frame sequence replays exactly across two devices", async () => {
    const capture = [0, 3, 7];
    requireDawn();

    const run = async () =>
      renderPlanHeadless({
        host: dawnGpuHost(),
        plan: fixturePlan({ size: [32, 32] }),
        outputResourceId: "output",
        size: [32, 32],
        format: "rgba8unorm",
        frames: 8,
        capture,
      });

    const runA = await run();
    const runB = await run();

    expect(runA.frames.map((f) => f.frameIndex)).toEqual(capture);

    // Half one: the sequence moves. Without this, half two is vacuous.
    const moved = compareFrames(runA.frames[0]!, runA.frames[2]!, TOLERANCE_EXACT);
    expect(moved.matches, "frames 0 and 7 are identical — the sequence is not animating").toBe(false);

    // Half two: it moves the SAME way on an independently created device.
    for (let i = 0; i < capture.length; i += 1) {
      const difference = compareFrames(runA.frames[i]!, runB.frames[i]!, TOLERANCE_EXACT);
      expect(
        difference.matches,
        describeDifference(`frame ${capture[i]} across two devices`, difference),
      ).toBe(true);
    }
  }, 120_000);

  /** §V7/§V48: the only readbacks are the ones a caller asked for. Playback adds none. */
  it("playback performs no readback of its own", async () => {
    requireDawn();
    const capture = [2, 5];
    const result = await renderHeadless({
      host: dawnGpuHost(),
      graph: PARITY_CASES[1]!.graph(),
      frames: 6,
      capture,
    });
    expect(result.readbacks).toBe(capture.length);
  }, 90_000);

  /**
   * The seed is a FRAME input, never a compile input.
   *
   * §V45 makes `randomSeed` part of the output's identity, and §V46 wants offline seek and
   * replay to be exact. Both require the seed to arrive per frame: bake it into a shader
   * and the plan becomes seed-specific, so changing the seed would recompile and seeking to
   * frame N would depend on how you got there. This pins the shape — the plan must be
   * seed-independent, while the frame input must carry the project's seed verbatim.
   *
   * v1 has no node that CONSUMES the seed yet (T65/T120), so this is deliberately a
   * structural assertion and not a pixel one. When a seeded node lands, the pixel version
   * belongs here and this comment goes away.
   */
  it("carries the project seed per frame, not baked into the plan", () => {
    const graph = PARITY_CASES[0]!.graph();
    const seeded = compileParityGraph(graph, nominalCapabilities(), paritySettings({ seed: 4242 }));
    const other = compileParityGraph(graph, nominalCapabilities(), paritySettings({ seed: 1 }));
    expect(seeded.signature).toBe(other.signature);
    expect(JSON.stringify(seeded.passes)).toBe(JSON.stringify(other.passes));

    const transport = offlineTransport({ fps: 60, seed: 4242, mode: "fixed-step" });
    const frames = [transport.next(), transport.next(), transport.next()];
    expect(frames.map((f) => f.randomSeed)).toEqual([4242, 4242, 4242]);
    expect(frames.map((f) => f.frameIndex)).toEqual([0, 1, 2]);
    // Divided, not accumulated: seeking to frame N must not depend on the frames before it.
    expect(frames.map((f) => f.timeSeconds)).toEqual([0, 1 / 60, 2 / 60]);
    // A reset replays the identical sequence — the offline render queue's restart path.
    transport.reset();
    expect(transport.next()).toEqual(frames[0]);
  });
});

describe("T69 — browser vs Dawn", () => {
  /**
   * NOT RUN HERE, and the reason is a fact about this machine, not a decision:
   *
   *   Playwright's bundled Chromium (1234 and 1169) and the system
   *   /Applications/Google Chrome.app all report `navigator.gpu === undefined` under
   *   automation, headless and headed, with and without --enable-unsafe-webgpu. There is
   *   no browser here that can produce the other half of the comparison.
   *
   * WHAT IS ALREADY BUILT, so that this is one WebGPU-capable browser away:
   *   - the fixture graphs (`src/tests/fixtures/parity-graphs.ts`) are plain data and load
   *     in a browser unchanged;
   *   - `renderHeadless()` is parameterised by `GpuHost` and by nothing else, so the
   *     browser side is `browserGpuHost()` — which already exists in the runtime — plus a
   *     `readOutput()` call, and no new rendering code at all;
   *   - `compareFrames(..., TOLERANCE_CROSS_GPU)` is the comparison, at one 8-bit quantum,
   *     with the reasoning for that number written down in `pixel-compare.ts`.
   *
   * WHAT REMAINS: a Playwright spec under `src/tests/e2e/` that serves the app, runs
   * `renderHeadless({ host: browserGpuHost(), ... })` inside `page.evaluate`, ships the
   * bytes back, and compares them against a Dawn render performed in the same Node process.
   * It is deliberately NOT written yet: it cannot be executed here, and an unrunnable test
   * asserting a green result is the exact thing this file refuses to ship.
   */
  it.todo(
    "same graph in a real browser WebGPU implementation matches Dawn within TOLERANCE_CROSS_GPU " +
      "— blocked: no browser on this machine exposes navigator.gpu under automation",
  );

  /** The tolerance the pending test will use, pinned so it cannot drift unnoticed. */
  it("states the cross-implementation tolerance as one 8-bit quantum", () => {
    expect(TOLERANCE_CROSS_GPU).toBeCloseTo(1 / 255, 10);
  });
});

/**
 * B161 — a frame's pixels must not depend on WHICH frames were captured (§V732).
 *
 * The harness capturing frame 0 must not change frame N. A readback is a copy, never a
 * mutation, and if two capture lists produce different bytes for the same frame then a
 * capture — an observation — is perturbing the thing observed, and every cross-run
 * baseline comparison is quietly comparing apples that were measured differently. The
 * defect was found on E27 (~0.5% divergence) and named `analyze`'s one-frame readback or
 * the cache ring perturbed by a frame-0 readback as suspects.
 *
 * A cache graph is the fixture because it is the stateful path that carries pixels across
 * frames — exactly where a stray frame-0 readback could leave a fingerprint. The same
 * frame is captured under two different lists and its bytes must hash identically.
 */
describe("B161 — captures are observations, not mutations", () => {
  const cacheGraph = () =>
    ({
      revision: 1,
      groups: {},
      nodes: {
        src: { id: "src", type: "noise", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { type: "perlin4d", speed: 1.5, period: 0.35 } },
        hold: { id: "hold", type: "cache", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { frames: 4, index: 2, scale: 1 } },
        out: { id: "out", type: "output", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
      },
      edges: {
        e0: { id: "e0", source: { nodeId: "src", portId: "out" }, target: { nodeId: "hold", portId: "input" } },
        e1: { id: "e1", source: { nodeId: "hold", portId: "out" }, target: { nodeId: "out", portId: "input" } },
      },
    }) as never;

  it("the same frame hashes identically under two different capture lists", async () => {
    requireDawn();
    const frameUnder = async (capture: number[]) => {
      const result = await renderHeadless({
        host: dawnGpuHost(),
        graph: cacheGraph(),
        frames: 9,
        capture,
        animate: true,
        outputNodeId: "out",
      });
      const frame = result.frames.find((entry) => entry.frameIndex === 8);
      if (frame === undefined) throw new Error("frame 8 not captured");
      return frame;
    };
    // Bare: frame 8 alone. Perturbed: frame 0 (the empty-ring frame, the suspect) and
    // frame 8. If capturing frame 0 leaves any fingerprint on the ring, frame 8 diverges.
    const bare = await frameUnder([8]);
    const perturbed = await frameUnder([0, 8]);
    expect(imageDigest(perturbed)).toBe(imageDigest(bare));
  }, 90_000);

  /**
   * The second half, and the one §B160's cache fix did NOT dissolve: the ANALYZE readback.
   * A feedback loop — analyze meters the frame, channelIn brings the number back to drive
   * the brightness that produced it — so a single perturbed reading cascades into a visibly
   * different frame 8.
   *
   * The cause was §V144's latency going non-deterministic. Analyze sampling is
   * fire-and-forget with an in-flight guard; the harness used to await only the raw
   * readback promise, not analyze's full `.finally(clear guard)` chain, so the guard could
   * still be set at the next sample and every other frame was skipped. A captured frame's
   * extra readback injected microtasks that shifted that phase by one — the observer effect.
   * The fix: `sample()` returns its whole chain and the harness awaits THAT, so the guard is
   * always clear before the next sample and the phase cannot move.
   */
  const analyzeGraph = () =>
    ({
      revision: 1,
      groups: {},
      nodes: {
        src: { id: "src", type: "noise", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { type: "perlin4d", speed: 1.5, period: 0.35 } },
        gain: {
          id: "gain",
          type: "level",
          definitionVersion: 1,
          position: { x: 0, y: 0 },
          parameters: {
            blacklevel: 0,
            whitelevel: 1,
            gamma1: 1,
            contrast: 1,
            brightness: { mode: "driven", bindings: { static: { kind: "static", value: 1 }, driven: { kind: "driven", channel: "meter1" } } },
            opacity: 1,
          },
        },
        meter: { id: "meter", type: "analyze", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { channel: "luminance", operation: "average" }, label: "meter1" },
        probe: { id: "probe", type: "channelIn", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { channel: "meter1", fallback: 0.5 } },
        out: { id: "out", type: "output", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
      },
      edges: {
        e0: { id: "e0", source: { nodeId: "src", portId: "out" }, target: { nodeId: "gain", portId: "input" } },
        e1: { id: "e1", source: { nodeId: "gain", portId: "out" }, target: { nodeId: "meter", portId: "input" } },
        e2: { id: "e2", source: { nodeId: "gain", portId: "out" }, target: { nodeId: "out", portId: "input" } },
      },
    }) as never;

  it("an analyze-driven frame does not depend on which frames were captured", async () => {
    requireDawn();
    const frameUnder = async (capture: number[]) => {
      const result = await renderHeadless({
        host: dawnGpuHost(),
        graph: analyzeGraph(),
        frames: 9,
        capture,
        animate: true,
        outputNodeId: "out",
      });
      const frame = result.frames.find((entry) => entry.frameIndex === 8);
      if (frame === undefined) throw new Error("frame 8 not captured");
      return frame;
    };
    const bare = await frameUnder([8]);
    const perturbed = await frameUnder([0, 8]);
    expect(imageDigest(perturbed)).toBe(imageDigest(bare));
  }, 90_000);
});
