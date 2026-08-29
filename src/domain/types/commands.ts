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
  | "projectDelete";

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

export type CommandResult<T extends CommandName> = CommandResultBase & {
  status: "applied" | "rejected" | "conflict";
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
