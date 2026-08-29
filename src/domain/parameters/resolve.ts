import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type { FrameEvaluationInput } from "../types/frame.ts";
import type { GraphNode } from "../types/graph.ts";
import type { NodeDefinition } from "../types/node-definition.ts";
import type {
  ParameterDefinition,
  ParameterSchema,
  ParameterValue,
} from "../types/parameters.ts";
import { defaultParameterValue, validateParameterValue } from "./validate.ts";

/**
 * THE parameter read path (doc §8.2, §V61).
 *
 * Nothing reads `node.parameters[key]` to work out what a parameter is worth. Every
 * effective value — for a control, for a diagnostic, and for evaluation — comes through
 * `resolveParameters`. In v1 that is a passthrough of the stored static value with a
 * manifest-default fallback, and it is supposed to look trivial.
 *
 * The reason it exists now is what §8.2 defers but tells us to design for: keyframes,
 * expressions, MIDI/OSC mapping, audio-reactive modulation and parameter linking. In
 * TouchDesigner terms, anything can drive any parameter. The day a parameter can be
 * *driven*, the difference between "the value stored in the document" and "the value in
 * effect this frame" becomes real. If that distinction has to be introduced across
 * every reader in the codebase it never lands; introduced here, a driver source is one
 * new branch in one function, and every control already renders the effective value and
 * already knows whether it is showing a driven one.
 *
 * The `stored` value is kept alongside, because an editor writes to the static value
 * even while a driver overrides what is displayed.
 *
 * ## Why this module is in `src/domain/`, and headless (T168, B8)
 *
 * It used to live in `src/editor/inspector/`, with the compiler keeping a second copy
 * that resolved values its own way. The two drifted — the display→linear colour decode
 * landed in the editor's copy only, so the inspector showed the fix and the GPU did not
 * (B8). §V61 exists precisely to stop that, and one read path only holds if the path is
 * somewhere BOTH callers can reach: the compiler runs in Node (and must stay
 * worker-ready, §V63), the inspector runs in a browser. So: no React, no DOM, no
 * `src/ui` and no `src/editor` imports from this file, ever.
 */

export type ParameterSource =
  /** The document holds a usable value. */
  | "static"
  /** The document has no value (or one the manifest rejects); the default is in effect. */
  | "default"
  /** A driver (keyframe, expression, MIDI, audio, link) supplied the value. */
  | "driven";

export interface ResolvedParameter {
  key: string;
  definition: ParameterDefinition;
  /**
   * The value in effect: what a control shows and edits. For most parameter types this
   * is also what evaluation should consume — but a `color` declared `space: "display"`
   * stays display-encoded here (T148): decoding it would make the picker appear to
   * drift its own number every round trip. Evaluation reads the decoded number from
   * `ResolvedParameters.values` instead.
   */
  value: ParameterValue;
  /** The static value in the document, which is what an edit writes back to. */
  stored: ParameterValue | undefined;
  source: ParameterSource;
  /** Convenience for the "this parameter is being driven" affordance. */
  driven: boolean;
  /**
   * Why the value in effect is not the one the document (or the driver) supplied — the
   * manifest refused it and the default is standing in. Null when nothing was rejected.
   *
   * Validation lives HERE rather than compiler-side because validation is what DECIDES
   * the value: reject and you get the default, accept and you get the stored number. Two
   * callers that validate differently resolve differently, which is B8 with a different
   * parameter type. The compiler forwards these into its diagnostics; the inspector is
   * free to ignore them.
   */
  diagnostic: RuntimeDiagnostic | null;
}

/**
 * A parameter driver. Not implemented in v1 for keyframes/expressions/audio — but
 * `parent.<key>` (§V81) already arrives this way, which is what the seam was for.
 */
export interface ParameterDriverContext {
  node: GraphNode;
  key: string;
  definition: ParameterDefinition;
  /** Absent when resolving for display outside a frame (§V44: never a wall clock). */
  frame?: FrameEvaluationInput | undefined;
}

export type ParameterDriver = (context: ParameterDriverContext) => ParameterValue | undefined;

export interface ResolveParametersOptions {
  /** Per-node driver lookup, keyed by parameter. */
  drivers?: Readonly<Record<string, ParameterDriver>> | undefined;
  frame?: FrameEvaluationInput | undefined;
}

export interface ResolvedParameters {
  entries: readonly ResolvedParameter[];
  get: (key: string) => ResolvedParameter | undefined;
  /**
   * Effective values only — the shape evaluation wants. Unlike `entries[].value`, a
   * `color` parameter here is decoded to linear when its manifest says `space:
   * "display"` (T148, §V56): this is the read path evaluation is meant to use, so the
   * decode belongs here rather than in each shader that would otherwise redo it.
   */
  values: Readonly<Record<string, ParameterValue>>;
  /** Every rejected value, in manifest order. Empty when the document is clean. */
  diagnostics: readonly RuntimeDiagnostic[];
}

const clamp01 = (channel: number): number =>
  Number.isFinite(channel) ? Math.min(1, Math.max(0, channel)) : 0;

/**
 * sRGB electro-optical transfer function: a display-encoded channel → linear light.
 *
 * The same curve `src/ui/controls/color.ts` uses for the swatch, but this is the
 * evaluation side and it may not import from the UI layer (see the module note above).
 */
