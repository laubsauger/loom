import type { NodeDefinition } from "../../domain/types/node-definition.ts";
import { compileMedia } from "./media.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";

export const NDI_IN_TYPE = "ndiIn";
export const ndiInNode: NodeDefinition = {
  type: NDI_IN_TYPE, version: 1, title: "NDI In", category: "input",
  description: "Live decoded SDR network video through the desktop NDI SDK. Requires local-network consent. Adopts source resolution; selects an exact source name. Disconnection retains a stale image with a diagnostic. Live input is not deterministic replay.",
  tags: ["ndi", "native", "video", "network", "live"],
  inputs: [], outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  parameters: {
    source: { type: "string", label: "Source", default: "",
      description: "Exact NDI source name selected in the inspector. No source substitution." },
  },
  resolutionPolicy: { kind: "project" }, compile: compileMedia,
};
