import type { ParentScope } from "../types/components.ts";
import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type { FrameEvaluationInput } from "../types/frame.ts";
import type { GraphNode } from "../types/graph.ts";
import type { ParameterDefinition, ParameterValue } from "../types/parameters.ts";
import { validateParameterValue } from "../parameters/validate.ts";
import { readParentBindings } from "./instance.ts";

/**
 * `parent.<key>` — lexical scope for a node inside a component (§V81, T133).
 *
 * A child reads the published parameters of the component that owns it. That is a
 * LEXICAL relationship, resolved by walking the instance chain outward, and deliberately
 * not a graph edge: an edge would be a data dependency the scheduler has to order, would
 * show up in the canvas as a wire nobody drew, and would let any node read any other
 * node's parameters — which §V81 forbids in as many words.
 *
 * It reaches evaluation through the §V61 seam and nowhere else. `resolveParameters` is
 * the single read path; a driver is the injection point it already declares for exactly
 * this ("expression, curve, audio, MIDI, LINK"). So parent scope is a driver factory,
 * and there is no second place that turns a stored value into an effective one.
 *
 * The binding itself is NOT stored in `node.parameters`. A `number` parameter holding the
 * string `"parent.blur"` would be refused by `validateParameters` on the way in, and
 * rightly — it is not a number. Until the `ParameterValue` envelope lands (§V69, T106) a
 * binding is a link declaration, and it lives in `node.state.parentBindings`.
 */

export const PARENT_PREFIX = "parent.";

export interface ParentReference {
  /** 1 = the owning component, 2 = its owner, and so on. */
  hops: number;
  key: string;
}

/** `"parent.blur"` -> 1 hop; `"parent.parent.gain"` -> 2 hops. Null when not a reference. */
export function parseParentReference(reference: string): ParentReference | null {
  const segments = reference.split(".");
  let hops = 0;
  while (segments[hops] === "parent") hops += 1;
  if (hops === 0) return null;
  const key = segments.slice(hops).join(".");
  if (key === "") return null;
  return { hops, key };
}

export function formatParentReference(reference: ParentReference): string {
  return `${"parent.".repeat(reference.hops)}${reference.key}`;
}

export type ParentLookup =
  | { found: true; value: ParameterValue; scope: ParentScope }
  | { found: false; reason: "no-scope" | "too-deep" | "unknown-key"; message: string };

/** Walks the chain outward. Never returns `undefined` for "missing": it says which kind. */
export function lookupParentScope(
  scope: ParentScope | undefined,
  reference: ParentReference,
): ParentLookup {
  if (scope === undefined) {
    return {
      found: false,
      reason: "no-scope",
      message: `"${formatParentReference(reference)}" was resolved outside any component; there is no parent to read.`,
    };
  }
  let current: ParentScope | undefined = scope;
  for (let hop = 1; hop < reference.hops; hop += 1) {
    current = current?.parent;
  }
  if (current === undefined) {
    return {
      found: false,
      reason: "too-deep",
      message: `"${formatParentReference(reference)}" reaches past the outermost component.`,
    };
  }
  if (!Object.hasOwn(current.parameters, reference.key)) {
    const known = Object.keys(current.parameters).sort();
    return {
      found: false,
      reason: "unknown-key",
      message: `The parent component publishes no parameter "${reference.key}"${
        known.length === 0 ? "" : ` (it publishes ${known.join(", ")})`
      }.`,
    };
  }
  return { found: true, value: current.parameters[reference.key] as ParameterValue, scope: current };
}

/**
 * Builds a scope chain from the published values of an instance chain, OUTERMOST FIRST.
 *
 * The returned scope is the innermost component — the one directly owning the node being
 * evaluated — and `.parent` walks back out, which is what makes `parent.parent.<key>`
 * work at any depth without any per-depth code.
 */
export function buildParentScope(
  chain: ReadonlyArray<Readonly<Record<string, ParameterValue>>>,
): ParentScope | undefined {
  let scope: ParentScope | undefined;
  for (const parameters of chain) {
    scope = { parameters, ...(scope === undefined ? {} : { parent: scope }) };
  }
  return scope;
}

