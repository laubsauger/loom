import type { Actor, CapabilityClass } from "@domain/types/commands.ts";

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
 *     built (T90's unbuilt half). The issuers are `serve.ts` under `--grant-export`,
 *     `app-runtime.ts` handing the human `viewportControl`, and — since T1220 —
 *     `applyBridgeOperatorConsent` below, which issues `previewSnapshot` in a browser tab
 *     while a bridge the human paired is attached to a helper the human started with
 *     `--grant-export`. T1097 recorded that in a browser tab all four gated tools were
 *     refused PERMANENTLY; two of them (`render_preview`, `describe_output`) now have a
 *     real route, and `read_points` and `save_project` still do not and still say so out
 *     loud rather than pointing at a prompt nobody sends (`grantRoutes` in `surface.ts`).
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
 * ## Why `render_preview` needs `previewSnapshot` and NOT `export` (T1220)
 *
 * It used to need `export`, and the reasoning read: "its result is pixels crossing out of
 * the app to the calling model, which is the export class doing exactly the job it exists
 * for". That is true of the ACT and wrong about the RISK, and the difference is the whole
 * of T1220. Export is full-fidelity pixels of arbitrary content leaving the process — at
 * capture resolution, that is a camera frame. A preview snapshot is a tile of a NAMED
 * output at `SNAPSHOT_MAX_SIZE`, which is the thing already on the user's screen. Gated as
 * one class, the strictness that `export` needs was being spent on a thumbnail, and the
 * result was measured: an agent attached to the owner's live tab could not see anything at
 * all, in the one mode he actually wanted.
 *
 * So the two tools that answer "what does it LOOK like" — `render_preview` and
 * `describe_output` — moved to `previewSnapshot`. `read_points` did NOT: a point buffer is
 * unbounded, full-fidelity content, and it is `export`'s to guard. `describe_output` is
 * here because it is strictly less revealing than the tile beside it (per-channel min, max
 * and mean cannot reconstruct a frame), and putting it above a gate the tile passes would
 * be a wall in front of nothing.
 *
 * **`export` did not move an inch.** It still gates `read_points` and full-resolution
 * readback, it is still issued only by `--grant-export` on an out-of-band invocation, and
 * holding `previewSnapshot` implies nothing about it. The implication runs the other way,
 * once, at a composition root: `serve.ts` issues BOTH when the operator typed
 * `--grant-export`, because a person who allowed full-fidelity pixels has already allowed
 * a thumbnail. That is the grant issuer deciding, which is the only party §V38 permits to.
 *
 * `save_project` writes a file, so it needs `localFile`.
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
  render_preview: Object.freeze(["previewSnapshot"] as const),
  describe_output: Object.freeze(["previewSnapshot"] as const),
  read_points: Object.freeze(["export"] as const),
  save_project: Object.freeze(["localFile"] as const),
});

export function capabilitiesForTool(tool: string): readonly CapabilityClass[] {
  return TOOL_CAPABILITIES[tool] ?? [];
}

/**
 * THE TILE BOUND — the number that makes `previewSnapshot` a smaller ask than `export`.
 *
 * 384px on the longest edge: the top of the preview-tile range the app already draws
 * (192–384), so a snapshot is the pixels the user is looking at, at the size they are
 * displayed. It answers every question the blocked agent actually asked its owner — is it
 * black, does the void follow the cursor the right way, are the filaments blowing out —
 * and it is not a frame of anything.
 *
 * It lives HERE, next to the capability it justifies, and `render_preview` enforces it
 * against the ACTOR'S GRANTS rather than against a flag in its input: an actor holding
 * `previewSnapshot` and not `export` gets the request clamped to it AND an oversized
 * answer refused (a provider that ignores `maxSize` must not become a way through). A
 * bound the caller can raise is not a bound.
 */
export const SNAPSHOT_MAX_SIZE = 384;

/**
 * The one place a browser tab issues `previewSnapshot`, and the whole authority argument
 * for it (T1220, §V38, §V67).
 *
 * ## What §V38 forbids, and what this is not
 *
 * §V38 exists so that **a page cannot grant itself**: a tool call never writes a grant,
 * nothing arriving on a socket writes a grant, and `InvocationContext.capabilities` is
 * advisory precisely so an adapter that fabricates it changes nothing. All of that stays
 * exactly as it is. This function is not called by a tool, is not reachable from a tool
 * input, and writes nothing on its own — it takes a decision that was already made twice,
 * by a person, OUTSIDE the page:
 *
 *  1. the human typed `--grant-export` on the helper's own invocation, out-of-band, in a
 *     terminal the page cannot reach; and
 *  2. the human read a pairing code out of that helper's output and typed it into THIS
 *     tab, choosing which document that helper may drive.
 *
 * Neither is the page granting itself. Both already existed and simply did not COMPOSE:
 * the flag granted `export` in the helper's OWN bus store, for the helper's own headless
 * document, and an attached tab is a different bus — which is why the owner's agent, on a
 * helper started exactly as the README says, read `grantedCapabilities: []` from the tab.
 * Measured: the helper's argv ended in `--grant-export` while the tab reported no grants.
 * Composing the two consents is what this function does, and it is the smaller of the two
 * capabilities that comes out — never `export`.
 *
 * ## Why the wire fact alone cannot grant anything
 *
 * The `snapshots` flag on the bridge's `attached` frame is an ASSERTION by the helper, and
 * it is worth exactly what the pairing code is worth: the peer had to present a code the
 * human read out of that same helper and typed here. It is one of two required conditions,
 * and the other one — a person typing that code into this tab — is a gesture nothing on
 * the socket can perform. A peer that lies about the flag has already had to be handed the
 * document by its owner, and everything it could then do to the graph is strictly larger
 * than a 384px tile.
 *
 * ## The residual, stated so the next reader finds it
 *
 * Grants are keyed by ACTOR, and this tab has one agent actor, so while the bridge is
 * attached an in-page WebMCP agent in the same tab holds `previewSnapshot` too. That is
 * real and it is bounded: the same tile, of the same document, only while a human-paired
 * bridge is attached — `consent: null` on detach revokes it, so a closed helper takes the
 * capability with it. Scoping it per-transport means a second actor per transport, which
 * is a larger change than the one T1220 asked for and is not smuggled in here.
 */
export function applyBridgeOperatorConsent(
  grants: {
    grant(actor: Actor, capability: CapabilityClass): void;
    revoke(actor: Actor, capability: CapabilityClass): void;
  },
  actor: Actor,
  consent: { readonly snapshots: boolean } | null,
): void {
  if (consent?.snapshots === true) grants.grant(actor, "previewSnapshot");
  else grants.revoke(actor, "previewSnapshot");
}
