import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import type { GraphNode } from "@domain/types/graph.ts";
import type { NodeDefinition } from "@domain/types/node-definition.ts";
import type {
  ParameterDefinition,
  ParameterSchema,
  ParameterValue,
} from "@domain/types/parameters.ts";
import { valueForDefinition } from "@ui/controls/parameter-value.ts";

/**
 * THE parameter read path (doc §8.2).
 *
 * Nothing in the editor reads `node.parameters[key]` directly. Every effective value —
 * for display, for a control, and later for evaluation — comes through
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
 * Intended to be promoted into `src/domain/parameters` at the wave barrier so the
 * compiler evaluates through the same function; it is written with no React and no DOM
 * so that move is a file move.
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
  /** The value in effect: what a control shows and what evaluation should consume. */
  value: ParameterValue;
  /** The static value in the document, which is what an edit writes back to. */
  stored: ParameterValue | undefined;
  source: ParameterSource;
  /** Convenience for the "this parameter is being driven" affordance. */
  driven: boolean;
}

/**
 * A parameter driver. Not implemented in v1 — this is the seam the deferred features
 * plug into, and having it typed keeps the resolver's shape honest.
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
  /** Per-node driver lookup, keyed by parameter. Empty in v1. */
  drivers?: Readonly<Record<string, ParameterDriver>> | undefined;
  frame?: FrameEvaluationInput | undefined;
}

export interface ResolvedParameters {
  entries: readonly ResolvedParameter[];
  get: (key: string) => ResolvedParameter | undefined;
  /** Effective values only — the shape evaluation wants. */
  values: Readonly<Record<string, ParameterValue>>;
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
      return {
        key,
        definition,
        // A driver's output is still checked against the manifest: a bad driver must
        // not put a value in the graph the schema would have refused.
        value: valueForDefinition(definition, driven),
        stored,
        source: "driven",
        driven: true,
      };
    }
  }

  const value = valueForDefinition(definition, stored);
  const usable = stored !== undefined && value === stored;
  return {
    key,
    definition,
    value,
    stored,
    source: usable ? "static" : "default",
    driven: false,
  };
}

function schemaOf(definition: NodeDefinition | undefined): ParameterSchema {
  return definition?.parameters ?? {};
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
  const entries: ResolvedParameter[] = [];
  const values: Record<string, ParameterValue> = {};

  for (const [key, parameter] of Object.entries(schemaOf(definition))) {
    const resolved = resolveParameter(node, key, parameter, options);
    entries.push(resolved);
    values[key] = resolved.value;
  }

  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  return {
    entries,
    get: (key: string) => byKey.get(key),
    values,
  };
}
