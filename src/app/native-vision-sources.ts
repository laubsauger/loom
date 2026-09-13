import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import { absTimeSecondsOf } from "@domain/types/frame.ts";
import type { ChannelResolver } from "@domain/parameters/resolve.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";
import { inferenceSourceIdFor } from "@runtime/execution/inference-sources.ts";
import { scratchResourceId } from "@compiler/resources.ts";
import { PERSON_MASK_INPUT_KEY, PERSON_MASK_INPUT_SIDE } from "@nodes/definitions/person-mask.ts";
import { createNativeVisionSource, desktopVisionBridge } from "@devices/native-inference.ts";

export interface NativeVisionTarget {
  nodeId: string;
  size: readonly [number, number];
  minIntervalSeconds: number;
  channel?: string;
}
type NativeSource = ReturnType<typeof createNativeVisionSource>;
interface Entry {
  target: NativeVisionTarget;
  source?: NativeSource;
  unregister?: () => void;
  initialized: boolean;
  closed: boolean;
  error?: string;
  pending?: Promise<void>;
  issued?: number;
  frame?: number;
  resultAt?: number;
  interval?: number;
  coverage?: number;
}
// Failed drainage survives document replacement: a new owner cannot erase it.
const drains = new WeakMap<LoomBackend, Map<Promise<void>, string | null>>();
function retire(backend: LoomBackend, entry: Entry) {
  entry.closed = true; entry.unregister?.();
  if (!entry.source) return;
  let pending = drains.get(backend);
  if (!pending) { pending = new Map(); drains.set(backend, pending); }
  const close = entry.source.close(); pending.set(close, null);
  void close.then(() => pending.delete(close), error => { pending.set(close, String(error)); });
}

