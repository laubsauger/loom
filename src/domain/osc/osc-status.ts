/**
 * T942 tier 3 — WHY there is no OSC, as a value rather than a sentence in a component.
 *
 * ## The rule this exists to obey (§V359, §T948)
 *
 * An ABSENT row and a FORGOTTEN row are the same pixels. OSC has at least seven reasons
 * and each needs a different thing from the reader:
 *
 *   idle          nothing has been asked yet     → start the helper, enter its code
 *   connecting    the socket is opening          → wait
 *   unreachable   nothing answered on 43919      → the helper is not running
 *   refused       the helper said no             → its own words (a stale code, usually)
 *   attached      helper present, no port open   → set a Port on an OSC In node
 *   listening     a UDP socket is open           → send something at it
 *   error         the stream is in trouble       → its own words
 *
 * Collapsing any two produces the §V338/§V469 shape the plan found across TouchDesigner's
 * I/O operators: a plausible nothing with no way to tell which nothing it is.
 *
 * ## §T948 rule 3, applied: the copy says what to DO
 *
 * Not "OSC is disabled on the hosted build" — that answers a question nobody asked, and it
 * is also not even true: a local clone with no helper running is exactly as limited. The
 * reader's question is always "what do I do to make this work", so every line below names
 * an action or says plainly that there is not one yet.
 *
 * ## Why it is a function and not JSX
 *
 * §V90/§V91/§V92 cap a chrome string at 60 characters, and `copy-guard.test.ts`
 * deliberately does not scan `src/editor/inspector` — so a section built there gets no cap
 * for free. Putting the strings here is what puts them back under one, and this file's own
 * test is the cap. Same reasoning, same shape as `midi-status.ts` (§T959).
 */

/*
 * T1110: the COMMAND is not this module's fact. It used to be spelled here, twice, which is
 * how a rename of the one thing T1103 called "the one place that names the command" would
 * have left two hints still saying the old name. `helper.ts` is string constants and imports
 * nothing; §V901 forbids `devices` importing UPWARD, and this is the reverse direction.
 */
import { DEVICE_HELPER_COMMAND } from "@devices/helper.ts";

/**
 * WHY there is (or is not) OSC. Lives here rather than in the transport so a DOMAIN module
 * never has to import one — the same direction `midi-status.ts` faces.
 */
export type OscBridgeState =
  /** Nothing has been asked yet. The state on load, and not a failure. */
  | { readonly kind: "idle" }
  | { readonly kind: "connecting" }
  /** Attached to the helper, but not listening on any UDP port yet. */
  | { readonly kind: "attached" }
  /** Listening on every UDP port the document's `oscIn` nodes name. */
  | { readonly kind: "listening"; readonly ports: readonly number[] }
  /** The helper refused the pairing code, or refused the subscription. Its own words. */
  | { readonly kind: "refused"; readonly reason: string }
  /** No helper answered on the bridge port. The ordinary state on a machine with none. */
  | { readonly kind: "unreachable" }
  /** Attached, but the stream itself is in trouble. Carries the helper's sentence. */
  | { readonly kind: "error"; readonly reason: string };

export interface OscStatus {
  /** One line, at most 60 characters, naming the state. */
  readonly headline: string;
  /** What to do about it, at most 60 characters. Null when the headline is the whole of it. */
  readonly hint: string | null;
}

/** The 60-character cap of §V90/§V91/§V92, as a number this file's test asserts against. */
export const OSC_COPY_LIMIT = 60;

/**
 * What the helper could HONESTLY say about a send, as a sentence (§T950 gap 3).
 *
 * The vocabulary is the guarantee. `OscSendOutcome` has three members and none of them
 * means "arrived", so there is no word here for a UI to render as success — the closest
 * this can come is *sent … arrival unconfirmed*, and it says the second half out loud.
 * Its own test pins that: the string "delivered" must never appear, and neither may a
 * bare tick.
 *
 * Typed structurally rather than importing `OscSendOutcome` so a DOMAIN module does not
 * have to reach into a transport for a shape it only renders.
 */
export function describeSendOutcome(
  outcome:
    | { readonly delivery: "refused" | "failed"; readonly reason: string }
    | {
        readonly delivery: "unconfirmed";
        readonly handed: number;
        readonly to: { readonly host: string; readonly port: number };
      }
    | null,
): string {
  if (outcome === null) return "Nothing sent yet.";
  if (outcome.delivery === "unconfirmed") {
    return `Sent ${String(outcome.handed)} to ${outcome.to.host}:${String(outcome.to.port)} — arrival unconfirmed (UDP).`;
  }
  return outcome.delivery === "refused" ? `Not sent: ${outcome.reason}` : `Send failed here: ${outcome.reason}`;
}

export function oscStatusLine(state: OscBridgeState, addressCount: number): OscStatus {
  switch (state.kind) {
    case "idle":
      // NOT "disabled". The helper is a thing you RUN, and naming it is the whole answer
      // to "why does this node do nothing on the hosted build" (§T948 rule 3).
      return {
        headline: "OSC needs a local helper",
        hint: `Run ${DEVICE_HELPER_COMMAND}, then enter its pairing code.`,
      };
    case "connecting":
      return { headline: "Reaching the local helper", hint: "One moment." };
    case "unreachable":
      return {
        headline: "No local helper answered",
        hint: `Start it with ${DEVICE_HELPER_COMMAND} in the project.`,
      };
    case "refused":
      // The helper's own words. A stale pairing code is the ordinary cause and the helper
      // says so better than a paraphrase could.
      return { headline: "The helper refused", hint: state.reason };
    case "attached":
      // The one state people misread as broken: the helper IS there, and the document has
      // not told it which UDP port to open. So the action is on the node, not the helper.
      return {
        headline: "Helper attached, no port open",
        hint: "Set Port on an OSC In node to start listening.",
      };
    case "error":
      return { headline: "The OSC stream stopped", hint: state.reason };
    case "listening": {
      const ports = state.ports.map((port) => String(port)).join(", ");
      return addressCount === 0
        ? {
            headline: `Listening on ${ports}, nothing heard`,
            hint: "Send something — try tools/osc-send.mjs.",
          }
        : {
            headline: `Listening on ${ports} — ${String(addressCount)} address${addressCount === 1 ? "" : "es"}`,
            hint: null,
          };
    }
  }
}