export function srgbToLinear(channel: number): number {
  const c = clamp01(channel);
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/**
 * The value evaluation should consume (T148, §V56, §V61, B8).
 *
 * A `color` parameter declared `space: "display"` holds a number that came straight out
 * of a colour picker — sRGB-encoded — while the project's working space is linear
 * (§V56). `resolveParameters` is the sole eval read path, so this is the one place that
 * decode belongs: fixed here, every picker-driven node (solid, ramp, checker, circle,
 * ...) is correct in the inspector AND in the plan, instead of each in-shader curve
 * doing its own slightly different conversion. A `space: "linear"` colour is already in
 * the working space and passes through untouched, and alpha is never touched either way
 * — it is coverage, not light, and encoding it would make 50% opacity read as a
 * different value than the one composed.
 *
 * This is deliberately NOT applied to `ResolvedParameter.value`: that value is what a
 * control displays and edits, and it must stay in the space the user picked (display),
 * or the colour picker would appear to drift its own number every time it round-trips
 * through the document. `values` is the separate "what evaluation wants" shape, so the
 * boundary is: decode happens only when values leaves the resolver as bulk evaluation
 * input, never on the per-entry value the inspector renders.
 */
function evaluationValue(definition: ParameterDefinition, value: ParameterValue): ParameterValue {
  if (definition.type !== "color" || definition.space !== "display") return value;
  if (!Array.isArray(value) || value.length !== 4) return value;
  const channel = (index: number, fallback: number): number => {
    const entry: unknown = value[index];
    return typeof entry === "number" && Number.isFinite(entry) ? entry : fallback;
  };
  return [
    srgbToLinear(channel(0, 0)),
    srgbToLinear(channel(1, 0)),
    srgbToLinear(channel(2, 0)),
    channel(3, 1),
  ];
}

interface Checked {
  value: ParameterValue;
  diagnostic: RuntimeDiagnostic | null;
}

/**
 * A candidate value checked against the manifest. The document can legitimately
 * disagree with it — an older project, an unknown-node placeholder (§V10), an agent
 * patch built against a stale schema — and the answer is always the default plus a
 * report, never a silent coercion of the value the user can see.
 */
function checkAgainstManifest(
  key: string,
  definition: ParameterDefinition,
  value: ParameterValue,
  node: GraphNode,
): Checked {
  const diagnostic = validateParameterValue(key, definition, value, node.id);
  if (diagnostic === null) return { value, diagnostic: null };
  return { value: defaultParameterValue(definition), diagnostic };
}

export function resolveParameter(
  node: GraphNode,
  key: string,
  definition: ParameterDefinition,
  options: ResolveParametersOptions = {},
): ResolvedParameter {
  const stored = node.parameters[key];
  const driver = options.drivers?.[key];

  if (driver !== undefined) {
    const driven = driver({
      node,
      key,
      definition,
      frame: options.frame,
    });
    if (driven !== undefined) {
      // A driver's output is still checked against the manifest: a bad driver must not
      // put a value in the graph the schema would have refused.
      const checked = checkAgainstManifest(key, definition, driven, node);
      return {
        key,
        definition,
        value: checked.value,
        stored,
        source: "driven",
        driven: true,
        diagnostic: checked.diagnostic,
      };
    }
  }

  if (stored === undefined) {
    return {
      key,
      definition,
      value: defaultParameterValue(definition),
      stored,
      source: "default",
      driven: false,
      diagnostic: null,
    };
  }

  const checked = checkAgainstManifest(key, definition, stored, node);
  return {
    key,
    definition,
    value: checked.value,
    stored,
    source: checked.diagnostic === null ? "static" : "default",
    driven: false,
    diagnostic: checked.diagnostic,
  };
}

/**
 * Effective parameters for a bare schema, in manifest order.
 *
 * Takes a `ParameterSchema` rather than a `NodeDefinition` because a component
 * instance's parameter page is the component's PUBLISHED definitions, which exist
 * before any node manifest does (§V80) — and one resolver is the point.
 */
export function resolveParameterSchema(
  node: GraphNode,
  schema: ParameterSchema,
  options: ResolveParametersOptions = {},
): ResolvedParameters {
  const entries: ResolvedParameter[] = [];
  const values: Record<string, ParameterValue> = {};
  const diagnostics: RuntimeDiagnostic[] = [];

  for (const [key, parameter] of Object.entries(schema)) {
    const resolved = resolveParameter(node, key, parameter, options);
    entries.push(resolved);
    values[key] = evaluationValue(parameter, resolved.value);
    if (resolved.diagnostic !== null) diagnostics.push(resolved.diagnostic);
  }

  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  return {
    entries,
    get: (key: string) => byKey.get(key),
    values,
    diagnostics,
  };
}

/**
 * Effective parameters of a node, in manifest order. An unknown node type (§V10
 * placeholder) resolves to nothing rather than guessing a schema.
 */
export function resolveParameters(
  node: GraphNode,
  definition: NodeDefinition | undefined,
  options: ResolveParametersOptions = {},
): ResolvedParameters {
  return resolveParameterSchema(node, definition?.parameters ?? {}, options);
}
