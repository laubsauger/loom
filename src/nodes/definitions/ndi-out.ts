import type { NodeDefinition } from "../../domain/types/node-definition.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";
import { SINK_TAG } from "./sink.ts";

export const NDI_OUT_TYPE = "ndiOut";
export const ndiOutNode: NodeDefinition = {
  type: NDI_OUT_TYPE, version: 1, title: "NDI Out", category: "output",
  description: "Publishes full-input-resolution SDR network video through the desktop NDI SDK. Requires local-network consent. Uses CPU staging and lossy encoding, not zero-copy tensor transport. Publication stops during offline renders. Nominal stream rate is 60 fps; delivery follows live rendering.",
  tags: [SINK_TAG, "ndi", "native", "video", "network"], sink: true, sideEffect: "emits",
  previewInput: "input",
  inputs: [{ id: "input", label: "Input", type: RGBA_TEXTURE }], outputs: [],
  parameters: {
    name: { type: "string", label: "Publisher name", default: "Loom",
      description: 'Distinct NDI publisher name shown in receiving apps. Loom limit: 128 UTF8 bytes. Reserved characters: \\ / : * ? " < > |.' },
    enabled: { type: "boolean", label: "Publish", default: true },
  },
  // T1340b: same three as NDI In — host, platform, and the SDK the user supplies.
  requires: ["desktop", "macos", "ndi-sdk"],
  compile: () => ({ passes: [] }),
};
