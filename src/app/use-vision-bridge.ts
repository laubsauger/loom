import { useCallback, useMemo, useRef, useState } from "react";

import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import { absTimeSecondsOf } from "@domain/types/frame.ts";
import type { CompiledGraph } from "@compiler/index.ts";
import { scratchResourceId } from "@compiler/resources.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";
import {
  createInferenceSources,
  inferenceSourceIdFor,
  type InferenceEntry,
} from "@runtime/execution/inference-sources.ts";
import {
  PERSON_MASK_INPUT_KEY,
  PERSON_MASK_INPUT_SIDE,
  PERSON_MASK_RESULT_KEY,
} from "@nodes/definitions/index.ts";
import type { DeviceClient } from "@/mcp/device-client.ts";

/**
 * T1029 — the Person Mask node's CPU half: Apple Vision over the device bridge,
 * riding the SAME seam every model node rides (`createInferenceSources`). The fill
 * policies, staleness ages, per-node rate limit, identity fallback and the coverage
 * channel all come from the seam unchanged; the only thing this hook owns is the
 * RUNNER — a bridge round trip where the model nodes have a worker message.
 *
 * ## No-fire and degrade, by mechanism per path (§V840's discipline, §T715's rule)
 *
 *  - headless renders, takes on other machines, every gate: no React tree, no hook,
 *    nothing is ever asked;
 *  - live session, no helper: the runner rejects with the client's own sentence, the
 *    seam serves the identity fallback (zero mask — nobody), and the diagnostic below
 *    says what to do (§T948's copy rule);
 *  - helper attached, non-mac / no toolchain / worker died: the DOOR's refusal arrives
 *    as the run's failure, surfaced per node through the seam's failure channel — the
 *    same surface a failed model download uses (B156).
 *
 * ## §V856, answered from birth rather than after three reports
 *
 * The mask's neutral output is also its correct output — zero everywhere is both "no
 * helper" and "nobody in frame". So every entry supplies `coverage` (fraction of mask
 * above half), published on the node's `<name>:coverage` channel by the seam: "ran and
 * found nothing" reads coverage 0 WITH a result age, "did not run" reads no age and a
 * failure sentence. Four states, three distinguishable surfaces.
 */

const SIDE = PERSON_MASK_INPUT_SIDE;

/** Planner texels (vec4f floats) → the wire's RGBA8, base64. Length follows the input. */
export function texelsToRgbaBase64(texels: Float32Array): string {
  const bytes = new Uint8Array(texels.length);
  for (let at = 0; at < bytes.length; at += 1) {
    const value = texels[at] ?? 0;
    bytes[at] = Math.max(0, Math.min(255, Math.round(value * 255)));
  }
  let ascii = "";
  const CHUNK = 0x8000;
  for (let at = 0; at < bytes.length; at += CHUNK) {
    ascii += String.fromCharCode(...bytes.subarray(at, at + CHUNK));
  }
  return btoa(ascii);
}

/**
 * The helper's mask (u8, its own aspect-preserving size) → the node's r32float plane
 * at the output resolution, nearest-neighbour. The mask came from the LETTERBOXED
 * square the preprocess produced, so the letterbox is undone here: only the centred
 * band of the mask corresponds to the picture, exactly the inverse of the preprocess's
 * placement. GPU cannot do this walk — the external texture is output-sized by
 * contract — so it runs here, bounded by the node's rate limit.
 */
