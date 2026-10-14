import type { LoomBackend } from "@runtime/backend/index.ts";
import type { PresentableCanvas } from "@runtime/backend/backend-types.ts";
import type { ColorPolicy } from "@domain/types/graph.ts";
import type { TextureFormat } from "@domain/types/node-definition.ts";
import type { ColorSpace } from "@domain/types/ports.ts";
import { sinkDisplayTransform } from "@domain/color/display.ts";
import type { NativeVideoTransport } from "./native-video.ts";

/** Transferred native-output surface, existing backend; never a graph copy. */
export interface NativeOutputSelection {
  readonly resourceId: string;
  readonly size: readonly [number, number];
  /**
   * VNB25: the presentation blit applies the display encode (`nativeOutputEncodes`). Absent
   * is the raw copy — what the viewer's own native-output toggle (`use-native-output.ts`)
   * still sends; it is not this lane's path.
   */
  readonly encode?: boolean;
}

/**
 * VNB25 — does a native output owe its source the display encode?
 *
 * A native output must send what the Output node would show for the same input. Its
 * receiver (Resolume, OBS, …) displays 8-bit bytes as display values, and the session
 * presents the upstream texture directly, so a working-space LINEAR source published raw
 * reached every receiver ~gamma 2.2 too dark. The answer is the Output node's own decision,
 * `sinkDisplayTransform`, with no tone map (a native output has none — Output's `none`,
 * which clamps), read against the space the COMPILER published for the source:
 *
 *  - `linear` on a non-sRGB format, `displayTransform: "srgb"` → encode;
 *  - `linear` on `rgba8unorm-srgb` → no: the backend presents that storage through a
 *    non-decoding view (T1307), so its bytes are already display values (and the decision
 *    says so: the hardware encodes);
 *  - `encoded` (an Output's target, or any source that declares it) → as is: encoding twice is wrong;
 *  - `data`, or `displayTransform: "none"` → raw values out, as the Output node does.
 */
export function nativeOutputEncodes(
  source: { readonly format: TextureFormat; readonly space: ColorSpace },
  policy: ColorPolicy,
): boolean {
  return source.space === "linear" && sinkDisplayTransform(policy, source.format, source.space, "none").encode;
}
/** A compiled output row, as the plan publishes it (`ResolvedOutput`'s fields this reads). */
export interface NativeOutputSource {
  readonly nodeId: string;
  readonly portId: string;
  readonly resourceId: string;
  readonly size: readonly [number, number];
  readonly format: TextureFormat;
  readonly space: ColorSpace;
}

/**
 * What a native output node presents: the compiled output wired to its `input`, at that
 * output's size, with the display encode the Output node would apply to it (VNB25). Null
 * when nothing compiled is wired in.
 */
export function nativeOutputSelection(
  graph: { readonly edges: Readonly<Record<string, { readonly source: { readonly nodeId: string; readonly portId: string }; readonly target: { readonly nodeId: string; readonly portId: string } }>> },
  nodeId: string,
  outputs: ReadonlyArray<NativeOutputSource>,
  policy: ColorPolicy,
): NativeOutputSelection | null {
  const edge = Object.values(graph.edges).find(edge => edge.target.nodeId === nodeId && edge.target.portId === "input");
  const source = outputs.find(output => output.nodeId === edge?.source.nodeId && output.portId === edge.source.portId);
  return source ? { resourceId: source.resourceId, size: source.size, encode: nativeOutputEncodes(source, policy) } : null;
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
  const desktop = (window as Window & { loomDesktop?: unknown }).loomDesktop;
  const candidate = transport === "syphon" ? desktop : typeof desktop === "object" && desktop !== null
    ? (desktop as Record<string, unknown>)[transport === "ndi" ? "ndiOutput" : "spoutOutput"] : undefined;
  if (typeof candidate !== "object" || candidate === null || !("nativeOutput" in candidate) || candidate.nativeOutput !== true) return undefined;
  if (["open", "close", "resize", "status"].some(key => typeof (candidate as Record<string, unknown>)[key] !== "function"))
    throw new Error(`Invalid ${transport} native output bridge: an advertised output requires open, close, resize and status methods.`);
  return candidate as DesktopOutputBridge;
}
export function attachNativeOutput(backend: LoomBackend, selection: NativeOutputSelection, canvas: PresentableCanvas) {
  canvas.width = selection.size[0]; canvas.height = selection.size[1];
  let disposed = false;
  const encode = selection.encode === true;
  const presentation = backend.present(canvas, { outputId: selection.resourceId, label: "native-sdr-output", displayEncode: encode });
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
      // The blit's shader is fixed for the presentation's life: a change of encode is a new
      // session (`use-native-outputs.ts` keys the session on it), never an in-place update.
      if ((next.encode === true) !== encode) throw new Error("Native output display encode cannot change in place");
      if (canvas.width !== next.size[0]) canvas.width = next.size[0];
      if (canvas.height !== next.size[1]) canvas.height = next.size[1];
      presentation.setOutput(next.resourceId);
    },
    dispose,
  };
}
