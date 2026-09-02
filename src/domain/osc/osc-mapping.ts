/**
 * WHAT AN `oscIn` IS BOUND TO (T942 tier 3) — and the node's OWN parameters are the whole
 * user interface for it.
 *
 * ## The ruling this file is shaped by
 *
 * The owner: *"oscIn and oscOut should be a node à la TouchDesigner and not a separate
 * menu pane section. This is true for all these things… everything should be a node
 * surface so that we don't end up with a million menu sections hard coded into our app.
 * This way everything stays pluggable — we can consider stuff as plugins that just add
 * nodes and the node's dependencies, and the interface to the user stays in the node."*
 *
 * So there is no OSC pane, no OSC picker widget and no bespoke learn table. The
 * mechanism instead is `NodeDefinition.parametersFor(stored)` (§T880, §T900): **the node
 * computes its own parameter schema from its own stored state.** `oscIn` carries one
 * declaration parameter — `controls`, a list of names — and every row's Address and Rest
 * are ORDINARY PARAMETERS generated from it. They are drivable, undoable, diffable, agent
 * visible and rendered by the existing parameter controls, because they are not special.
 *
 * This file is the spelling of that generation, in one place, because three surfaces have
 * to agree on it: `parametersFor` (which declares the keys), `valueEvaluate` (which reads
 * them) and any test that asserts on either.
 *
 * ## Why the keys are `<name>Address` and `<name>Rest` rather than `<name>.address`
 *
 * A dot already means something in this codebase's parameter space — §T403's map keys are
 * spelled `color.r` — so a generated key carrying one would be a key that reads as a
 * component of something. Camel-cased identifiers are what `customWgsl`'s reflected schema
 * produces, and following that keeps generated parameters looking like every other
 * parameter rather than like a second syntax.
 *
 * ## ONE DIFFERENCE FROM MIDI, AND IT IS A REFUSAL RATHER THAN AN OMISSION
 *
 * `midiIn` carries a `range` because a 7-bit CC has a KNOWN full scale (0..127), so
 * normalising at the source is arithmetic rather than a guess — and §T738 measured what
 * the alternative costs.
 *
 * **An OSC argument has no declared full scale.** `/synth/cutoff` may send 0..1, 0..127,
 * hertz or decibels, and only the person who configured the sender knows which. So there
 * is no range here and the value is published EXACTLY as it arrived; wire a `valueMath`
 * downstream when a band is wanted. Inventing a normalisation would be the §V147 shape
 * this codebase has rules against: plausible numbers, silently wrong, nothing said.
 *
 * `rest` stays, and for MIDI's reason: a channel with nothing behind it must publish a
 * DECLARED value, never a blind zero and never an absent channel (which would dangle every
 * parameter driven by it).
 */

import type { ParameterSchema } from "../types/parameters.ts";
import { isPublishableOscAddress } from "./osc-address.ts";

/** One control the node publishes: the name, and where its value comes from. */
export interface OscControl {
  /** The published channel name — `osc1:cutoff` reads this. The user's word. */
  readonly channel: string;
  /** The OSC address, or null when the row is declared but not yet pointed anywhere. */
  readonly address: string | null;
  /** What the channel publishes when nothing has arrived. Declared, never assumed. */
  readonly rest: number;
}

/**
 * The names a `controls` declaration asks for.
 *
 * Identifier-shaped and deduplicated, because a name is an ADDRESS (§V129): two rows
 * called `cutoff` would make `osc1:cutoff` ambiguous and the loser would simply never be
 * readable. A name that is not identifier-shaped is DROPPED rather than mangled — the
 * generated parameter keys are identifiers, and a name that cannot make one has no row.
 */
export function parseOscControlNames(stored: unknown): readonly string[] {
  if (typeof stored !== "string") return [];
  const names: string[] = [];
  const seen = new Set<string>();
  for (const token of stored.split(/[\s,]+/)) {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    names.push(token);
  }
  return names;
}

/** The generated parameter key holding one control's OSC address. */
export function oscAddressKey(name: string): string {
  return `${name}Address`;
}

/** The generated parameter key holding one control's rest value. */
export function oscRestKey(name: string): string {
  return `${name}Rest`;
}

/**
 * The per-control half of `oscIn`'s effective schema (§T880's mechanism, §T900's shape).
 *
 * Two ordinary parameters per declared name. Nothing about them is OSC-specific to the UI:
 * a string field and a number field, rendered by the same controls every other parameter
 * uses, which is the entire point of generating them rather than drawing a table.
 */
export function oscControlParameters(names: readonly string[]): ParameterSchema {
  const schema: ParameterSchema = {};
  for (const name of names) {
    schema[oscAddressKey(name)] = {
      type: "string",
      label: `${name} address`,
      default: "",
      description: `OSC address this control listens to, e.g. /synth/${name}. Empty means the row is declared but not pointed anywhere, so it publishes its rest. Multi-argument messages address by index: /pad/xy/1 is the second value.`,
    };
    schema[oscRestKey(name)] = {
      type: "number",
      label: `${name} rest`,
      default: 0,
      description: `What ${name} publishes when nothing has arrived — no helper, no sender, or not yet. Declared rather than assumed, so a control whose neutral is not zero does not open hard over (§V353).`,
    };
  }
  return schema;
}

/** The controls a node's resolved values describe, in declaration order. */
export function oscControlsOf(values: Readonly<Record<string, unknown>>): readonly OscControl[] {
  return parseOscControlNames(values["controls"]).map((name) => {
    const raw = values[oscAddressKey(name)];
    const address = typeof raw === "string" ? raw.trim() : "";
    const rest = values[oscRestKey(name)];
    return {
      channel: name,
      // An address that could never be published is stored as UNBOUND rather than kept as
      // a string nothing will ever match — the row still exists and still publishes.
      address: address !== "" && isPublishableOscAddress(address) ? address : null,
      rest: typeof rest === "number" && Number.isFinite(rest) ? rest : 0,
    };
  });
}

/**
 * One control's published number for this frame.
 *
 * `raw === undefined` is the DEGRADED path and it is the normal one on a machine with no
 * helper running: it publishes `rest`, never a stall and never an absent channel, so every
 * parameter driven by this node keeps a defined value and the document renders (§T715's
 * constraint, §V353's silence, §V144's stale-beats-stalled).
 */
export function oscControlValue(control: OscControl, raw: number | undefined): number {
  return raw === undefined || !Number.isFinite(raw) ? control.rest : raw;
}
