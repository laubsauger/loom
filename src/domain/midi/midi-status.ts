/**
 * T942 tier 1 — WHY there is no MIDI, as a value rather than as a sentence in a component.
 *
 * ## The rule this exists to obey
 *
 * §V359: an ABSENT row and a FORGOTTEN row are the same pixels, and an unavailable thing
 * must be rendered WITH ITS REASON rather than hidden. MIDI has at least five reasons and
 * they need five different actions from the reader:
 *
 *   idle         nothing has been asked yet          → press the button
 *   unsupported  Safari, at every version            → nothing to press; use another browser
 *   requesting   the prompt is open                  → answer it
 *   granted, 0   access is on, nothing plugged in    → plug something in
 *   denied       refused (or, on Firefox, no add-on) → change the site setting
 *   failed       the API threw                       → its own words
 *
 * Collapsing any two of those produces the §V338/§V469 shape the plan calls out in
 * TouchDesigner's own I/O operators: a plausible nothing with no way to tell which nothing
 * it is.
 *
 * ## §T948 rule 3, applied: the copy says what to DO
 *
 * Not "MIDI is disabled" — that answers a question nobody asked. The reader's question is
 * always "what do I do to make this work", so every line below either names an action or
 * says plainly that there is not one.
 *
 * ## Why it is a function and not JSX
 *
 * Because §V90/§V91/§V92 cap a chrome string at 60 characters and this file's own test
 * enforces that on every string the function can return — including the ones a component
 * would otherwise bury in a branch nobody renders in a test. `copy-guard.test.ts`
 * deliberately does not scan `src/editor/inspector`, so a section built there gets no cap
 * for free; putting the strings here is what puts them back under one.
 */

/** WHY there is (or is not) MIDI. See the module note for what each member means. */
export type MidiAccessState =
  /** Nothing has been asked yet. The state on load, and not a failure. */
  | { readonly kind: "idle" }
  /** No `requestMIDIAccess` at all — Safari, at every version. Nothing to retry. */
  | { readonly kind: "unsupported" }
  | { readonly kind: "requesting" }
  | { readonly kind: "granted" }
  /** The prompt was refused (or, on Firefox, the site-permission add-on is absent). */
  | { readonly kind: "denied" }
  /** Access resolved but threw or vanished. Carries the browser's own words. */
  | { readonly kind: "failed"; readonly message: string };

export interface MidiInputPort {
  readonly id: string;
  /** The port's own name, or "" while the browser withholds it. */
  readonly name: string;
}

export interface MidiStatus {
  /** One line, at most 60 characters, naming the state. */
  readonly headline: string;
  /** What to do about it, at most 60 characters. Null when the headline is the whole of it. */
  readonly hint: string | null;
  /** Would asking for access change anything? False for `unsupported` — no dead button. */
  readonly canRequest: boolean;
}

/** The 60-character cap of §V90/§V91/§V92, as a number this file's test can assert against. */
export const MIDI_COPY_LIMIT = 60;

export function midiStatusLine(state: MidiAccessState, portCount: number): MidiStatus {
  switch (state.kind) {
    case "idle":
      return { headline: "MIDI is off", hint: "Enable it to use a controller.", canRequest: true };
    case "unsupported":
      // Safari has no Web MIDI at ANY version, so this is permanent rather than a retry,
      // and the copy must not imply a button would help.
      return {
        headline: "This browser has no Web MIDI",
        hint: "Use Chrome, Edge or Firefox on the desktop.",
        canRequest: false,
      };
    case "requesting":
      return { headline: "Waiting for MIDI permission", hint: "Answer the browser prompt.", canRequest: false };
    case "denied":
      // Firefox cannot distinguish a refusal from a missing site-permission add-on, so
      // the hint names both routes rather than guessing which one the reader is in.
      return {
        headline: "MIDI access was refused",
        hint: "Allow it in site settings; Firefox needs its add-on.",
        canRequest: true,
      };
    case "failed":
      return { headline: "MIDI could not start", hint: state.message, canRequest: true };
    case "granted":
      return portCount === 0
        ? { headline: "MIDI is on, no inputs found", hint: "Attach a controller.", canRequest: false }
        : {
            headline: `MIDI is on — ${String(portCount)} input${portCount === 1 ? "" : "s"}`,
            hint: null,
            canRequest: false,
          };
  }
}
