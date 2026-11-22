import type { AcquisitionState, ModelAcquisition, ModelDescriptor } from "@runtime/models/model-acquisition.ts";
import { DEPTH_PRO2_COREML_MODELS } from "@runtime/models/model-catalogue.ts";
import { depthAsVisionBridge, desktopDepthBridge, type DesktopDepthBridge, type DesktopDepthModelId } from "@devices/native-inference.ts";
import { DEPTH_COREML_UNAVAILABLE } from "@nodes/definitions/index.ts";
import type { NativeSourcesConfig } from "./native-vision-sources.ts";

/**
 * T1818b — MODEL ACQUISITION FOR APPLE'S CORE ML DEPTH PACKAGES, through the desktop app.
 *
 * The browser's acquisition downloads one file into the Cache API and hands the worker its
 * bytes. A Core ML package is three files that the desktop app's native service downloads,
 * verifies per file and compiles; the page never holds the bytes. What the page DOES own is
 * the decision, so these ids answer through the SAME interface and the same state machine:
 * `absent` until a person consents in the node's notice, `downloading` with real byte counts,
 * `ready`, or `failed` with the service's own reason. Every other id goes to the browser's
 * acquisition unchanged, so nothing about the existing models moves.
 *
 * `acquire` resolves `undefined` for a Core ML id even when it succeeds: there are no bytes
 * for the page. The hook never runs these through its worker — the native sources do.
 */
export function withNativeDepthAcquisition(
  browser: ModelAcquisition,
  onStateChange: (id: string, state: AcquisitionState) => void,
  bridgeOf: () => DesktopDepthBridge | undefined = desktopDepthBridge,
): ModelAcquisition {
  const native = new Set(DEPTH_PRO2_COREML_MODELS.map((model) => model.id));
  const states = new Map<string, AcquisitionState>();
  const set = (id: string, state: AcquisitionState): AcquisitionState => {
    states.set(id, state);
    onStateChange(id, state);
    return state;
  };
  const preparing = new Map<string, Promise<void>>();

  const refresh = async (descriptor: ModelDescriptor): Promise<AcquisitionState> => {
    const bridge = bridgeOf();
    if (bridge === undefined) return set(descriptor.id, { kind: "failed", reason: DEPTH_COREML_UNAVAILABLE });
    // A download in flight keeps reporting itself; a probe must not overwrite its progress.
    if (preparing.has(descriptor.id)) return states.get(descriptor.id) ?? { kind: "unknown" };
    try {
      const probe = await bridge.probe();
      if (!probe.available) return set(descriptor.id, { kind: "failed", reason: probe.reason ?? DEPTH_COREML_UNAVAILABLE });
      const model = probe.models.find((entry) => entry.id === descriptor.id);
      if (model === undefined) return set(descriptor.id, { kind: "failed", reason: `This desktop app has no Core ML build named ${descriptor.id}. Update the desktop app.` });
      return set(descriptor.id, model.cached ? { kind: "ready" } : { kind: "absent" });
    } catch (error) {
      return set(descriptor.id, { kind: "failed", reason: error instanceof Error ? error.message : String(error) });
    }
  };

  const acquire = async (descriptor: ModelDescriptor): Promise<ArrayBuffer | undefined> => {
    const bridge = bridgeOf();
    if (bridge === undefined) { set(descriptor.id, { kind: "failed", reason: DEPTH_COREML_UNAVAILABLE }); return undefined; }
    const running = preparing.get(descriptor.id);
    if (running !== undefined) { await running.catch(() => undefined); return undefined; }
    set(descriptor.id, { kind: "downloading", received: 0, total: descriptor.bytes });
    const job = bridge.prepare(descriptor.id as DesktopDepthModelId, (progress) => {
      // Verifying and compiling come after the last byte: the bar stays full, not reset.
      if (progress.phase === "downloading") set(descriptor.id, { kind: "downloading", received: progress.received, total: progress.total });
      else set(descriptor.id, { kind: "downloading", received: descriptor.bytes, total: descriptor.bytes });
    });
    preparing.set(descriptor.id, job);
    try {
      await job;
      set(descriptor.id, { kind: "ready" });
    } catch (error) {
      set(descriptor.id, { kind: "failed", reason: error instanceof Error ? error.message : String(error) });
    } finally {
      preparing.delete(descriptor.id);
    }
    return undefined;
  };

  return {
    stateOf: (id) => (native.has(id) ? states.get(id) ?? { kind: "unknown" } : browser.stateOf(id)),
    refresh: (descriptor) => (native.has(descriptor.id) ? refresh(descriptor) : browser.refresh(descriptor)),
    acquire: (descriptor) => (native.has(descriptor.id) ? acquire(descriptor) : browser.acquire(descriptor)),
    // The service's download is not cancellable from the page; the notice's Cancel is a no-op
    // for these ids rather than a lie that something stopped.
    cancel: (id) => { if (!native.has(id)) browser.cancel(id); },
    uninstall: (id) => (native.has(id) ? Promise.reject(new Error("Core ML packages live in the desktop app's native cache.")) : browser.uninstall(id)),
    list: () => browser.list(),
  };
}

/**
 * T1818b — Depth on Core ML runs through the desktop app's native service, on the SAME
 * manager the native Person Mask uses: the node's preprocess buffer (the letterboxed,
 * sRGB-encoded box) is captured, the service answers an rgbaf16 surface, and the node's
 * result pass scales it to 1/m. Until the first result the node shows R = −1 — "pending",
 * which the result pass publishes as the same flat 0.5 the worker's models show.
 */
const HALF_MINUS_ONE = 0xbc00;
const HALF_ONE = 0x3c00;
export const DEPTH_NATIVE_SOURCES: NativeSourcesConfig = {
  bridgeFor: (target) => {
    const bridge = desktopDepthBridge();
    const [modelId, functionName] = (target.input?.session ?? "").split("|");
    return bridge === undefined || modelId === undefined || functionName === undefined
      ? undefined : depthAsVisionBridge(bridge, modelId as DesktopDepthModelId, functionName);
  },
  namePrefix: "loom-native-depth-",
  unavailable: DEPTH_COREML_UNAVAILABLE,
  starting: "Depth Pro 2 is opening its Core ML session in the desktop app; no result yet.",
  family: "depth",
  empty: (size) => {
    const halves = new Uint16Array(size[0] * size[1] * 4);
    for (let i = 0; i < halves.length; i += 4) { halves[i] = HALF_MINUS_ONE; halves[i + 3] = HALF_ONE; }
    return new Uint8Array(halves.buffer);
  },
};
