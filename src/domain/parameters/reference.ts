import { parseExpression } from "../expressions/index.ts";

/**
 * The text form of a parameter reference (T246, §V148, §V127).
 *
 * §V148 is an unusual invariant because it is about a STRING: "copy reference" has to
 * yield something that pastes into an expression and resolves to that same parameter.
 * A format that does not paste back is the whole feature failing silently while producing
 * a plausible-looking result — you copy, you paste, you get a number that came from
 * somewhere else, and nothing anywhere says so.
 *
 * So the format is not invented here. `op('noise1').par.period` is the form the
 * expression grammar already PARSES (`ExpressionAst.opRef`, §V71) and the form
 * `rewriteNodeNameReferences` already rewrites on rename (§V128, T222). Emitting anything
 * else would mean a reference the grammar rejects, or one a rename silently breaks.
 *
 * `parseParameterReference` deliberately round-trips through the real parser rather than
 * a regex: the point of the invariant is that what we write is what the grammar reads,
 * and a regex would be a second opinion about that.
 */

/** `op('noise1').par.period` — the reference to one parameter of one named node. */
export function parameterReference(nodeName: string, parameterKey: string): string {
  return `op('${nodeName}').par.${parameterKey}`;
}

export interface ParsedParameterReference {
  /** The node's NAME (§V127), not its id — a reference survives ids and follows renames. */
  nodeName: string;
  /**
   * The parameter, or one component of it (`color.r`, §V113) — the same key a local bind
   * ref uses, which is what lets a pasted component reference become an ordinary bind
   * when it names the paste target's own node.
   */
  parameterKey: string;
}

/**
 * Reads a reference back, or null when the text is not one.
 *
 * Null covers three different things on purpose: not an expression at all, an expression
 * that is not a bare reference (`op('a').par.x * 2` is a valid expression and not a
 * reference), and a reference to something other than a parameter. A caller that wanted
 * to paste a reference has to be told it did not get one.
 */
export function parseParameterReference(text: string): ParsedParameterReference | null {
  const parsed = parseExpression(text.trim());
  if (!parsed.ok || parsed.ast.kind !== "opRef") return null;
  const [scope, key, component, ...rest] = parsed.ast.path;
  // `.par.<key>`, optionally `.<component>` (§V113/T332), and nothing deeper: `op('a').par`
  // names no parameter, and `op('a').par.x.y.z` names something this model has no meaning
  // for. A component is not validated here — this function has no schema, and the reader
  // reports an unknown channel by name. What matters is that it is RECOGNISED: unparsed,
  // it would fall through to `parseValueText` and paste as a literal string, which is the
  // silent-success failure the module note is about.
  if (scope !== "par" || key === undefined || key === "" || rest.length > 0) return null;
  if (component === "") return null;
  return {
    nodeName: parsed.ast.name,
    parameterKey: component === undefined ? key : `${key}.${component}`,
  };
}
