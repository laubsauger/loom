import type { CapabilityClass } from "@domain/types/commands.ts";

/**
 * The capability gate table (T59, §V38).
 *
 * §V38 names seven classes — local file, network, upload, export, recording, component
 * install, project delete — and one rule: **calling a tool never grants a capability.**
 * That rule is enforced structurally, not by convention:
 *
 *  1. No tool in this surface grants, requests or elevates anything. There is no
 *     `grant_capability` tool and no tool input field that carries a grant. A grant
 *     arrives only through the human confirm flow that owns `bus.grants`.
 *  2. The surface reads grants from `bus.grants` — the BUS-OWNED store keyed by actor
 *     (T90). `InvocationContext.capabilities` is advisory and the bus no longer consults
 *     it, so an adapter that fabricates the array changes nothing.
 *  3. Tool input schemas are `.strict()`: a call carrying an unexpected `capabilities`
 *     key is rejected at the boundary rather than quietly ignored.
 *
 * ## Why graph edits are ungated
 *
 * Every class here is a SIDE EFFECT that leaves the document: bytes on disk, bytes on a
 * network, pixels handed to a model. A graph edit is none of those — it is undoable,
 * audited and actor-stamped, and gating it would train a user to approve edits by reflex
 * and then approve the file write with the same reflex (`src/domain/types/commands.ts`
 * states the same rule at the bus).
 *
 * ## Why `render_preview` needs `export`
 *
 * It is a readback (§V48, §V7) and its result is pixels crossing out of the app to the
 * calling model. That is the export class doing exactly the job it exists for, even
 * though no file is written. `save_project` writes a file, so it needs `localFile`.
 */
export const TOOL_CAPABILITIES: Readonly<Record<string, readonly CapabilityClass[]>> = Object.freeze({
  render_preview: Object.freeze(["export"] as const),
  save_project: Object.freeze(["localFile"] as const),
});

export function capabilitiesForTool(tool: string): readonly CapabilityClass[] {
  return TOOL_CAPABILITIES[tool] ?? [];
}
