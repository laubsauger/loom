import { describe, expect, it } from "vitest";

import type { BackendCapabilities } from "../../../domain/types/backend.ts";
import type { GraphDocument, GraphNode, ProjectSettings } from "../../../domain/types/graph.ts";
import { compileGraph } from "../../../compiler/compile.ts";
import { createNodeRegistry } from "../../../nodes/registry/registry.ts";
import { allNodeDefinitions, mediaSourceIdFor } from "../../../nodes/definitions/index.ts";
import { resourceStructureKey } from "../plan.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";

/**
 * T773 (§B157, §V759) — THE BOUNDARY RITE CLEARS EXTERNAL TEXTURES, and this is the gate
 * §T764's stated exception never got.
 *
 * §T764 cleared plain targets, pairs, rings and buffer pairs and wrote that external
 * textures need none of it, "no render-attachment usage, and the media pipeline
 * re-registers per document". §V759's rule is that an exception stated at landing is a
 * PREDICTION and must be tested like one. Both clauses were false:
 *
 *  - `resources.ts` creates every external texture with `render_attachment` usage,
 *    because `copyExternalImageToTexture` requires it. They were always clearable.
 *  - `use-media-sources` keys its open effect on `nodeId|type|url` with NO document
 *    identity, and every shipped movie example ships the same node id `clip` with
 *    `file: ""`. So the owner's sequence — pick a video, then load another example that
 *    also has a Movie File In — UNREGISTERS the source and registers nothing, while the
 *    carry-over diff reuses the same-id same-size same-format external texture. Nothing
 *    overwrites it, and document B's node blits document A's last decoded frame.
 *
 * WHY TWO DOCUMENTS. A single-document fixture structurally cannot see this: within one
 * document a carried texture keeping its pixels is the CORRECT behaviour (§V136 — a
 * paused video frame must survive an unrelated edit, which `external-texture.gpu.test.ts`
 * pins and this change leaves alone). The defect only exists at the seam between two
 * documents, so the fixture crosses it, and the identity assertion below proves the two
 * plans really do collide on the texture — without it this test could pass because the
 * texture was reallocated, not because it was cleared (§V739).
 */

const SIZE = 16;

const settings = {
  outputResolution: { width: SIZE, height: SIZE },
  workingFormat: "rgba8unorm",
  randomSeed: 3,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
} as unknown as ProjectSettings;

const capabilities = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
} as unknown as BackendCapabilities;

const node = (id: string, type: string, extra: Partial<GraphNode> = {}): GraphNode =>
  ({ id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {}, ...extra }) as GraphNode;

/** rgba8unorm on the movie node so the readback bytes compare directly. */
const clip = (parameters: Record<string, unknown>): GraphNode =>
  node("clip", "movieFileIn", {
    format: { mode: "fixed", format: "rgba8unorm" },
    parameters,
  } as Partial<GraphNode>);

/**
 * Document A: the one the user picked a video on. `clip` -> `sink`.
 */
const DOCUMENT_A = {
  revision: 1,
  nodes: { clip: clip({ file: "a.mp4", speed: 1 }), sink: node("sink", "output") },
  edges: {
    e0: { id: "e0", source: { nodeId: "clip", portId: "out" }, target: { nodeId: "sink", portId: "input" } },
  },
  groups: {},
} as unknown as GraphDocument;

/**
 * Document B: a DIFFERENT example that also has a Movie File In — different node set,
 * different wiring, and (like every shipped movie example) `file: ""`, so its media node
 * opens nothing and registers nothing. It shares the node id `clip`, which is not a
 * contrivance: all six shipped movie examples name it `clip`.
 */
const DOCUMENT_B = {
  revision: 1,
  nodes: {
    clip: clip({ file: "", speed: 2 }),
    grade: node("grade", "level"),
    display: node("display", "output"),
  },
  edges: {
    e0: { id: "e0", source: { nodeId: "clip", portId: "out" }, target: { nodeId: "grade", portId: "input" } },
    e1: { id: "e1", source: { nodeId: "grade", portId: "out" }, target: { nodeId: "display", portId: "input" } },
  },
  groups: {},
} as unknown as GraphDocument;