/** Native ownership and frame scheduling; helper byte inference stays unchanged. */
export function createNativeVisionSources() {
  let backend: LoomBackend | null = null;
  let latest: FrameEvaluationInput | undefined;
  const entries = new Map<string, Entry>();
  const dispose = () => {
    if (backend) for (const entry of entries.values()) retire(backend, entry);
    entries.clear();
  };
  const run = (entry: Entry, frame: FrameEvaluationInput) => {
    if (entry.error) return Promise.reject(new Error(entry.error));
    if (!entry.source) return Promise.reject(new Error("Native Vision source is unavailable"));
    const seconds = absTimeSecondsOf(frame);
    entry.issued = seconds;
    const pending = entry.source.run().then(result => {
      if (entry.closed) return;
      const at = latest ? absTimeSecondsOf(latest) : seconds;
      entry.interval = entry.resultAt === undefined ? 0 : Math.max(0, at - entry.resultAt);
      entry.resultAt = at; entry.coverage = result.coverage; entry.frame = frame.frameIndex;
    }).catch(error => {
      if (!entry.closed) entry.error = String(error);
      throw error;
    }).finally(() => { if (entry.pending === pending) delete entry.pending; });
    entry.pending = pending;
    return pending;
  };
  return {
    track(next: readonly NativeVisionTarget[], attached: LoomBackend | null) {
      if (attached !== backend) { dispose(); backend = attached; }
      const wanted = new Map(next.map(target => [target.nodeId, target]));
      for (const [id, entry] of entries) {
        const target = wanted.get(id);
        if (target && target.size[0] === entry.target.size[0] && target.size[1] === entry.target.size[1]) {
          entry.target = target; continue;
        }
        if (backend) retire(backend, entry);
        entries.delete(id);
      }
      for (const target of next) {
        if (entries.has(target.nodeId)) continue;
        const entry: Entry = { target, initialized: false, closed: false };
        entries.set(target.nodeId, entry);
        const bridge = desktopVisionBridge();
        if (!backend || !bridge) {
          entry.error = "Native Person Mask requires the Apple Silicon Electron app; no helper/CPU transport is substituted.";
          continue;
        }
        try {
          const source = createNativeVisionSource(backend, bridge, {
            inputResourceId: scratchResourceId(target.nodeId, PERSON_MASK_INPUT_KEY),
            inputSize: [PERSON_MASK_INPUT_SIDE, PERSON_MASK_INPUT_SIDE], outputSize: target.size,
            beforeOpen: Promise.all([...(drains.get(backend)?.keys() ?? [])]).then(() => undefined),
          });
          entry.source = source;
          // Same never-yet empty mask as the helper path, in the declared format.
          // This is initial state, never a substitute transport after failure.
          let empty: Uint8Array | undefined = new Uint8Array(target.size[0] * target.size[1] * 8);
          entry.unregister = backend.registerMediaSource(inferenceSourceIdFor(target.nodeId), {
            currentFrame: () => {
              const frame = source.source.currentFrame();
              if (entry.frame !== undefined) { empty = undefined; return frame; }
              return frame ?? { frameId: 0, bytes: empty! };
            },
          });
          void source.ready.then(() => { entry.initialized = true; }, error => { if (!entry.closed) entry.error = String(error); });
        } catch (error) { entry.error = String(error); }
      }
    },
    observe(frame: FrameEvaluationInput) {
      latest = frame;
      if (frame.mode !== "realtime") return;
      queueMicrotask(() => {
        for (const entry of entries.values()) {
          if (entry.error || entry.pending || !entry.initialized) continue;
          const seconds = absTimeSecondsOf(frame);
          if (entry.issued !== undefined && seconds >= entry.issued && seconds - entry.issued < entry.target.minIntervalSeconds) continue;
          try { if (entry.source?.available) void run(entry, frame).catch(() => undefined); }
          catch (error) { entry.error = String(error); }
        }
      });
    },
    async settle(frameIndex: number) {
      if (!entries.size) return;
      if (!latest || latest.frameIndex !== frameIndex) throw new Error("Native Vision settle requires the rendered frame input");
      const frame = latest;
      const settled = await Promise.allSettled([...entries.values()].map(async entry => {
        if (entry.pending) await entry.pending;
        if (entry.frame !== frameIndex) await run(entry, frame);
      }));
      // Independent workers can run together; an export failure must still wait
      // for every submitted model before handing frame ownership back.
      const failed = settled.find(result => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    },
    diagnostics(): RuntimeDiagnostic[] {
      const active: RuntimeDiagnostic[] = [...entries.values()].filter(entry => entry.error || !entry.initialized).map(entry => ({
        severity: "warning", code: entry.error ? "vision.native.refused" : "vision.native.starting",
        message: entry.error ?? "Native Person Mask is starting its Python worker; no result yet.", nodeId: entry.target.nodeId,
      }));
      if (backend) for (const error of drains.get(backend)?.values() ?? []) {
        if (error) active.push({ severity: "error", code: "vision.native.retirement",
          message: `Native Vision retirement failed; new sessions and exports remain blocked: ${error}` });
      }
      return active;
    },
    resolver: ((channel, context) => {
      const split = channel.lastIndexOf(":"), name = channel.slice(0, split), field = channel.slice(split + 1);
      const entry = [...entries.values()].find(entry => entry.target.channel === name);
      if (!entry || !context.frame) return undefined;
      if (field === "ready") return entry.frame === undefined ? 0 : 1;
      if (field === "coverage") return entry.coverage ?? 0;
      if (!["lagFrames", "delaySeconds", "fps", "realtimeFactor"].includes(field)) return undefined;
      if (entry.frame === undefined) return 0;
      if (field === "lagFrames") return Math.max(0, context.frame.frameIndex - entry.frame);
      if (field === "delaySeconds") return Math.max(0, absTimeSecondsOf(context.frame) - entry.resultAt!);
      const interval = entry.interval ?? 0;
      return interval > 0 ? (field === "fps" ? 1 : context.frame.deltaSeconds) / interval : 0;
    }) satisfies ChannelResolver,
    dispose,
    async drain() {
      dispose();
      if (backend) await Promise.all([...(drains.get(backend)?.keys() ?? [])]);
    },
  };
}