export function maskToFloats(
  mask: Uint8Array,
  maskWidth: number,
  maskHeight: number,
  outWidth: number,
  outHeight: number,
): Float32Array {
  const out = new Float32Array(outWidth * outHeight);
  // The preprocess letterboxes the picture into the square preserving aspect; Vision
  // then keeps that aspect. Recover the band of the mask the picture actually occupies.
  const aspect = outWidth / outHeight;
  let bandW = maskWidth;
  let bandH = maskHeight;
  const maskAspect = maskWidth / maskHeight;
  if (aspect > maskAspect) {
    bandH = Math.max(1, Math.round(maskWidth / aspect));
  } else if (aspect < maskAspect) {
    bandW = Math.max(1, Math.round(maskHeight * aspect));
  }
  const offX = (maskWidth - bandW) >> 1;
  const offY = (maskHeight - bandH) >> 1;
  for (let y = 0; y < outHeight; y += 1) {
    const sy = offY + Math.min(bandH - 1, Math.floor((y / outHeight) * bandH));
    const row = sy * maskWidth;
    const outRow = y * outWidth;
    for (let x = 0; x < outWidth; x += 1) {
      const sx = offX + Math.min(bandW - 1, Math.floor((x / outWidth) * bandW));
      out[outRow + x] = (mask[row + sx] ?? 0) / 255;
    }
  }
  return out;
}

/** §V856's scalar: the fraction of the mask that is confidently person. */
export function maskCoverage(bytes: Uint8Array): number {
  const floats = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  if (floats.length === 0) return 0;
  let lit = 0;
  for (const value of floats) if (value > 0.5) lit += 1;
  return lit / floats.length;
}

interface VisionTarget {
  readonly nodeId: string;
  readonly size: readonly [number, number];
  readonly minIntervalSeconds: number;
  readonly channel?: string;
}

