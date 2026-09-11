import type { MediaSource } from "@runtime/backend/backend-types.ts";

export interface NativeInputSourceInfo { id: string; name: string; app: string }
export interface NativeInputMetadata { session: string; sequence: number; width: number; height: number }
export interface DesktopInputBridge {
  list(): Promise<NativeInputSourceInfo[]>;
  open(uuid: string, consume: (frame: VideoFrame, metadata: NativeInputMetadata) => Promise<void>): Promise<string>;
  poll(session: string): Promise<{ kind: "busy" | "empty" | "sent" | "closed" }>;
  close(session: string): Promise<unknown>;
}
export function desktopInputBridge(): DesktopInputBridge | undefined {
  return (window as Window & { loomDesktop?: { input?: DesktopInputBridge } }).loomDesktop?.input;
}

/** One owned GPU frame. Never retain a preload-owned VideoFrame after callback return. */
export function createNativeInputSource(bridge: DesktopInputBridge, uuid: string, options: {
  size(): readonly [number, number] | undefined;
  resize(width: number, height: number): Promise<void>;
  report(message: string | null): void;
}) {
  let closed = false;
  let leaving = false;
  let session: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: { image: VideoFrame; frameId: number; width: number; height: number } | undefined;
  let releaseScheduled = false;
  const discard = () => { pending?.image.close(); pending = undefined; };
  const dispose = () => {
    if (closed) return;
    closed = true; clearTimeout(timer); discard();
    if (session) void bridge.close(session).catch(error => options.report(`Native input close failed: ${String(error)}`));
  };
  const fail = (error: unknown) => {
    if (closed) return;
    options.report(`Syphon input unavailable; retained image is stale. ${String(error)}`);
    dispose();
  };
  const source: MediaSource = {
    currentFrame() {
      const frame = pending;
      const size = options.size();
      if (closed || !frame || size?.[0] !== frame.width || size[1] !== frame.height) return undefined;
      // The backend copies external images synchronously during render. Release at
      // the end of this JS task, after every texture using this source has submitted
      // its copy. Chromium keeps its GPU reference until the queued work completes.
      if (!releaseScheduled) {
        releaseScheduled = true;
        queueMicrotask(() => {
          releaseScheduled = false;
          if (pending === frame) discard();
        });
      }
      return { image: frame.image, frameId: frame.frameId };
    },
  };
  const poll = async () => {
    if (closed || !session) return;
    try {
      if (!pending) {
        const result = await bridge.poll(session);
        if (result.kind === "closed") {
          session = undefined; // Main already retired it; do not close it twice.
          options.report("Syphon input session closed");
          dispose();
          return;
        }
      }
      if (!closed) timer = setTimeout(() => void poll(), 16);
    } catch (error) { fail(error); }
  };
  options.report("Waiting for a Syphon frame");
  const ready = bridge.open(uuid, async (frame, metadata) => {
    if (closed) return;
    if (pending) throw new Error("Native input delivered while a frame is still owned");
    const image = frame.clone();
    pending = { image, frameId: metadata.sequence, width: metadata.width, height: metadata.height };
    try {
      const size = options.size();
      if (size?.[0] !== metadata.width || size[1] !== metadata.height)
        await options.resize(metadata.width, metadata.height);
      if (!closed) options.report(null);
    } catch (error) { fail(error); }
  }).then(async id => {
    if (closed) { if (!leaving) await bridge.close(id); return; }
    session = id;
    await poll();
  }).catch(fail);
  // The document is leaving: release renderer frames immediately, without racing
  // an IPC close against main's committed-navigation retirement.
  const releaseForNavigation = () => { leaving = true; session = undefined; dispose(); };
  return { source, dispose, releaseForNavigation, ready };
}
