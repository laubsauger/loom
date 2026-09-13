import type { LoomBackend } from "@runtime/backend/index.ts";
import type { PresentableCanvas } from "@runtime/backend/backend-types.ts";
import type { NativeVideoTransport } from "./native-video.ts";

/** Transferred native-output surface, existing backend; never a graph copy. */
export interface NativeOutputSelection {
  readonly resourceId: string;
  readonly size: readonly [number, number];
}
export interface DesktopOutputBridge {
  readonly nativeOutput: true;
  open(name: string, width: number, height: number, publisherName: string): Promise<void>;
  close(name: string): Promise<void>;
  resize(name: string, width: number, height: number): Promise<void>;
  status(name: string): Promise<{ copied: number; dropped: number; error: string | null }>;
}
export type NativeOutputTransport = NativeVideoTransport;
export function desktopOutputBridge(transport: NativeOutputTransport = "syphon"): DesktopOutputBridge | undefined {
  const desktop = (window as Window & { loomDesktop?: DesktopOutputBridge & { ndiOutput?: DesktopOutputBridge; spoutOutput?: DesktopOutputBridge } }).loomDesktop;
  switch (transport) {
    case "syphon": return desktop;
    case "ndi": return desktop?.ndiOutput;
    case "spout": return desktop?.spoutOutput;
  }
}
export function attachNativeOutput(backend: LoomBackend, selection: NativeOutputSelection, canvas: PresentableCanvas) {
  canvas.width = selection.size[0]; canvas.height = selection.size[1];
  let disposed = false;
  const presentation = backend.present(canvas, { outputId: selection.resourceId, label: "native-sdr-output" });
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    presentation.dispose();
  };
  return {
    presentedFrames() {
      if (!presentation.describe) throw new Error("Native output requires presentation progress diagnostics");
      return presentation.describe().presentedFrames;
    },
    update(next: NativeOutputSelection) {
      if (disposed) throw new Error("Native output is closed");
      if (canvas.width !== next.size[0]) canvas.width = next.size[0];
      if (canvas.height !== next.size[1]) canvas.height = next.size[1];
      presentation.setOutput(next.resourceId);
    },
    dispose,
  };
}
