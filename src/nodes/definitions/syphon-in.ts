import type { NodeDefinition } from "../../domain/types/node-definition.ts";
import { compileMedia } from "./media.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";

export const SYPHON_IN_TYPE = "syphonIn";
export const syphonInNode: NodeDefinition = {
  type: SYPHON_IN_TYPE, version: 1, title: "Syphon In", category: "input",
  description: "Live SDR video from a macOS Syphon publisher through the desktop app. Adopts source resolution. Pick a source in the inspector; the node remembers it by the publishing app and server name, so it reconnects by itself when the publisher restarts (VN113). Until that server is live again it holds the last image and reports it as stale. Live input is not deterministic replay.",
  tags: ["syphon", "native", "video", "live"],
  inputs: [], outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  parameters: {
    source: { type: "string", label: "Source", default: "",
      description: "Discovery id of the server last bound. Only a tie-breaker: when several live servers share the app and name below, this one is preferred." },
    // VN113 (owner ruling, 2026-10-10): the source's identity is app + name, which
    // survive a publisher relaunch; the UUID does not. Empty in older documents, which
    // match by `source` alone and learn these the first time that UUID is live.
    sourceApp: { type: "string", label: "Source app", default: "",
      description: "Publishing application of the chosen server (e.g. Arena). Written by the inspector's picker." },
    sourceName: { type: "string", label: "Source name", default: "",
      description: "Name of the chosen Syphon server (e.g. LED FX). With the app, this is what the node reconnects to." },
  },
  // T1340b: the declaration of record. The example list and the node's own warning
  // both read THIS; neither carries a type switch of its own.
  requires: ["desktop", "macos"],
  resolutionPolicy: { kind: "project" }, compile: compileMedia,
};
