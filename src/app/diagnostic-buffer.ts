import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";

/**
 * The retained-diagnostic ring (T596).
 *
 * ## What was wrong
 *
 * Two hooks kept a session's diagnostics as `[...current, diagnostic].slice(-50)`. That
 * is a correct ring and a dishonest log, because of what feeds it: the backend's hub
 * (`runtime/backend/diagnostics.ts`) deliberately RE-EMITS a condition that is still true
 * once per second, forever, with a running "(N repeat(s) suppressed)" count (T99). So a
 * single persisting warning — measured live at ~1 every 2s on a graph with one bad
 * preview pass — fills all fifty slots inside a minute and EVICTS every distinct
 * diagnostic that came before it. From then on the buffer reads the same fifty lines no
 * matter what happens: an agent polling `get_diagnostics` sees a list that has saturated
 * and stopped moving, and the device-loss report or compile refusal it needed is gone.
 * An agent driving the app read exactly that twice and drew the wrong conclusion twice.
 *
 * A bound is there to stop a failing frame growing the heap forever. It was never meant
 * to spend the whole log on one sentence.
 *
 * ## The rule
 *
 * ONE SLOT PER CONDITION. A repeat replaces its own entry and moves it to the newest
 * position — so fifty slots hold fifty DISTINCT conditions, a condition that has been
 * true for an hour costs one of them, and the ring rotates over information rather than
 * over duplicates. The retained copy is the NEWEST report, which is the one carrying the
 * suppressed count, so "how many times" and "how recently" both survive the collapse.
 *
 * Identity is the diagnostic minus that generated suffix: two DIFFERENT messages under
 * one code (two invalid passes in one compile) are two conditions and both stay, which is
 * the same distinction the hub itself makes when it decides what to dedupe.
 */

/** What a session retains per source. Bounded so a failing frame cannot grow forever. */
export const MAX_RETAINED_DIAGNOSTICS = 50;

/**
 * The hub's own suffix (T99). Stripped for identity ONLY — never from what is stored.
 * It is our format, generated a few files away, not text from a document (§V37).
 */
const REPEAT_SUFFIX = / \(\d+ repeat\(s\) suppressed\)$/;

function identityOf(diagnostic: RuntimeDiagnostic): string {
  return [
    diagnostic.code,
    diagnostic.nodeId ?? "",
    diagnostic.portId ?? "",
    diagnostic.message.replace(REPEAT_SUFFIX, ""),
  ].join("|");
}

/**
 * Appends `diagnostic`, collapsing it onto any earlier report of the SAME condition.
 * Newest last. Returns a new array; the input is never mutated.
 */
export function retainDiagnostic(
  current: readonly RuntimeDiagnostic[],
  diagnostic: RuntimeDiagnostic,
  max: number = MAX_RETAINED_DIAGNOSTICS,
): readonly RuntimeDiagnostic[] {
  const key = identityOf(diagnostic);
  const kept = current.filter((entry) => identityOf(entry) !== key);
  kept.push(diagnostic);
  return kept.length > max ? kept.slice(-max) : kept;
}
