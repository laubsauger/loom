/**
 * The header's two metric formatters (§V86).
 *
 * In their own module because both the top bar and the live GPU readout that fills its
 * `gpuMetric` slot must render the same absence the same way, and exporting a function
 * beside a component costs a react-refresh warning. An absent measurement is the em dash
 * — never `0.00 ms`, which would claim the frame was free.
 */

const EM_DASH = "—";

export function formatFps(fps: number | null | undefined): string {
  return typeof fps === "number" && Number.isFinite(fps) ? fps.toFixed(1) : EM_DASH;
}

export function formatMs(ms: number | null | undefined): string {
  return typeof ms === "number" && Number.isFinite(ms) ? `${ms.toFixed(2)} ms` : EM_DASH;
}
