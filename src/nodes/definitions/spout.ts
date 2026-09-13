import type { NodeDefinition } from "../../domain/types/node-definition.ts";
import { compileMedia } from "./media.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";
import { SINK_TAG } from "./sink.ts";

export const SPOUT_IN_TYPE = "spoutIn";
export const SPOUT_OUT_TYPE = "spoutOut";
const availability = "Preparation only: the Windows native Spout adapter is not implemented. No live sharing is available in current builds.";

export const spoutInNode: NodeDefinition = {
  type: SPOUT_IN_TYPE, version: 1, title: "Spout In", category: "input",
  description: `${availability} Intended for live SDR video from an exact Windows Spout publisher, adopting source resolution. Live input is not deterministic replay.`,
  tags: ["spout", "native", "video", "live"],
  inputs: [], outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  parameters: {
    source: { type: "string", label: "Source", default: "",
      description: "Exact Spout publisher name. Empty means unselected, never the system's active sender." },
  },
  resolutionPolicy: { kind: "project" }, compile: compileMedia,
};

export const spoutOutNode: NodeDefinition = {
  type: SPOUT_OUT_TYPE, version: 1, title: "Spout Out", category: "output",
  description: `${availability} Intended to publish full-input-resolution SDR video to Windows Spout receivers, including separately installed SpoutCam. Publication stops during offline renders.`,
  tags: [SINK_TAG, "spout", "native", "video"], sink: true, sideEffect: "emits",
  previewInput: "input",
  inputs: [{ id: "input", label: "Input", type: RGBA_TEXTURE }], outputs: [],
  parameters: {
    name: { type: "string", label: "Publisher name", default: "Loom",
      description: "Distinct Spout publisher name shown in receiving apps." },
    enabled: { type: "boolean", label: "Publish", default: true },
  },
  compile: () => ({ passes: [] }),
};
