import type { TimingUnavailableReason } from "@runtime/telemetry/index.ts";
import styles from "./inspect.module.css";

/**
 * WHY there is no per-pass GPU timing — ONE sentence per MEASURED fact (B172, §V469).
 *
 * ## The bug this replaces
 *
 * Both surfaces that say this — the performance tab and the node info popup — used to
 * hardcode "this adapter does not offer `timestamp-query`", branching on nothing but
 * `timingAvailable`. On the owner's Mac the adapter DID offer it, the device DID grant
 * it, and the same panel said so four lines above: `timestamp query  yes`. The flag those
 * sentences read does not mean "the device lacks the feature"; it means "the hub has no
 * timing source", and for a year nothing in the product ever attached one. So the copy
 * blamed the machine for our own omission, on a screen that contradicted itself.
 *
 * Two sources for one fact is §V837's shape, and the fix is the one §V837 prescribes:
 * the sentence is DERIVED from the fact rather than asserted beside it. Each branch below
 * states only what the hub actually measured, and none of them makes a claim about what
 * the adapter offered — the ask can also be dropped by `gpu-host.ts`'s fallback, so the
 * absence of the ask proves "not requested" and nothing more.
 *
 * The fourth state — attached, granted, no spans yet — is not an absence at all: it is
 * `"pending"` (`hub.ts`'s own vocabulary), `timingAvailable` is true, and the cells read
 * "measuring…" while this note renders nothing.
 *
 * Kept in one component rather than duplicated because the duplicate is what let the
 * wrong sentence live in two files at once.
 */
export function TimingUnavailableNote({ reason }: { reason: TimingUnavailableReason | null }) {
  if (reason === null) return null;
  if (reason === "not-attached") {
    // OURS. The hub has no timing source, so it knows nothing about any device and must
    // not speak for one — this says what is missing on our side and stops there.
    return <p className={styles.note}>No per-pass timing — no GPU timer is attached.</p>;
  }
  if (reason === "not-requested") {
    return (
      <p className={styles.note}>
        No per-pass timing — the device request did not ask for <code>timestamp-query</code>.
      </p>
    );
  }
  return (
    <p className={styles.note}>
      No per-pass timing — the device did not grant <code>timestamp-query</code>.
    </p>
  );
}
