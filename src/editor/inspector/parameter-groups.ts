import type { ResolvedParameter } from "./parameter-resolver.ts";

/**
 * Parameter grouping for the inspector (T38).
 *
 * `ParameterBase.group` is the only grouping input, and manifest order is the only
 * ordering input: a node author who lists parameters in a deliberate order gets that
 * order in the UI, and never an alphabetised one. Groups appear in the order their
 * first member appears, so a definition's shape carries through unchanged.
 */

/** Group name used for parameters that declare none. */
export const DEFAULT_GROUP = "Parameters";

export interface ParameterGroup {
  name: string;
  entries: readonly ResolvedParameter[];
}

export function groupParameters(entries: readonly ResolvedParameter[]): ParameterGroup[] {
  const groups = new Map<string, ResolvedParameter[]>();
  for (const entry of entries) {
    const name = entry.definition.group ?? DEFAULT_GROUP;
    const bucket = groups.get(name);
    if (bucket === undefined) groups.set(name, [entry]);
    else bucket.push(entry);
  }
  return [...groups.entries()].map(([name, members]) => ({ name, entries: members }));
}
