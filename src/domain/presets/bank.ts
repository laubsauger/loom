import type { StoredParameter } from "../types/parameters.ts";
import { isParameterSlot } from "../parameters/slots.ts";

/**
 * T1496b (§T1398b S1) — THE PRESET BANK'S DATA: what a `presets` node holds in its
 * `presets` parameter, and how its `targets` read.
 *
 * The bank is a NODE and its data lives in PARAMETERS (ruling 1, the design doc §4.2), so
 * undo, audit, autosave, copy/paste, component export and the agent's `get_graph` work on
 * it with nothing built for them — the MIDI mapping's argument (`midi.ts`). This module is
 * the headless half: the JSON shape, its parser, and the target list. What Store and
 * Recall DO with it is `commands.ts`.
 *
 * Targets and value keys are node NAMES, never ids (§V129): names survive a paste into
 * another document, and the one rename clause for banks (`names.ts`) keeps a rename and
 * paste renumbering pointed at the right node (§V128, §V320).
 */

/** The node type every bank is. Named once here; the definition and the rename clause read it. */
export const PRESETS_NODE_TYPE = "presets";

/** The curve a morph eases along (`easeMorph`, `morph.ts`); parsed here so the shape is one. */
export type MorphCurve = "linear" | "smooth" | "in" | "out";

export const MORPH_CURVES: readonly MorphCurve[] = ["linear", "smooth", "in", "out"];

/**
 * How a change is carried out over time. `seconds` 0 = a cut. Seconds of the transport's
 * ABSOLUTE clock (T1497b, the design doc §5.4): they pass only while frames are produced.
 */
export interface MorphSpec {
  readonly seconds: number;
  readonly curve: MorphCurve;
}

export interface PresetBank {
  readonly version: 1;
  /** Button order on a Panel and on the phone. */
  readonly presets: readonly Preset[];
}

/** node NAME → key → the STORED form (bare value or whole slot). */
export type PresetValues = Readonly<Record<string, Readonly<Record<string, StoredParameter>>>>;

export interface Preset {
  /** Unique in the bank; an identifier, so expressions, cues and Panels can spell it. */
  readonly name: string;
  /** node NAME → key → the STORED form, written back verbatim (ruling 2). */
  readonly values: PresetValues;
  /** Node NAME → on/off (the design doc §7.2; any node, T1770b). A recall writes it as `ui.bypassed = !on`. Always a cut. */
  readonly on?: Readonly<Record<string, boolean>>;
  /**
   * A SHOT (T1499b, the design doc §8.1): other banks' presets recalled in the same patch,
   * in this order, under this preset's own values. Cycle-checked and depth-limited by the
   * planner (`commands.ts`).
   */
  readonly recalls?: ReadonlyArray<{ readonly bank: string; readonly preset: string }>;
  /** This preset's own morph. Absent means the bank's `morph` / `curve` (T1497b, §5.1). */
  readonly morph?: MorphSpec;
}

/** What a freshly dropped bank holds: a well-formed bank with nothing in it. */
export const EMPTY_PRESET_BANK_JSON = serializePresetBank({ version: 1, presets: [] });

/** A preset name must be an identifier, or nothing downstream can spell it. */
export function isPresetName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

/**
 * `preset1`, `preset2`, … — the first name the bank does not hold, so a Store with no name
 * typed never overwrites. The inspector's Store field and the Panel strip's Store
 * (T1527b) both start from it.
 */
