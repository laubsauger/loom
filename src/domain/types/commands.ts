import type { Revision } from "./ids.ts";
import type { GraphDocument } from "./graph.ts";
import type { GraphPatch, GraphPatchResult } from "./patch.ts";
import type { RuntimeDiagnostic } from "./diagnostics.ts";

export interface Actor {
  kind: "human" | "agent" | "system";
  id: string;
  label?: string;
}

/**
 * Side effects need an explicit grant. Graph edits are free and undoable (§C, §V38).
 * Calling a tool never grants a capability.
 */
export type CapabilityClass =
  | "localFile"
  | "network"
  | "assetUpload"
  | "export"
  | "recording"
  | "componentInstall"
  | "projectDelete"
  /**
   * Moving the camera someone else is looking through (T315, §V38).
   *
   * The odd one out, and deliberately so: every other class here is a side effect that
   * leaves the app — bytes on disk, bytes on a network, pixels handed to a model — which
   * is why graph EDITS are ungated (they are undoable, audited and actor-stamped, and
   * gating them trains a user to approve by reflex). `setViewport` is neither. It edits
   * nothing a user can lose and it is not a side effect; it seizes the viewport of the
   * person at the keyboard, mid-gesture, from another actor. The harm is not to the
   * document, it is to control of the screen, and nothing in the other six classes covers
   * that.
   *
   * The human actor holds this by construction — you control your own camera — so it
   * costs a person nothing and is the one thing an agent must be given.
   */
  | "viewportControl"
  /**
   * SEEING A NAMED OUTPUT AT THE SIZE IT IS ALREADY ON SCREEN (T1220, §V38).
   *
   * `export` and this are two different acts that were gated as one, and the owner is the
   * one who separated them: *"in the end what we want is to be able to pass out SNAPSHOTS
   * of different canvases / node outputs."* Export means FULL-FIDELITY pixels of ARBITRARY
   * content leaving the process — the thing that can be a camera frame at capture
   * resolution, and is rightly guarded. A preview snapshot is a SMALL TILE OF A NAMED
   * OUTPUT, at the size the user is already looking at, in a document the user paired.
   * Same seam, different risk. Gating them as one class did not make the gate strict, it
   * made it the WRONG SHAPE: the mode the owner actually wants — an agent driving the
   * document he is watching — was the one mode where an agent could not see anything at
   * all, and what an agent needs to iterate on a look is not fidelity, it is EYES.
   *
   * ## The bound is the capability, and it is enforced in code
   *
   * `SNAPSHOT_MAX_SIZE` in `@agent/capabilities.ts` is what makes this safe enough to
   * grant, so it is enforced where the pixels are produced (`tools/preview.ts` clamps the
   * request AND refuses an oversized answer) rather than promised in a docstring. An actor
   * holding this and not `export` cannot obtain a full-resolution frame by any input.
   *
   * ## The residual, named rather than waved away
   *
   * A webcam node's preview tile is still a camera frame. This class ALLOWS that and says
   * so — the mitigations are that it is the pixels the user is already seeing, at the size
   * they are already displayed, in a document the user paired — which is bounded, not
   * zero. Refusing snapshots whose upstream reaches a capture node was considered and
   * rejected: it would have to be a node-type denylist (convention, staleable) guarding a
   * tile the user has on screen anyway, while the honest full-fidelity case it is imagined
   * to stop — `read_points`, an unbounded readback, a full-res `maxSize` — is what
   * `export` still refuses. See `@agent/capabilities.ts` for the whole argument.
   */
  | "previewSnapshot";

export interface CapabilityGrant {
  capability: CapabilityClass;
  grantedAt: string;
  expiresAt?: string;
}

export interface InvocationContext {
  actor: Actor;
  projectId: string;
  capabilities: CapabilityGrant[];
  transactionId?: string;
  /** Validate and report without mutating or writing an applied audit entry (§V36). */
  dryRun?: boolean;
}

export interface CommandResultBase {
  revision: Revision;
  diagnostics: RuntimeDiagnostic[];
  undoGroupId?: string;
}

/**
 * Command and query registries. Feature modules extend these by declaration merging,
 * so adapters stay transport-only (§V39).
 */
