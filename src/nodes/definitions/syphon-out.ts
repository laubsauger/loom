import type { NodeDefinition } from "../../domain/types/node-definition.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";
import { SINK_TAG } from "./sink.ts";

export const SYPHON_OUT_TYPE = "syphonOut";
export const syphonOutNode: NodeDefinition = {
  type: SYPHON_OUT_TYPE, version: 1, title: "Syphon Out", category: "output",
  description: "Publishes its input at full input resolution as SDR video to macOS Syphon apps. Requires the desktop app. Publication stops during offline renders. Use a distinct publisher name for each output.",
  tags: [SINK_TAG, "syphon", "native", "video"], sink: true, sideEffect: "emits",
  previewInput: "input",
  inputs: [{ id: "input", label: "Input", type: RGBA_TEXTURE }], outputs: [],
  parameters: {
    name: { type: "string", label: "Publisher name", default: "Loom", description: "Unique name shown in receiving apps." },
    enabled: { type: "boolean", label: "Publish", default: true },
    // VNB25: what the receiver is handed. The values are `NATIVE_OUTPUT_COLORS`
    // (`src/devices/native-output.ts`), which decides the encode from them.
    colorSpace: { type: "enum", label: "Colour", default: "auto",
      options: [
        { value: "auto", label: "Auto (as Output shows)" },
        { value: "srgb", label: "sRGB (encode)" },
        { value: "raw", label: "Raw (no conversion)" },
      ],
      description: "What the receiver is sent. Auto: what an Output node shows for the same input, so linear light is sRGB encoded and an already encoded input is left alone. sRGB: always encode, for an input Loom cannot tell is linear. Raw: the input's values as they are, for an input that is already encoded by hand or carries data. Values above 1 clip." },
    alpha: { type: "boolean", label: "Keep alpha", default: false,
      description: "Publishes the input's alpha, read as premultiplied, for receivers that key on it. With an sRGB encode the colour is encoded and the alpha is not, so the frame stays premultiplied in display space. Off: an opaque frame." },
  },
  // T1340b: declared here, read by every surface that states it.
  requires: ["desktop", "macos"],
  // The session presents the upstream resource directly. No graph copy or sink target.
  // VNB25: through the Output node's display encode when that resource holds linear light
  // (`nativeOutputEncodes` in `src/devices/native-output.ts`), so a receiver sees what the
  // Output node shows. No tone map: Output's `none`, which clamps. VNB25: `colorSpace`
  // overrides that decision per output (always encode, or never).
  compile: () => ({ passes: [] }),
};
