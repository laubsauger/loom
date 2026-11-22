import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import { absTimeSecondsOf } from "@domain/types/frame.ts";
import type { ChannelResolver } from "@domain/parameters/resolve.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";
import { inferenceSourceIdFor } from "@runtime/execution/inference-sources.ts";
import { scratchResourceId } from "@compiler/resources.ts";
import { PERSON_MASK_INPUT_KEY, PERSON_MASK_INPUT_SIDE } from "@nodes/definitions/person-mask.ts";
import { createNativeVisionSource, desktopVisionBridge, type DesktopVisionBridge } from "@devices/native-inference.ts";

export interface NativeVisionTarget {
  nodeId: string;
  size: readonly [number, number];
  minIntervalSeconds: number;
  channel?: string;
  /**
   * T1818b — what the node feeds the service, when it is not Person Mask's square: its
   * preprocess buffer's key and box, and the bridge that opens this node's session (the
   * depth service with this node's model and function). A change to any of these is a new
   * session, as a size change is.
   */
  input?: { readonly key: string; readonly size: readonly [number, number]; readonly session: string };
}

/**
 * T1818b — what differs between the native models this manager runs. Person Mask's is the
 * default and is exactly the behaviour this file had before Depth joined it.
 */
export interface NativeSourcesConfig {
  /** The bridge for one target, or undefined where this page has none. */
  readonly bridgeFor: (target: NativeVisionTarget) => DesktopVisionBridge | undefined;
  readonly namePrefix: "loom-native-vision-" | "loom-native-depth-";
  /** Said on the node when there is no bridge. No other transport is substituted. */
  readonly unavailable: string;
  readonly starting: string;
  /** Diagnostic codes `<family>.native.refused`, `.starting`, `.retirement`. */
  readonly family: "vision" | "depth";
  /** What the node shows before the first result: rgba16float bytes for `size`. */
  readonly empty: (size: readonly [number, number]) => Uint8Array;
}

const PERSON_MASK_NATIVE: NativeSourcesConfig = {
  bridgeFor: () => desktopVisionBridge(),
  namePrefix: "loom-native-vision-",
  unavailable: "Native Person Mask requires the Apple Silicon Electron app; no helper/CPU transport is substituted.",
  starting: "Native Person Mask is starting its Python worker; no result yet.",
  family: "vision",
  // Same never-yet empty mask as the helper path, in the declared format.
  empty: (size) => new Uint8Array(size[0] * size[1] * 8),
};

function sameInput(a: NativeVisionTarget, b: NativeVisionTarget): boolean {
  return a.size[0] === b.size[0] && a.size[1] === b.size[1] &&
    a.input?.key === b.input?.key && a.input?.session === b.input?.session &&
    a.input?.size[0] === b.input?.size[0] && a.input?.size[1] === b.input?.size[1];
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
export function createNativeVisionSources(config: NativeSourcesConfig = PERSON_MASK_NATIVE) {
  let backend: LoomBackend | null = null;
  let latest: FrameEvaluationInput | undefined;
  const entries = new Map<string, Entry>();
  const dispose = () => {
    if (backend) for (const entry of entries.values()) retire(backend, entry);
    entries.clear();
  };
  const run = (entry: Entry, frame: FrameEvaluationInput) => {
    if (entry.error) return Promise.reject(new Error(entry.error));
    if (!entry.source) return Promise.reject(new Error(config.unavailable));
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
        if (target && sameInput(target, entry.target)) {
          entry.target = target; continue;
        }
        if (backend) retire(backend, entry);
        entries.delete(id);
      }
      for (const target of next) {
        if (entries.has(target.nodeId)) continue;
        const entry: Entry = { target, initialized: false, closed: false };
        entries.set(target.nodeId, entry);
        const bridge = config.bridgeFor(target);
        if (!backend || !bridge) {
          entry.error = config.unavailable;
          continue;
        }
        try {
          const source = createNativeVisionSource(backend, bridge, {
            inputResourceId: scratchResourceId(target.nodeId, target.input?.key ?? PERSON_MASK_INPUT_KEY),
            inputSize: target.input?.size ?? [PERSON_MASK_INPUT_SIDE, PERSON_MASK_INPUT_SIDE], outputSize: target.size,
            beforeOpen: Promise.all([...(drains.get(backend)?.keys() ?? [])]).then(() => undefined),
            namePrefix: config.namePrefix,
          });
          entry.source = source;
          // This is initial state, never a substitute transport after failure.
          let empty: Uint8Array | undefined = config.empty(target.size);
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
        severity: "warning", code: entry.error ? `${config.family}.native.refused` : `${config.family}.native.starting`,
        message: entry.error ?? config.starting, nodeId: entry.target.nodeId,
      }));
      if (backend) for (const error of drains.get(backend)?.values() ?? []) {
        if (error) active.push({ severity: "error", code: `${config.family}.native.retirement`,
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
