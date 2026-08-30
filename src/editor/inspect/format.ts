import type { CostBucket, TimingBucket } from "@runtime/telemetry/index.ts";

/**
 * Display formatters shared by the node info popup and the performance tab.
 *
 * `formatMs` is where §V86 becomes a pixel. A `TimingBucket` carries `gpuMs: number | null`
 * plus WHY it is null, and this is the only function that turns either into text. There is
 * no branch here that renders an absent measurement as a digit: "unavailable" when the
 * device has no timestamp query, "measuring…" while spans are still in flight, and a real
 * number only when a GPU span produced one.
 */

export interface FormattedMs {
  readonly text: string;
  /** True when the text is a WORD standing in for a number that does not exist. */
  readonly absent: boolean;
}

export function formatMs(bucket: TimingBucket): FormattedMs {
  switch (bucket.availability) {
    case "unavailable":
      // No timestamp query on this device (§V12). No amount of waiting produces a number,
      // and a CPU-side stand-in would be a confident lie about where the frame went.
      return { text: "unavailable", absent: true };
    case "pending":
      return { text: "measuring…", absent: true };
    case "measured":
      return { text: `${(bucket.gpuMs ?? 0).toFixed(3)} ms`, absent: false };
  }
}

/**
 * The same rule for the CPU half (T256).
 *
 * A separate function rather than a widened `formatMs`, because the two buckets are
 * separate types on purpose (§V86): CPU milliseconds must never reach a formatter whose
 * input field is called `gpuMs`, or one careless read puts them under the GPU label.
 */
export function formatCost(bucket: CostBucket): FormattedMs {
  switch (bucket.availability) {
    case "unavailable":
      // Nothing is measuring this half. A zero would read as FREE and send someone
      // optimising the node above it — the exact failure §V86 names, CPU side.
      return { text: "unavailable", absent: true };
    case "pending":
      return { text: "measuring…", absent: true };
    case "measured":
      return { text: `${(bucket.ms ?? 0).toFixed(3)} ms`, absent: false };
  }
}

const KIB = 1024;

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  if (bytes < KIB) return `${bytes} B`;
  if (bytes < KIB * KIB) return `${(bytes / KIB).toFixed(1)} KiB`;
  if (bytes < KIB * KIB * KIB) return `${(bytes / (KIB * KIB)).toFixed(1)} MiB`;
  return `${(bytes / (KIB * KIB * KIB)).toFixed(2)} GiB`;
}

/** TD shows aspect as a ratio; a decimal is more use than "16:9" for arbitrary sizes. */
export function formatAspect(aspect: number | null): string {
  return aspect === null ? "—" : aspect.toFixed(3);
}