export function nextPresetName(taken: readonly string[]): string {
  for (let index = taken.length + 1; ; index += 1) {
    const candidate = `preset${String(index)}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

export type PresetBankParse = { ok: true; bank: PresetBank } | { ok: false; reason: string };

const plainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A bare `ParameterValue` or a slot — the two shapes `GraphNode.parameters` holds. */
export function isStoredShape(value: unknown): value is StoredParameter {
  if (value === null) return true;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") return true;
  if (Array.isArray(value)) return true;
  return isParameterSlot(value);
}

/**
 * Parses a bank's JSON. Structure only: whether a named node exists and whether a value
 * suits its parameter is the RECALL's question, answered against the graph as it is then
 * (ruling 4). Blank text is an empty bank, so clearing the field is not an error.
 *
 * The reason names the preset and field, never quotes a value: bank text is document
 * content and a diagnostic is read by a model (§V37).
 */
export function parsePresetBank(text: unknown): PresetBankParse {
  if (typeof text !== "string" || text.trim() === "") return { ok: true, bank: { version: 1, presets: [] } };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: "the presets field is not valid JSON" };
  }
  if (!plainObject(raw)) return { ok: false, reason: "the presets field must be an object with version and presets" };
  if (raw["version"] !== 1) return { ok: false, reason: "the presets field has an unknown version (this build reads version 1)" };
  const list = raw["presets"];
  if (!Array.isArray(list)) return { ok: false, reason: "the presets field has no presets list" };
  const presets: Preset[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of list.entries()) {
    const parsed = parsePreset(entry, index);
    if (!parsed.ok) return parsed;
    if (seen.has(parsed.preset.name)) return { ok: false, reason: `two presets are named "${parsed.preset.name}"` };
    seen.add(parsed.preset.name);
    presets.push(parsed.preset);
  }
  return { ok: true, bank: { version: 1, presets } };
}

function parsePreset(entry: unknown, index: number): { ok: true; preset: Preset } | { ok: false; reason: string } {
  if (!plainObject(entry)) return { ok: false, reason: `preset ${index + 1} is not an object` };
  const name = entry["name"];
  if (typeof name !== "string" || !isPresetName(name)) {
    return { ok: false, reason: `preset ${index + 1} needs a name that is an identifier (letters, digits, _)` };
  }
  const where = `preset "${name}"`;
  const rawValues = entry["values"] ?? {};
  if (!plainObject(rawValues)) return { ok: false, reason: `${where}: values must be an object of node names` };
  const values: Record<string, Record<string, StoredParameter>> = {};
  for (const [nodeName, record] of Object.entries(rawValues)) {
    if (!plainObject(record)) return { ok: false, reason: `${where}: values for "${nodeName}" must be an object of parameter keys` };
    const keys: Record<string, StoredParameter> = {};
    for (const [key, stored] of Object.entries(record)) {
      if (!isStoredShape(stored)) return { ok: false, reason: `${where}: "${nodeName}.${key}" is neither a value nor a parameter slot` };
      keys[key] = stored;
    }
    values[nodeName] = keys;
  }
  let preset: Preset = { name, values };

  const on = entry["on"];
  if (on !== undefined) {
    if (!plainObject(on) || !Object.values(on).every((flag) => typeof flag === "boolean")) {
      return { ok: false, reason: `${where}: on must map node names to true or false` };
    }
    preset = { ...preset, on: on as Record<string, boolean> };
  }
  const recalls = entry["recalls"];
  if (recalls !== undefined) {
    if (
      !Array.isArray(recalls) ||
      !recalls.every((item) => plainObject(item) && typeof item["bank"] === "string" && typeof item["preset"] === "string")
    ) {
      return { ok: false, reason: `${where}: recalls must be a list of { bank, preset }` };
    }
    preset = {
      ...preset,
      recalls: (recalls as Array<Record<string, string>>).map((item) => ({ bank: item["bank"]!, preset: item["preset"]! })),
    };
  }
  const morph = entry["morph"];
  if (morph !== undefined) {
    const seconds = plainObject(morph) ? morph["seconds"] : undefined;
    const curve = plainObject(morph) ? morph["curve"] : undefined;
    if (
      typeof seconds !== "number" ||
      !Number.isFinite(seconds) ||
      seconds < 0 ||
      !MORPH_CURVES.includes(curve as MorphCurve)
    ) {
      return { ok: false, reason: `${where}: morph must be { seconds ≥ 0, curve: ${MORPH_CURVES.join(" | ")} }` };
    }
    preset = { ...preset, morph: { seconds, curve: curve as MorphCurve } };
  }
  return { ok: true, preset };
}

/** The bank as the `presets` parameter stores it. Two-space indent: it is hand-editable. */
export function serializePresetBank(bank: PresetBank): string {
  return `${JSON.stringify(bank, null, 2)}\n`;
}

/** One entry of a bank's `targets`: a whole node, or one of its keys. */
export interface PresetTarget {
  /** The token as written, for naming it in a warning. */
  readonly token: string;
  readonly node: string;
  /** Absent = every non-pulse parameter of the node (ruling 3). */
  readonly key?: string;
}

/**
 * T1771b — THE TARGET KEY THAT ASKS STORE FOR A NODE'S ON/OFF: `rig_keys.@on`. Store then
 * writes the node's switch (not bypassed = on) into the preset's `on` row, which a recall
 * writes back (§T1770b). Only a target that asks: a whole-node target captures parameters,
 * as it always has, so no existing bank starts storing switches. `@` cannot begin a
 * parameter key, so it cannot be mistaken for one (a Toggle's own parameter is `on`).
 */
export const PRESET_ON_TARGET_KEY = "@on";

/**
 * `targets` as a list: node names or `node.key`, separated by spaces or commas like
 * Render's `scenes`. The FIRST dot splits, so `glow.color.r` is node `glow`, key
 * `color.r` — a compound component (§V113) is addressable like any key.
 */
export function parsePresetTargets(text: unknown): PresetTarget[] {
  if (typeof text !== "string") return [];
  return text
    .split(/[\s,]+/)
    .filter((token) => token !== "")
    .map((token): PresetTarget => {
      const dot = token.indexOf(".");
      if (dot <= 0 || dot === token.length - 1) return { token, node: token };
      return { token, node: token.slice(0, dot), key: token.slice(dot + 1) };
    });
}