export function useVisionBridge(options: {
  /** The OSC hook's shared device client — one attachment per tab (T950's rule). */
  deviceClient: () => DeviceClient | null;
  backend?: () => LoomBackend | null;
}): {
  readonly diagnostics: readonly RuntimeDiagnostic[];
  observe(frame: FrameEvaluationInput): void;
  track(graph: GraphDocument, compiled: CompiledGraph | null): void;
  settle(frameIndex: number): Promise<void>;
} {
  const [diagnostics, setDiagnostics] = useState<readonly RuntimeDiagnostic[]>([]);
  const targetsRef = useRef<readonly VisionTarget[]>([]);
  const client = options.deviceClient;
  const backendRef = useRef(options.backend);
  backendRef.current = options.backend;
  const unregisterRef = useRef(new Map<string, () => void>());
  const registeredOnRef = useRef<LoomBackend | null>(null);

  const sources = useMemo(
    () =>
      createInferenceSources({
        readBuffer: (resourceId) => {
          const live = backendRef.current?.() ?? null;
          if (live === null) return Promise.reject(new Error("No backend is attached; nothing to read."));
          return live.readBuffer(resourceId);
        },
        run: async (nodeId, input) => {
          const live = client();
          if (live === null) {
            throw new Error(
              "no helper is attached — pair this tab in the Connections section first (pnpm mcp:serve)",
            );
          }
          const outcome = await live.vision({
            width: SIDE,
            height: SIDE,
            rgbaBase64: texelsToRgbaBase64(new Float32Array(input)),
          });
          if (!outcome.ok) throw new Error(outcome.reason);
          const target = targetsRef.current.find((entry) => entry.nodeId === nodeId);
          const [outWidth, outHeight] = target?.size ?? [1, 1];
          const raw = atob(outcome.maskBase64);
          const mask = new Uint8Array(raw.length);
          for (let at = 0; at < raw.length; at += 1) mask[at] = raw.charCodeAt(at);
          const floats = maskToFloats(mask, outcome.maskWidth, outcome.maskHeight, outWidth, outHeight);
          return new Uint8Array(floats.buffer, floats.byteOffset, floats.byteLength);
        },
      }),
    [client],
  );

  const track = useCallback(
    (graph: GraphDocument, compiled: CompiledGraph | null) => {
      const sized = new Map<string, readonly [number, number]>();
      for (const resource of compiled?.resources ?? []) {
        const entry = resource as { id?: string; size?: readonly [number, number] };
        if (entry.id !== undefined && entry.size !== undefined) sized.set(entry.id, entry.size);
      }
      const targets: VisionTarget[] = [];
      const next: RuntimeDiagnostic[] = [];
      for (const nodeId of Object.keys(graph.nodes).sort()) {
        const node = graph.nodes[nodeId];
        if (node === undefined || node.type !== "personMask") continue;
        const resultId = scratchResourceId(nodeId, PERSON_MASK_RESULT_KEY);
        // §V585: unwired = unallocated = untracked; nothing is asked of the helper.
        if (!sized.has(resultId)) continue;
        const rate = node.parameters["rateLimit"];
        const stored = typeof rate === "number" ? rate : (rate as { value?: unknown } | undefined)?.value;
        targets.push({
          nodeId,
          size: sized.get(resultId) ?? [1, 1],
          minIntervalSeconds: typeof stored === "number" ? Math.max(0, stored) : 0.1,
          ...(node.label === undefined ? {} : { channel: node.label }),
        });
        if (client() === null) {
          next.push({
            severity: "info",
            code: "vision.helper.absent",
            message:
              "Person Mask needs the local helper (pnpm mcp:serve) on macOS — until it is paired the node publishes an empty mask (nobody).",
            nodeId,
          });
        } else {
          const failed = sources.lastFailure(nodeId as NodeId);
          if (failed !== undefined) {
            next.push({ severity: "warning", code: "vision.refused", message: failed, nodeId });
          }
        }
      }
      targetsRef.current = targets;
      setDiagnostics((prior) =>
        prior.length === next.length &&
        prior.every((entry, at) => entry.code === next[at]?.code && entry.nodeId === next[at]?.nodeId && entry.message === next[at]?.message)
          ? prior
          : next,
      );

      // T1044's discipline, inherited verbatim from the model seam: a rebuilt device
      // holds no registrations, so the map is dropped on identity change.
      const attached = backendRef.current?.() ?? null;
      if (attached !== registeredOnRef.current) {
        for (const off of unregisterRef.current.values()) off();
        unregisterRef.current.clear();
        registeredOnRef.current = attached;
      }
      const wanted = new Set(targets.map((target) => inferenceSourceIdFor(target.nodeId)));
      for (const [sourceId, off] of [...unregisterRef.current.entries()]) {
        if (wanted.has(sourceId)) continue;
        off();
        unregisterRef.current.delete(sourceId);
      }
      if (attached !== null) {
        for (const target of targets) {
          const sourceId = inferenceSourceIdFor(target.nodeId);
          if (unregisterRef.current.has(sourceId)) continue;
          unregisterRef.current.set(
            sourceId,
            attached.registerMediaSource(sourceId, {
              currentFrame: () => sources.currentFrame(target.nodeId as NodeId),
            }),
          );
        }
      }

      const entries: InferenceEntry[] = targets.map((target) => ({
        nodeId: target.nodeId as NodeId,
        inputResourceId: scratchResourceId(target.nodeId, PERSON_MASK_INPUT_KEY),
        sourceId: inferenceSourceIdFor(target.nodeId),
        // r32float zeros at the output size: the empty mask, "nobody" — which composes
        // to a no-op for a masking consumer rather than to a hole (§T715).
        fallback: new Uint8Array(target.size[0] * target.size[1] * 4),
        minIntervalSeconds: target.minIntervalSeconds,
        ...(target.channel === undefined ? {} : { channel: target.channel }),
        coverage: maskCoverage,
      }));
      sources.track(entries);
    },
    [client, sources],
  );

  const observe = useCallback(
    (frame: FrameEvaluationInput) => {
      if (targetsRef.current.length === 0) return;
      // Between frames, exactly as analyze and the model seam do (§V184).
      queueMicrotask(() => sources.sample(frame.frameIndex, absTimeSecondsOf(frame)));
    },
    [sources],
  );

  const settle = useCallback(
    async (frameIndex: number) => {
      if (targetsRef.current.length === 0) return;
      await sources.settle(frameIndex);
    },
    [sources],
  );

  return useMemo(() => ({ diagnostics, observe, track, settle }), [diagnostics, observe, track, settle]);
}
