/** Renderer-side routing only. Presence of a dedicated bridge, not the OS name,
 * establishes availability. Never substitute another native video transport. */
export type NativeVideoTransport = "syphon" | "ndi" | "spout";
export const NATIVE_VIDEO_LABELS: Record<NativeVideoTransport, string> = {
  syphon: "Syphon", ndi: "NDI", spout: "Spout",
};
export const SPOUT_UNAVAILABLE = "Spout requires Windows desktop; its native adapter is not implemented in this build. Graph preparation only.";
export const NATIVE_INPUT_TRANSPORTS: Readonly<Record<string, NativeVideoTransport | undefined>> = {
  syphonIn: "syphon", ndiIn: "ndi", spoutIn: "spout",
};
export const NATIVE_OUTPUT_TRANSPORTS: Readonly<Record<string, NativeVideoTransport | undefined>> = {
  syphonOut: "syphon", ndiOut: "ndi", spoutOut: "spout",
};
