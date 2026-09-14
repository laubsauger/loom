/** Renderer-side routing only. Presence of a dedicated bridge, not the OS name,
 * establishes availability. Never substitute another native video transport. */
export type NativeVideoTransport = "syphon" | "ndi" | "spout";
export const NATIVE_VIDEO_LABELS: Record<NativeVideoTransport, string> = {
  syphon: "Syphon", ndi: "NDI", spout: "Spout",
};
/* T1340b: `SPOUT_UNAVAILABLE` lived here — a fifth sentence for a fact the library, the
   inspector and two session hooks each phrased differently. It is now the `spoutIn`/
   `spoutOut` definitions' own `requires: [..., "not-implemented"]`, and every surface
   reads the one table in `@domain/types/requirements.ts` for the words. */
export const NATIVE_INPUT_TRANSPORTS: Readonly<Record<string, NativeVideoTransport | undefined>> = {
  syphonIn: "syphon", ndiIn: "ndi", spoutIn: "spout",
};
export const NATIVE_OUTPUT_TRANSPORTS: Readonly<Record<string, NativeVideoTransport | undefined>> = {
  syphonOut: "syphon", ndiOut: "ndi", spoutOut: "spout",
};