export interface CommandMap {
  "graph.applyPatch": { input: GraphPatch; output: GraphPatchResult };
}

export interface QueryMap {
  "graph.get": { input: Record<string, never>; output: GraphDocument };
}

export type CommandName = keyof CommandMap;
export type QueryName = keyof QueryMap;

/**
 * Commands that DATA names and no track has registered yet (T77, T127, T365, §V307).
 *
 * The right-click menus and the default keymap are tables of command names, never of
 * handlers (§V52, §V78). Both name commands that do not exist yet, deliberately: a menu
 * item renders DISABLED and the keymap engine reports `unresolved` rather than throwing.
 *
 * What is NOT deliberate is a table naming a command nobody ever intends to build.
 * `mod+,` named `ui.openSettings` from T77 until T359 — the engine skipped the binding in
 * silence and no gate looked, so a shipped keyboard shortcut did nothing at all for
 * months, and it was found by accident. This list is what makes the difference between
 * the two cases WRITTEN DOWN, so a gate can tell them apart.
 *
 * It is ONE list for both tables on purpose: the menus and the keymap name overlapping
 * sets (`graph.diveIn` and `ui.openNodeSearch` were named by both before they were built, and
 * `view.frameAll` and `graph.layoutAll` were too), and two lists would mean promoting one
 * command required remembering two deletions.
 *
 * `composition-seams.test.ts` holds it exact in BOTH directions:
 *
 *  - a binding or menu item naming a command that is in neither `CommandMap` nor here
 *    fails — that is the gate T365 exists for;
 *  - an entry here that IS declared in `CommandMap` fails, so promoting a planned command
 *    is one edit and the gate names the exact line to delete;
 *  - an entry here that no menu and no binding names fails, so the allowlist cannot rot
 *    into a dumping ground.
 *
 * These are deliberately NOT declare-merged into `CommandMap`. Doing that would make
 * `bus.execute("view.frameAll", …)` typecheck against a command that does not exist,
 * which is the silent-skip failure moved one layer up rather than removed.
 */
export type PlannedCommandName =
  | "graph.insertConversion"
  | "graph.rerouteEdge"
  | "node.openColorPalette"
  | "ui.cancel"
  | "ui.openShaderEditor";

export const PLANNED_COMMANDS: readonly PlannedCommandName[] = [
  "graph.insertConversion",
  "graph.rerouteEdge",
  "node.openColorPalette",
  "ui.cancel",
  "ui.openShaderEditor",
];

export type CommandInput<T extends CommandName> = CommandMap[T]["input"];
export type CommandOutput<T extends CommandName> = CommandMap[T]["output"];
export type QueryInput<T extends QueryName> = QueryMap[T]["input"];
export type QueryOutput<T extends QueryName> = QueryMap[T]["output"];

/**
 * `"validated"` is what a `dryRun` invocation answers (§V36, T102): the command was
 * validated and NOTHING happened — no mutation, no audit entry, no minted ids. It is a
 * separate status rather than "applied" because a caller told "applied" for an edit that
 * did not happen caches ids nobody created and builds its next request on them.
 */
export type CommandStatus = "applied" | "validated" | "rejected" | "conflict";

export type CommandResult<T extends CommandName> = CommandResultBase & {
  status: CommandStatus;
  output: CommandOutput<T>;
};

/**
 * The only mutation path. Human UI, tests, and every agent adapter call through it —
 * nothing mutates the store, React Flow arrays, or GPU resources directly (§V29).
 */
export interface AppCommandBus {
  query<TName extends QueryName>(
    name: TName,
    input: QueryInput<TName>,
    context: InvocationContext,
  ): Promise<QueryOutput<TName>>;

  execute<TName extends CommandName>(
    name: TName,
    input: CommandInput<TName>,
    context: InvocationContext,
  ): Promise<CommandResult<TName>>;
}

/** Every mutation writes one of these (§V31). */
export interface AuditEntry {
  revision: Revision;
  timestamp: string;
  actor: Actor;
  command: string;
  undoGroupId?: string;
  status: "applied" | "rejected" | "conflict";
}
