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
  | "viewportControl";

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
