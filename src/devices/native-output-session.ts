import type { LoomBackend } from "@runtime/backend/index.ts";
import { attachNativeOutput } from "./native-output.ts";
import type { DesktopOutputBridge, NativeOutputSelection } from "./native-output.ts";
import { nativeOutputSender } from "./native-output-channel.ts";

/** One graph sink, one bounded transfer channel, the existing graph backend. */
export function createNativeOutputSession(backend: LoomBackend, bridge: DesktopOutputBridge,
  selection: NativeOutputSelection, publisherName: string) {
  const name = `loom-native-output-${crypto.randomUUID()}`;
  const sender = nativeOutputSender(name);
  let disposed = false;
  let attached: ReturnType<typeof attachNativeOutput> | undefined;
  let canvas: OffscreenCanvas;
  let lastFrame = 0;
  let closing: Promise<void> | undefined;
  let updates = 0;
  const opened = bridge.open(name, selection.size[0], selection.size[1], publisherName);
  const ready = Promise.all([opened, sender.promise]).then(() => {
    if (disposed) return;
    canvas = new OffscreenCanvas(selection.size[0], selection.size[1]);
    attached = attachNativeOutput(backend, selection, canvas);
  });
  let updating = ready;
  return {
    ready,
    update(next: NativeOutputSelection) {
      updates++;
      updating = updating.then(async () => {
        if (disposed) return;
        attached!.update(next);
        await bridge.resize(name, next.size[0], next.size[1]);
      }).finally(() => { updates--; });
      return updating;
    },
    pump() {
      if (disposed || !attached || updates) return;
      const frame = attached.presentedFrames();
      if (frame <= lastFrame || !sender.available) return;
      const bitmap = canvas.transferToImageBitmap();
      try { sender.send(bitmap); } catch (error) { bitmap.close(); throw error; }
      lastFrame = frame;
    },
    status: () => bridge.status(name),
    close(): Promise<void> {
      if (closing) return closing;
      disposed = true;
      sender.close();
      attached?.dispose();
      // Even a close during acquisition must await the open before retiring its
      // main-process session. Native close acknowledges completed GPU drainage.
      closing = opened.then(() => bridge.close(name), () => bridge.close(name));
      return closing;
    },
  };
}
