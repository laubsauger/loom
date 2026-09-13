import type { LoomBackend } from "@runtime/backend/index.ts";
import type { MediaSource } from "@runtime/backend/backend-types.ts";
import { nativeInputTransportSize } from "@runtime/models/native-input-layout.ts";
import { nativeOutputSender } from "./native-output-channel.ts";

export interface NativeVisionMetadata {
  session: string;
  sequence: number;
  width: number;
  height: number;
  coverage: number;
}
export interface DesktopVisionBridge {
  open(name: string, width: number, height: number, outputWidth: number, outputHeight: number,
    consume: (frame: VideoFrame, metadata: NativeVisionMetadata) => Promise<void>): Promise<string>;
  close(name: string): Promise<void>;
  status(name: string): Promise<{ frames: number; busy: boolean; error: string | null }>;
}
export function desktopVisionBridge(): DesktopVisionBridge | undefined {
  return (window as Window & { loomDesktop?: { vision?: DesktopVisionBridge } }).loomDesktop?.vision;
}

/** Graph buffer → GPU capture → Python → GPU media source. One owned result at a time. */
export function createNativeVisionSource(backend: LoomBackend, bridge: DesktopVisionBridge, options: {
  inputResourceId: string;
  inputSize: readonly [number, number];
  outputSize: readonly [number, number];
  /** Prior document/session GPU drainage; presentation can attach before it completes. */
  beforeOpen?: Promise<void>;
}) {
  const name = `loom-native-vision-${crypto.randomUUID()}`;
  const [width, height] = nativeInputTransportSize(options.inputSize);
  const canvas = new OffscreenCanvas(width, height);
  const presentation = backend.present(canvas, { outputId: options.inputResourceId,
    modelInputSize: options.inputSize, label: "native-vision-input" });
  const sender = nativeOutputSender(name);
  let closed = false;
  let closing: Promise<void> | undefined;
  let image: VideoFrame | undefined;
  let sequence = -1;
  let releaseScheduled = false;
  let request: { resolve(metadata: NativeVisionMetadata): void; reject(error: Error): void } | undefined;
  let running = false;
  const discard = () => { image?.close(); image = undefined; };
  const opened = Promise.resolve(options.beforeOpen).then(() => {
    if (closed) return null;
    return bridge.open(name, ...options.inputSize, ...options.outputSize, async (frame, metadata) => {
    if (closed) return;
    if (!request || image) throw new Error("Native Vision delivered an unrequested or overlapping result");
    if (metadata.session !== name || metadata.sequence <= sequence || metadata.width !== options.outputSize[0] ||
      metadata.height !== options.outputSize[1] || !Number.isFinite(metadata.coverage) || metadata.coverage < 0 || metadata.coverage > 1)
      throw new Error("Native Vision returned invalid result metadata");
    image = frame.clone(); sequence = metadata.sequence;
    request.resolve(metadata); request = undefined;
    });
  });
  const ready: Promise<void> = Promise.all([opened, sender.promise]).then(() => undefined);
  // Acquisition can fail before a graph frame asks to run. Preserve that rejection
  // for ready/run/close without an unhandled rejection during an idle document.
  void ready.catch(() => undefined);
  const source: MediaSource = { currentFrame() {
    const frame = image;
    if (closed || !frame) return undefined;
    if (!releaseScheduled) {
      releaseScheduled = true;
      queueMicrotask(() => { releaseScheduled = false; if (image === frame) discard(); });
    }
    return { image: frame, frameId: sequence + 1 };
  } };
  return { source, ready,
    get available() { return !closed && !running && !image && sender.available; },
    async run(): Promise<NativeVisionMetadata> {
      if (closed || running) throw new Error("Native Vision source is closed or busy");
      running = true;
      try {
        await ready; await sender.waitAvailable();
        if (closed) throw new Error("Native Vision source closed before capture");
        if (!presentation.describe?.().presentedFrames) throw new Error("Native Vision input has not been rendered");
        const bitmap = canvas.transferToImageBitmap();
        const result = new Promise<NativeVisionMetadata>((resolve, reject) => { request = { resolve, reject }; });
        try { sender.send(bitmap); }
        catch (error) { bitmap.close(); request = undefined; throw error; }
        // A capture/worker error arrives through the same bounded frame channel.
        // Do not wait for its successful ACK: that requires the graph to upload
        // the returned frame, which happens AFTER run resolves (including offline).
        void sender.waitAvailable().then(async () => {
          if (!request) return;
          const status = await bridge.status(name);
          throw new Error(status.error ?? "Native Vision acknowledged capture without delivering a result");
        }).catch(error => {
          request?.reject(error instanceof Error ? error : new Error(String(error))); request = undefined;
        });
        return await result;
      } finally { running = false; }
    },
    close(): Promise<void> {
      if (closing) return closing;
      closed = true; discard(); presentation.dispose(); sender.close();
      request?.reject(new Error("Native Vision source closed")); request = undefined;
      closing = opened.then(id => id === null ? undefined : bridge.close(id));
      return closing;
    },
  };
}