/**
 * Document U: the §V687 UNDERSTUDY RIG, which is what the shipped movie examples
 * (E41-E44) actually are — `movieFileIn` behind a Switch with a MOVING synthetic
 * performer, so the example works with no file chosen and no camera permission.
 *
 * `pick` selects order 0, the understudy, exactly as every shipped example ships it
 * (`node("pick", "switch", ..., { index: 0 })`). That makes THREE states which look
 * superficially alike on a canvas and must be told apart BY NAME, never by "the pixels
 * changed": (1) the understudy — correct, deliberate, what a freshly loaded document
 * SHOULD show; (2) the owner's chosen file — correct once picked; (3) the previous
 * document's file — §B157, and the only defect of the three.
 */
const DOCUMENT_UNDERSTUDY = {
  revision: 1,
  nodes: {
    // The performer MOVES: §V687 — for an example whose subject is change, a still
    // understudy opens black and reads as broken. Here the motion is also what tells
    // state (1) apart from state (3), because a stale frame is FROZEN by construction:
    // the source that produced it is gone.
    bed: node("bed", "noise", {
      parameters: {
        type: "perlin4d", seed: 11, period: 0.35, harmon: 2, spread: 2, gain: 0.5,
        rough: 0.5, exp: 1, amp: 1, offset: 0.5, mono: true, aspectcorrect: true,
        speed: 1.5, t4d: 0, s4d: 1,
      },
    } as Partial<GraphNode>),
    clip: clip({ file: "", speed: 1 }),
    pick: node("pick", "switch", { parameters: { index: 0 } } as Partial<GraphNode>),
    sink: node("sink", "output"),
  },
  edges: {
    e0: { id: "e0", source: { nodeId: "bed", portId: "out" }, target: { nodeId: "pick", portId: "inputs" }, order: 0 },
    e1: { id: "e1", source: { nodeId: "clip", portId: "out" }, target: { nodeId: "pick", portId: "inputs" }, order: 1 },
    e2: { id: "e2", source: { nodeId: "pick", portId: "out" }, target: { nodeId: "sink", portId: "input" } },
  },
  groups: {},
} as unknown as GraphDocument;

function solid(r: number, g: number, b: number): Uint8Array {
  const bytes = new Uint8Array(SIZE * SIZE * 4);
  for (let index = 0; index < bytes.length; index += 4) bytes.set([r, g, b, 255], index);
  return bytes;
}

