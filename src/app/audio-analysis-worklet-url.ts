/**
 * T1225 — the one place the worklet's URL is minted.
 *
 * `?worker&url` is the Vite form that BUNDLES the module (its `@domain` import and all)
 * as its own entry and hands back the address: in dev the transformed source served as
 * an ES module, in a build an emitted chunk under `assets/` (`worker.format: "es"` in
 * `vite.config.ts`, the format `AudioWorklet.addModule` needs). A bare
 * `new URL("./x.worklet.ts", import.meta.url)` emits the TypeScript source as an asset,
 * untransformed — which loads in dev and fails in production, the same shape as §B151.
 *
 * Consumers: `use-audio-input.ts` from T1226 on; until then only the parity spec.
 */
import workletUrl from "./audio-analysis.worklet.ts?worker&url";

export const AUDIO_ANALYSIS_WORKLET_URL: string = workletUrl;
