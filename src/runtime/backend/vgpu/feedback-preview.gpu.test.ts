import { beforeAll, describe, expect, it } from "vitest";

import { compileGraph } from "../../../compiler/index.ts";
import { createNodeRegistry } from "../../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../../../nodes/definitions/index.ts";
import type { GraphDocument, ProjectSettings } from "../../../domain/types/graph.ts";
import type { BackendCapabilities } from "../../../domain/types/backend.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";
import type { GpuHost, GpuSession } from "./gpu-host.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";
import { buildPreviewProgram } from "../../previews/program.ts";
import { createTileAtlas } from "../../previews/tile-atlas.ts";
import { DEFAULT_PREVIEW_VIEW } from "../../previews/types.ts";
import type { PreviewFrameCommand, PreviewRequest } from "../../previews/types.ts";

/**
 * T620 — a FEEDBACK node's preview must bind its ping-pong history, not error.
 *
 * The owner's report: on a plain `solid1 → feedback1`, the diagnostics ring carried
 * `Pass "preview/pass/feedback1:out" binds unknown texture …` once per second, forever —
 * the exact re-emission T596 made survivable without making correct. A feedback output's
 * resource is a ping-pong PAIR (`pingpong:<node>:<port>`), not a plain target, and the
 * preview program binds it as an external from the main program — so every map on that
 * path (build-time resolution, the external re-point after a main recompile, the per-frame
 * re-point after swaps) must know pairs as well as it knows targets.
 *
 * Everything here is the real stack (V245): the real compiler with a preview sink on the
 * feedback's out, the real vgpu backend on a real Dawn device, the real
 * `buildPreviewProgram`, and the diagnostics are whatever the backend actually reported.
 */

const RENDER_ATTACHMENT = 0x10;
const TEXTURE_BINDING = 0x04;
const COPY_SRC = 0x01;

const SIZE = 8;

const CAPS: BackendCapabilities = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
};

const SETTINGS: ProjectSettings = {
  outputResolution: { width: SIZE, height: SIZE },
  workingFormat: "rgba8unorm",
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: {
    maxResolution: 4096,
    maxDispatch: 65535,
    maxBufferBytes: 268_435_456,
    memoryBudgetBytes: 1_073_741_824,
  },
};

/** The report's document, verbatim: one Solid feeding one Feedback, nothing else. */
function solidIntoFeedback(): GraphDocument {
  return {
    revision: 1,
    nodes: {
      solid1: {
        id: "solid1",
        type: "solid",
        definitionVersion: 1,
        position: { x: 0, y: 0 },
        parameters: {},
      },
      feedback1: {
        id: "feedback1",
        type: "feedback",
        definitionVersion: 1,
        position: { x: 200, y: 0 },
        parameters: {},
      },
    },
    edges: {
      e1: {
        id: "e1",
        source: { nodeId: "solid1", portId: "out" },
        target: { nodeId: "feedback1", portId: "in" },
      },
    },
    groups: {},
  };
}

interface StubCanvas {
  width: number;
  height: number;
  getContext(kind: string): unknown;
}

function stubCanvas(device: GPUDevice, width: number, height: number): StubCanvas {
  let texture: GPUTexture | undefined;
  const canvas: StubCanvas = {
    width,
    height,
    getContext(kind: string) {
      if (kind !== "webgpu") return null;
      return {
        configure(config: { format: string }) {
          texture?.destroy();
          texture = device.createTexture({
            size: [canvas.width, canvas.height],
            format: config.format as GPUTextureFormat,
            usage: RENDER_ATTACHMENT | TEXTURE_BINDING | COPY_SRC,
          });
        },
        unconfigure() {},
        getCurrentTexture() {
          return texture;
        },
      };
    },
  };
  return canvas;
}

function capturingHost(): { host: GpuHost; session: () => GpuSession | undefined } {
  const base = nodeGpuHost();
  let captured: GpuSession | undefined;
  return {
    host: {
      label: base.label,
      async create(options) {
        captured = await base.create(options);
        return captured;
      },
    },
    session: () => captured,
  };
}

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

describe("T620 — previewing a feedback output binds the pair, silently", () => {
  it("solid1 → feedback1 with a preview on the feedback: zero diagnostics, all severities", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);

    const registry = createNodeRegistry(allNodeDefinitions).view();
    const plan = compileGraph({
      graph: solidIntoFeedback(),
      settings: SETTINGS,
      registry,
      capabilities: CAPS,
      sinks: [{ nodeId: "feedback1", portId: "out", kind: "preview" }],
    });
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);

    const output = plan.outputs.find((entry) => entry.nodeId === "feedback1");
    if (output === undefined) throw new Error("the feedback materialized no output");
    // The premise the whole defect hangs on: this preview's source IS a pair.
    expect(output.resourceKind).toBe("pingPong");

    const { host, session } = capturingHost();
    const backend = createVgpuBackend({ host });
    const reported: string[] = [];
    backend.onDiagnostic((diagnostic) => {
      reported.push(`${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}`);
    });
    try {
      await backend.initialize({});
      const active = session();
      if (active === undefined) throw new Error("the host produced no session");
      const device = active.gpu.gpu as unknown as GPUDevice;
      const compiled = await backend.compile(plan);

      const previewCanvas = stubCanvas(device, SIZE, SIZE);
      const previewHandle = backend.previewHost(previewCanvas as never);
      const request: PreviewRequest = {
        ref: { nodeId: "feedback1", portId: output.portId },
        source: {
          resourceId: output.resourceId,
          size: output.size,
          format: output.format,
          space: output.space,
        },
        rect: { x: 0, y: 0, width: SIZE, height: SIZE },
        area: { width: SIZE, height: SIZE },
        view: DEFAULT_PREVIEW_VIEW,
        visible: true,
        collapsed: false,
        occluded: false,
        pinned: false,
      };
      const program = buildPreviewProgram(
        [{ ref: request.ref, request, tileSize: [SIZE, SIZE] }],
        createTileAtlas({ capacity: 4 }),
      );
      previewHandle.setPreviewProgram(program);

      // Render a couple of main frames around the preview present — the pair SWAPS per
      // frame, so a binding that only survives frame zero is not a fix (§V22).
      const frame = (frameIndex: number): void => {
        backend.render(compiled, {
          frame: {
            timeSeconds: frameIndex / 60,
            deltaSeconds: 1 / 60,
            frameIndex,
            mode: "offline",
            randomSeed: 7,
          },
          pointer: { x: 0, y: 0, buttons: 0 },
          resolution: [SIZE, SIZE],
        });
      };
      const present = (): void => {
        const command: PreviewFrameCommand = {
          refresh: program.passes.map((pass) => pass.id),
          composite: program.passes.map((pass) => ({
            ref: request.ref,
            resourceId: pass.target ?? "",
            dest: { x: 0, y: 0, width: SIZE, height: SIZE },
          })),
          surface: { size: [SIZE, SIZE], dpr: 1 },
        };
        previewHandle.presentPreviews(command);
      };

      frame(0);
      present();
      frame(1);
      present();
      await device.queue.onSubmittedWorkDone();

      // THE GATE — no resource complaint at ANY severity: the report's symptom was a
      // warning-severity re-emission, so filtering to errors would pass on the exact
      // defect this test exists for. Capability notes (timestamp availability) are not
      // resource complaints and pass through.
      expect(reported.filter((line) => !line.includes("timestamp"))).toEqual([]);
    } finally {
      backend.dispose();
    }
  }, 60_000);
});