describe("the boundary rite clears external textures (T773, §B157, §V759)", () => {
  it("document B presents B's source, never A's decoded frames", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const registry = createNodeRegistry(allNodeDefinitions).view();
    const planA = compileGraph({ graph: DOCUMENT_A, settings, registry, capabilities });
    const planB = compileGraph({ graph: DOCUMENT_B, settings, registry, capabilities });
    expect(planA.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(planB.diagnostics.filter((d) => d.severity === "error")).toEqual([]);

    // The collision that makes the carry possible, asserted rather than assumed: the two
    // documents' media textures are the SAME resource by structure key, so the second
    // compile reuses the first's texture and its pixels. If this ever stops holding, the
    // pixel assertions below would pass for a reason unrelated to their claim (§V739).
    const externalOf = (plan: { resources: readonly unknown[] }) =>
      plan.resources.find((r) => (r as { kind: string }).kind === "externalTexture");
    const externalA = externalOf(planA);
    const externalB = externalOf(planB);
    expect(externalA).toBeDefined();
    expect((externalA as { sourceId: string }).sourceId).toBe(mediaSourceIdFor("clip"));
    expect(resourceStructureKey(externalB as never)).toBe(resourceStructureKey(externalA as never));

    const backend = createVgpuBackend({ host: nodeGpuHost() });
    const frameAt = (frameIndex: number) => ({
      frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex, mode: "offline" as const, randomSeed: 3 },
      pointer: { x: 0, y: 0, buttons: 0 },
      resolution: [SIZE, SIZE] as [number, number],
    });
    /** The movie node's OWN output — what the canvas and the node preview both show. */
    const clipPixels = async (): Promise<readonly number[]> => {
      const image = await backend.readOutput("target:clip:out");
      const offset = (8 * SIZE + 8) * 4;
      return [...image.bytes.slice(offset, offset + 4)];
    };

    try {
      await backend.initialize({});

      // 1. Document A, with the video the user picked. Red reaches the node's output.
      const compiledA = await backend.compile(planA);
      const unregisterA = backend.registerMediaSource(mediaSourceIdFor("clip"), {
        currentFrame: () => ({ frameId: 1, bytes: solid(255, 0, 0) }),
      });
      backend.render(compiledA, frameAt(0));
      expect(await clipPixels()).toEqual([255, 0, 0, 255]);

      // 2. The load. `use-media-sources` re-runs (B's `file` differs from A's), so it
      //    unregisters A's source — and registers NOTHING, because B's movie node has no
      //    file chosen. This is the exact app-side sequence, not a stand-in for it.
      unregisterA();
      const compiledB = await backend.compile(planB);

      // 3. The load path's boundary rite, verbatim from `use-frame-loop`.
      backend.resetTemporalHistory(undefined, { buffers: true, silent: true });

      // 4. THE DEFECT. Before this fix the render below blitted the CARRIED external
      //    texture, still holding A's red, into B's node — "the canvas and preview stays
      //    stale on the prior one". B has no source, so B's movie node is black.
      backend.render(compiledB, frameAt(1));
      expect(await clipPixels()).not.toEqual([255, 0, 0, 255]);
      expect(await clipPixels()).toEqual([0, 0, 0, 0]);

      // 5. And B presents B's OWN source once it has one — the clear does not cost the
      //    incoming document its picture.
      backend.registerMediaSource(mediaSourceIdFor("clip"), {
        currentFrame: () => ({ frameId: 1, bytes: solid(0, 0, 255) }),
      });
      backend.render(compiledB, frameAt(2));
      expect(await clipPixels()).toEqual([0, 0, 255, 255]);
    } finally {
      backend.dispose();
    }
  }, 120_000);

  /**
   * The other direction, and the reason the clear resets `lastFrameId` with the pixels.
   *
   * A webcam and a Text node carry no url, so their effect key `nodeId|type|` is CONSTANT
   * across every document naming that id — the open effect never re-runs and the source
   * stays registered across the load. That is deliberate for a camera: re-opening one
   * would re-prompt for permission and blank the node, so this fix does NOT add a
   * document identity to the media key. But a still-registered source has not advanced
   * its frameId, so clearing the texture ALONE would leave it permanently black. Cleared
   * together with the cursor, it re-uploads on the next tick and heals itself.
   */
  it("a source still registered across the boundary re-uploads instead of going black", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const registry = createNodeRegistry(allNodeDefinitions).view();
    const planA = compileGraph({ graph: DOCUMENT_A, settings, registry, capabilities });
    const planB = compileGraph({ graph: DOCUMENT_B, settings, registry, capabilities });

    const backend = createVgpuBackend({ host: nodeGpuHost() });
    const frameAt = (frameIndex: number) => ({
      frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex, mode: "offline" as const, randomSeed: 3 },
      pointer: { x: 0, y: 0, buttons: 0 },
      resolution: [SIZE, SIZE] as [number, number],
    });
    const clipPixels = async (): Promise<readonly number[]> => {
      const image = await backend.readOutput("target:clip:out");
      const offset = (8 * SIZE + 8) * 4;
      return [...image.bytes.slice(offset, offset + 4)];
    };

    try {
      await backend.initialize({});
      const compiledA = await backend.compile(planA);
      // A LIVE source, never unregistered — the webcam/text case. Its frameId is frozen
      // at 1 across the whole test: nothing about the load makes a camera produce a new
      // frame id, which is precisely the trap.
      backend.registerMediaSource(mediaSourceIdFor("clip"), {
        currentFrame: () => ({ frameId: 1, bytes: solid(0, 255, 0) }),
      });
      backend.render(compiledA, frameAt(0));
      expect(await clipPixels()).toEqual([0, 255, 0, 255]);

      const compiledB = await backend.compile(planB);
      backend.resetTemporalHistory(undefined, { buffers: true, silent: true });
      backend.render(compiledB, frameAt(1));

      // Green again, from a RE-UPLOAD rather than from the stale texture: the pixels and
      // the upload cursor were cleared together. A clear that forgot the cursor would
      // read [0,0,0,0] here and the camera would never come back.
      expect(await clipPixels()).toEqual([0, 255, 0, 255]);
    } finally {
      backend.dispose();
    }
  }, 120_000);

  /**
   * THE THREE STATES, TOLD APART BY NAME (§V687, §V681).
   *
   * The owner's warning to every worker on this: "dont stumble over our examples that
   * switch between placeholder and actual video". A newly loaded example showing moving
   * synthetic footage instead of the video picked in the PREVIOUS document is not
   * necessarily stale — it may be the understudy doing its job. So this asserts WHICH of
   * the three is on screen rather than that anything changed, and it does so on both
   * surfaces the owner named ("the canvas and preview"):
   *
   *   - the CANVAS (`target:pick:out`, through the Switch) must be the UNDERSTUDY: not
   *     the prior document's red, non-black, and MOVING across a frame pair — which is
   *     the assertion that separates a live performer from a frozen stale frame, and is
   *     §V687's own lesson that a motion claim is made across a PAIR, never from a still.
   *   - the PREVIEW (`target:clip:out`, the movie node's own tile) must be BLACK: the
   *     node has no file, so it has no picture, and it must not be wearing document A's.
   *
   * And the fix must not trade a confusing bug for a broken default: if clearing external
   * textures blanked the understudy, this reddens.
   */
  it("a loaded example falls back to its MOVING understudy, not the prior document's file", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const registry = createNodeRegistry(allNodeDefinitions).view();
    const planA = compileGraph({ graph: DOCUMENT_A, settings, registry, capabilities });
    const planU = compileGraph({ graph: DOCUMENT_UNDERSTUDY, settings, registry, capabilities });
    expect(planU.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    // Same collision as above: the understudy document's movie node carries A's texture.
    const externalOf = (plan: { resources: readonly unknown[] }) =>
      plan.resources.find((r) => (r as { kind: string }).kind === "externalTexture");
    expect(resourceStructureKey(externalOf(planU) as never)).toBe(
      resourceStructureKey(externalOf(planA) as never),
    );

    const backend = createVgpuBackend({ host: nodeGpuHost() });
    const frameAt = (frameIndex: number, timeSeconds: number) => ({
      frame: { timeSeconds, deltaSeconds: 1 / 60, frameIndex, mode: "offline" as const, randomSeed: 3 },
      pointer: { x: 0, y: 0, buttons: 0 },
      resolution: [SIZE, SIZE] as [number, number],
    });
    const pixelsOf = async (resourceId: string): Promise<Uint8Array> =>
      (await backend.readOutput(resourceId)).bytes.slice(0, SIZE * SIZE * 4);

    try {
      await backend.initialize({});

      // STATE (2): document A, the owner's chosen file. Red reaches the movie node.
      const compiledA = await backend.compile(planA);
      const unregisterA = backend.registerMediaSource(mediaSourceIdFor("clip"), {
        currentFrame: () => ({ frameId: 1, bytes: solid(255, 0, 0) }),
      });
      backend.render(compiledA, frameAt(0, 0));
      expect([...(await pixelsOf("target:clip:out")).slice(0, 4)]).toEqual([255, 0, 0, 255]);

      // The load: A's source goes, the understudy example's movie node names no file.
      unregisterA();
      const compiledU = await backend.compile(planU);
      backend.resetTemporalHistory(undefined, { buffers: true, silent: true });

      backend.render(compiledU, frameAt(1, 0));
      const canvasEarly = await pixelsOf("target:pick:out");
      const previewAfterLoad = await pixelsOf("target:clip:out");
      backend.render(compiledU, frameAt(2, 1.7));
      const canvasLate = await pixelsOf("target:pick:out");

      // NOT state (3). The canvas is not showing document A's decoded frame.
      const isRed = (bytes: Uint8Array) =>
        bytes[0] === 255 && bytes[1] === 0 && bytes[2] === 0 && bytes[3] === 255;
      expect(isRed(canvasEarly)).toBe(false);
      expect(isRed(canvasLate)).toBe(false);

      // IS state (1). The understudy is genuinely on screen — lit, not a blank pane...
      expect(Math.max(...canvasEarly)).toBeGreaterThan(0);
      // ...and MOVING, which no stale frame can be: its source is gone, so it is frozen.
      // §V687/§V681 — the claim is about correspondence across frames, so assert across
      // a PAIR. A still understudy would read as broken and this would redden.
      expect([...canvasLate]).not.toEqual([...canvasEarly]);

      // And the PREVIEW half of the owner's sentence: the movie node's own tile. It has
      // no file, so it has no picture — black, and emphatically not document A's red.
      expect(isRed(previewAfterLoad)).toBe(false);
      expect(Math.max(...previewAfterLoad)).toBe(0);
    } finally {
      backend.dispose();
    }
  }, 120_000);
});
