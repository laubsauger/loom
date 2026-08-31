import { beforeAll, describe, expect, it } from "vitest";

import { flattenComponents } from "../../compiler/index.ts";
import {
  nodeGpuHost as dawnGpuHost,
  probeDawn,
} from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { animatedComponentSystem, twoInstanceDocument } from "../fixtures/animated-component.ts";
import { TOLERANCE_EXACT, compareFrames, describeDifference, imageDigest } from "./pixel-compare.ts";
import { renderHeadless } from "./render-harness.ts";
import type { RenderedFrame } from "./render-harness.ts";

/**
 * §V47 FOR AN ANIMATED COMPONENT — and until T615 the claim was VACUOUS (T608).
 *
 * §V47 says the headless path is the same graph through the same compiler. For a document
 * containing components that was not merely untested, it was untestable: `renderHeadless`
 * never passed a component catalogue at all, so every instance fell through to the
 * manifest's `component.notFlattened` tripwire and produced no passes. The live path was
 * separately broken — nothing inside a component animated there either. The two halves
 * agreed, and they agreed on nothing.
 *
 * So this file has to assert two different things, and the second is what makes the first
 * mean anything:
 *
 *   1. PARITY — the animated component renders identically with and without a surface, and
 *      identically on a replay.
 *   2. NON-VACUITY — the frames actually MOVE, and they move because of the component's
 *      internals. A static render passes every parity assertion ever written (§V461).
 *
 * And one equivalence, which is the compiler-level statement of what a component IS: the
 * document with instances and the already-flattened document render byte-for-byte the
 * same. Flattening is an inlining and nothing else (§V82).
 */

let dawnError: string | undefined;

beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

function requireDawn(): void {
  if (dawnError !== undefined) {
    throw new Error(
      `Dawn (vgpu/node) could not start, so component parity is unverified: ${dawnError}`,
    );
  }
}

function system() {
  const { components } = animatedComponentSystem();
  return components.view();
}

/** The same run every case below performs, so only the varied input differs. */
async function renderComponentDocument(options: { canvas?: boolean } = {}) {
  return renderHeadless({
    host: dawnGpuHost(),
    graph: twoInstanceDocument(),
    components: system(),
    animate: true,
    frames: 6,
    capture: [1, 5],
    ...(options.canvas === true
      ? { canvas: { width: 64, height: 64 } as unknown as HTMLCanvasElement }
      : {}),
  });
}

function frameOf(frames: ReadonlyArray<RenderedFrame>, index: number): RenderedFrame {
  const found = frames.find((frame) => frame.frameIndex === index);
  if (found === undefined) throw new Error(`no captured frame ${String(index)}`);
  return found;
}

describe("T615/§V47 — an animated component renders the same offline as live", () => {
  it("compiles at all, which it could not before a catalogue reached the harness", async () => {
    requireDawn();
    const rendered = await renderComponentDocument();
    // B29's tripwire is the thing that used to fire here. Naming it means a regression
    // reads as "components stopped flattening" rather than as a pixel difference.
    const errors = rendered.plan.diagnostics.filter((entry) => entry.severity === "error");
    expect(errors).toEqual([]);
    expect(rendered.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
    // Both instances are in the plan, as separate nodes with separate resources.
    const nodes = new Set(
      rendered.plan.passes.map((pass) => ("nodeId" in pass ? pass.nodeId : undefined)),
    );
    expect(nodes.has("c1/blur")).toBe(true);
    expect(nodes.has("c2/blur")).toBe(true);
  }, 120_000);

  it("MOVES — the component's own animation reaches the pixels (non-vacuity, §V461)", async () => {
    requireDawn();
    const rendered = await renderComponentDocument();
    const early = frameOf(rendered.frames, 1);
    const late = frameOf(rendered.frames, 5);
    const difference = compareFrames(early, late, TOLERANCE_EXACT);
    // If this ever goes quiet, every parity assertion below is comparing two still images
    // and proving nothing — which is exactly the state this whole task found.
    expect(
      difference.matches,
      `the animated component did not move at all (${imageDigest(early)})`,
    ).toBe(false);
  }, 120_000);

  it("MOVES BECAUSE OF THE ANIMATION, not because of its feedback loop (§V461)", async () => {
    requireDawn();
    // The sharp version of the case above, and the reason it is not enough on its own: the
    // fixture contains a Feedback, and a feedback loop accumulates across frames whether or
    // not anything animates. So "the frames differ" was satisfiable by a document whose
    // component was entirely frozen — the exact blindness §V461 is about.
    //
    // The control is the SAME document with the per-frame value graph and uniform push
    // switched OFF. If the component's internal animation were dead, the driven blur would
    // sit at its retained static in both runs and the two would be byte-identical.
    const animated = await renderComponentDocument();
    const frozen = await renderHeadless({
      host: dawnGpuHost(),
      graph: twoInstanceDocument(),
      components: system(),
      animate: false,
      frames: 6,
      capture: [5],
    });
    const difference = compareFrames(
      frameOf(animated.frames, 5),
      frameOf(frozen.frames, 5),
      TOLERANCE_EXACT,
    );
    expect(
      difference.matches,
      "animated and un-animated renders were identical, so the component's own animation reaches nothing",
    ).toBe(false);
  }, 180_000);

  it("is byte-identical with and without a surface (§V47's literal claim)", async () => {
    requireDawn();
    const offscreen = await renderComponentDocument();
    const surfaced = await renderComponentDocument({ canvas: true });
    for (const index of [1, 5]) {
      const difference = compareFrames(
        frameOf(offscreen.frames, index),
        frameOf(surfaced.frames, index),
        TOLERANCE_EXACT,
      );
      expect(
        difference.matches,
        describeDifference(`frame ${String(index)} offscreen vs canvas-supplied`, difference),
      ).toBe(true);
    }
  }, 180_000);

  it("replays byte-identically, so an animated component is deterministic (§V45)", async () => {
    requireDawn();
    const first = await renderComponentDocument();
    const second = await renderComponentDocument();
    for (const index of [1, 5]) {
      const difference = compareFrames(
        frameOf(first.frames, index),
        frameOf(second.frames, index),
        TOLERANCE_EXACT,
      );
      expect(difference.matches, describeDifference(`replay of frame ${String(index)}`, difference)).toBe(true);
    }
  }, 180_000);

  it("equals the ALREADY-FLAT document: flattening is an inlining and nothing else (§V82)", async () => {
    requireDawn();
    const { components, registry } = animatedComponentSystem();
    const flattened = flattenComponents({
      graph: twoInstanceDocument(),
      registry,
      components: components.view(),
    });

    const viaComponents = await renderComponentDocument();
    const viaFlat = await renderHeadless({
      host: dawnGpuHost(),
      // No catalogue: this document has no instances left to flatten.
      graph: flattened.graph,
      animate: true,
      frames: 6,
      capture: [1, 5],
    });

    for (const index of [1, 5]) {
      const difference = compareFrames(
        frameOf(viaComponents.frames, index),
        frameOf(viaFlat.frames, index),
        TOLERANCE_EXACT,
      );
      expect(
        difference.matches,
        describeDifference(`frame ${String(index)} instanced vs pre-flattened`, difference),
      ).toBe(true);
    }
  }, 180_000);
});
