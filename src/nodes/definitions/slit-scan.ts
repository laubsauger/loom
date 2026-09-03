import type { CompiledNodeDescription, NodeDefinition } from "../../domain/types/node-definition.ts";
import type { EffectPassDescriptor } from "../../runtime/backend/plan.ts";
import { scratchResourceId } from "../../compiler/resources.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";
import { missingCompileResource, readCompileInputs } from "./compile-context.ts";
import { readNumber } from "./parameter-readers.ts";
import { CACHE_BLIT_WGSL } from "../shaders/cache.wgsl.ts";
import { SLIT_SCAN_WGSL } from "../shaders/slit-scan.wgsl.ts";

/**
 * SlitScan — per-pixel time displacement (T321). The Cache's OTHER half: where Cache
 * reads ONE moment for the whole frame, this reads a different moment PER PIXEL,
 * steered by a displacement map. A vertical gradient is the classic slit-scan; a
 * radial one is a time-tunnel; feeding anything animated warps time along it.
 *
 * Storage is a ring (T237's resource, T321's array history) this node OWNS: the write
 * pass is Cache's blit verbatim, the read pass binds the whole history as
 * `texture_2d_array` and picks layers per fragment.
 *
 * COSTS, both stated where they are chosen (§V228):
 *  - memory: (width × scale) × (height × scale) × bytesPerPixel × (frames + 1) — the
 *    history layers plus the write target. 60 frames at 1080p rgba16float is ~965 MiB
 *    at full scale; the default 16 is ~264 MiB; `scale` (T1019a, Cache's knob) buys
 *    span for softness — each halving quarters the bytes, so the same budget reaches
 *    four times further back.
 *  - per frame: ONE full-frame GPU copy (the rotate that archives the write target
 *    into the history). This scales with RING COUNT across the project — five
 *    ring-backed nodes is five copies a frame.
 *
 * 8 frames is a smear; the effect wants depth — which is why `frames` defaults higher
 * here than on Cache and the memory line sits beside it.
 */

const SLIT_RING_KEY = "history";
const SLIT_DEFAULT_FRAMES = 16;

export const slitScanNode: NodeDefinition = {
  type: "slitScan",
  version: 1,
  title: "Slit Scan",
  category: "temporal",
  description:
    "Every pixel reads a different moment: a displacement map picks how many frames back each fragment samples from a rolling history.",
  tags: ["time", "slit-scan", "displacement", "cache", "temporal", "history"],
  inputs: [
    { id: "input", label: "Input", type: RGBA_TEXTURE, description: "The stream to record and warp." },
    {
      id: "map",
      label: "Map",
      type: RGBA_TEXTURE,
      description: "Red channel → frames back, 0 (now) to 1 (deepest). A gradient is the classic slit-scan.",
    },
  ],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  parameters: {
    frames: {
      type: "number",
      label: "Frames",
      default: SLIT_DEFAULT_FRAMES,
      min: 2,
      max: 120,
      range: "bounded",
      step: 1,
      compileTime: true,
      description:
        "History depth. Memory = W × H × bpp × (frames + 1); each frame also costs one full-frame copy to archive. 60 at 1080p rgba16float ≈ 965 MiB.",
    },
    depth: {
      type: "number",
      label: "Depth",
      default: 1,
      min: 0,
      max: 1,
      range: "bounded",
      description: "Scales the map: 1 uses the whole history, 0 freezes everything at now.",
    },
    scale: {
      type: "number",
      label: "Scale",
      default: 1,
      min: 0.125,
      max: 1,
      range: "bounded",
      compileTime: true,
      description:
        "Ring resolution as a fraction of the input (Cache's knob, same arithmetic). Halving it QUARTERS the memory — 60 frames at 1080p rgba16float is ~965 MiB at 1, ~241 MiB at 0.5, ~60 MiB at 0.25 — so the same budget holds four times the span per halving. The history is displaced per OUTPUT pixel either way; a scaled ring costs softness, never geometry. Default 1: existing documents keep their exact pixels.",
    },
    resetPulse: {
      type: "pulse",
      label: "Reset Pulse",
      // §V123/§V126: scoped to THIS node's ring, same wiring as Cache's — the pulse
      // clears actual pixels because runtime.resetFeedback resolves ring resources.
      fires: "runtime.resetFeedback",
      input: { nodeIds: ["$node"] },
      description: "Clears every frame of held history.",
    },
  },
  temporal: { outputs: [], resetOn: ["resolution", "format", "device", "load"] },
  stateful: { reset: true, deterministicReplay: true, checkpoint: false, randomAccess: false },
  resolutionPolicy: { kind: "inherit", input: "input" },
  formatPolicy: { kind: "inherit", input: "input" },
  compile(context): CompiledNodeDescription {
    const { nodeId, outputs, inputs, parameters } = readCompileInputs(context);
    const target = outputs["out"];
    const source = inputs["input"];
    const map = inputs["map"];
    if (target === undefined || source === undefined || map === undefined) {
      const what =
        target === undefined ? 'output port "out"' : source === undefined ? 'input port "input"' : 'input port "map"';
      return { passes: [], diagnostics: [missingCompileResource(nodeId, what)] };
    }

    const frames = Math.max(2, Math.round(readNumber(parameters, "frames", SLIT_DEFAULT_FRAMES)));
    const scale = readNumber(parameters, "scale", 1);
    const ring = scratchResourceId(nodeId, SLIT_RING_KEY);

    // The write half IS Cache's: sample the input into the ring's write target.
    const record: EffectPassDescriptor = {
      kind: "effect",
      id: `${nodeId}:record`,
      shader: CACHE_BLIT_WGSL,
      target: ring,
      textures: [{ binding: "inputTexture", resourceId: source.resource }],
      samplers: [{ binding: "inputSampler", resourceId: source.sampler }],
      nodeId,
      label: "SlitScan Record",
    };

    const scan: EffectPassDescriptor = {
      kind: "effect",
      id: `${nodeId}:scan`,
      shader: SLIT_SCAN_WGSL,
      target,
      textures: [
        // T321: the WHOLE history as texture_2d_array; the fragment picks the layer.
        // T1019a: SAMPLED now (Cache's read path) so a scaled ring upsamples smoothly;
        // at scale 1 the sample lands on the exact texel the old load read.
        { binding: "history", resourceId: ring, array: true },
        { binding: "displaceMap", resourceId: map.resource, sampled: "unfiltered" },
        // B160: what an EMPTY history reads — the write target, so frame 0 is the
        // undisplaced input rather than black (§V229; see cache.ts, same fix).
        { binding: "liveTexture", resourceId: ring, live: true },
      ],
      samplers: [{ binding: "historySampler", resourceId: source.sampler }],
      uniforms: {
        depth: readNumber(parameters, "depth", 1),
        // Merged per frame by the backend (ring head is a VALUE, §V5); the statics
        // exist so the uniform block matches its struct exactly.
        ringLatest: 0,
        ringWritten: 0,
        ringFrames: frames,
      },
      uniformBinding: "params",
      nodeId,
      label: "SlitScan",
    };

    return {
      passes: [record, scan],
      scratch: [{ kind: "ring", key: SLIT_RING_KEY, frames, scale }],
    };
  },
};
