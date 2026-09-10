import type { NodeDefinition } from "../../domain/types/node-definition.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";
import { SINK_TAG } from "./sink.ts";

export const SYPHON_OUT_TYPE = "syphonOut";
export const syphonOutNode: NodeDefinition = {
  type: SYPHON_OUT_TYPE, version: 1, title: "Syphon Out", category: "output",
  description: "Publishes its input at full input resolution as SDR video to macOS Syphon apps. Requires the desktop app. Publication stops during offline renders. Use a distinct publisher name for each output.",
  tags: [SINK_TAG, "syphon", "native", "video"], sink: true, sideEffect: "emits",
  inputs: [{ id: "input", label: "Input", type: RGBA_TEXTURE }], outputs: [],
  parameters: {
    name: { type: "string", label: "Publisher name", default: "Loom", description: "Unique name shown in receiving apps." },
    enabled: { type: "boolean", label: "Publish", default: true },
  },
  // The session presents the upstream resource directly. No graph copy or sink target.
  compile: () => ({ passes: [] }),
};
