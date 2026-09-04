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
 *     arrives only from whoever owns `bus.grants` — the composition root.
 *
 *     T1097: this sentence used to name "the human confirm flow", which has never been
 *     built (T90's unbuilt half). Today the only issuers are `serve.ts` under
 *     `--grant-export` and `app-runtime.ts` handing the human `viewportControl`, so in a
 *     browser tab all four gated tools — `render_preview`, `describe_output`,
 *     `read_points`, `save_project` — are refused permanently. That is a real
 *     product gap, not a rule — and until it closes, the surface says so out loud rather
 *     than pointing at a prompt nobody sends (see `grantRoutes` in `surface.ts`).
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
 *
 * ## Two places declare a gate, and this one was incomplete (T1115, T1146)
 *
 * Every gated tool ALSO declares `capabilities` on its own definition, and the surface
 * unions the two (`ungrantedFor` in `surface.ts`), so behaviour never depended on this
 * table being complete — and it was not: `describe_output` declared `export` inline only,
 * so this exported table, whose docblock calls itself "the capability gate table", named
 * three of the four gated tools. Harmless to the running product, wrong to every reader.
 * Listed here now; collapsing the two declarations into one is a contract change and is
 * filed rather than done.
 */
export const TOOL_CAPABILITIES: Readonly<Record<string, readonly CapabilityClass[]>> = Object.freeze({
  render_preview: Object.freeze(["export"] as const),
  describe_output: Object.freeze(["export"] as const),
  read_points: Object.freeze(["export"] as const),
  save_project: Object.freeze(["localFile"] as const),
});

export function capabilitiesForTool(tool: string): readonly CapabilityClass[] {
  return TOOL_CAPABILITIES[tool] ?? [];
}