/**
 * Structural twin of the resolver's `ParameterDriver`. Declared here rather than
 * imported so `src/domain/**` never depends on `src/editor/**`; the editor asserts the
 * two are assignable, which is a compile error the day they diverge.
 */
export interface ParentScopeDriverContext {
  node: GraphNode;
  key: string;
  definition: ParameterDefinition;
  frame?: FrameEvaluationInput | undefined;
}

export type ParentScopeDriver = (context: ParentScopeDriverContext) => ParameterValue | undefined;

export interface ParentScopeDriverOptions {
  /**
   * Where an unresolvable binding is REPORTED. Without it a typo in a binding turns into
   * a parameter that silently keeps its old value, which is the worst of the options:
   * the user sees a knob that does nothing and no reason why (§V8, fail loud).
   */
  onDiagnostic?: (diagnostic: RuntimeDiagnostic) => void;
}

/**
 * Drivers for every `parent.<key>` binding declared on `node`.
 *
 * Hand the result to `resolveParameters(node, definition, { drivers })`. A binding that
 * cannot be resolved returns `undefined`, so the resolver falls back to the node's own
 * stored value — the last value the parameter actually had — and a diagnostic explains
 * why the binding is not in effect.
 */
/**
 * The slot-side twin of `parentScopeDrivers` (T203, §V107): resolves a `parent.*` bind
 * REF for the resolver's `bind` mode. Same lookup, same walk, same failure wording —
 * `parent.<key>` written in `state.parentBindings` (legacy) and `parent.<key>` written
 * as a bind slot go through the ONE `lookupParentScope`, so they can never disagree.
 *
 * Structurally matches the resolver's `ParentBindResolver`; declared here so the
 * dependency keeps pointing components → parameters, never back.
 */
export function parentBindResolver(
  scope: ParentScope | undefined,
): (ref: string) => { ok: true; value: ParameterValue } | { ok: false; message: string } {
  return (ref) => {
    const reference = parseParentReference(ref);
    if (reference === null) {
      return { ok: false, message: `"${ref}" is not a parent reference; expected parent.<key> (§V81).` };
    }
    const lookup = lookupParentScope(scope, reference);
    if (!lookup.found) return { ok: false, message: lookup.message };
    return { ok: true, value: lookup.value };
  };
}

export function parentScopeDrivers(
  node: GraphNode,
  scope: ParentScope | undefined,
  options: ParentScopeDriverOptions = {},
): Record<string, ParentScopeDriver> {
  const bindings = readParentBindings(node);
  const drivers: Record<string, ParentScopeDriver> = {};

  for (const [key, raw] of Object.entries(bindings)) {
    const reference = parseParentReference(raw);
    if (reference === null) {
      drivers[key] = () => {
        options.onDiagnostic?.({
          severity: "error",
          code: "component.parentScope.malformed",
          message: `"${raw}" is not a parent reference; expected parent.<key> (§V81).`,
          nodeId: node.id,
        });
        return undefined;
      };
      continue;
    }

    drivers[key] = (context) => {
      const lookup = lookupParentScope(scope, reference);
      if (!lookup.found) {
        options.onDiagnostic?.({
          severity: "error",
          code: `component.parentScope.${lookup.reason}`,
          message: `${context.key} is bound to ${formatParentReference(reference)}: ${lookup.message}`,
          nodeId: node.id,
        });
        return undefined;
      }
      // The parent's published parameter was re-authored independently of this internal
      // one; a type it cannot hold is a real authoring error, not something to coerce.
      const invalid = validateParameterValue(context.key, context.definition, lookup.value, node.id);
      if (invalid !== null) {
        options.onDiagnostic?.({
          ...invalid,
          code: "component.parentScope.type",
          message: `${context.key} is bound to ${formatParentReference(reference)}, which does not fit it: ${invalid.message}`,
        });
        return undefined;
      }
      return lookup.value;
    };
  }

  return drivers;
}
