import type {
  Actor,
  AppCommandBus,
  CapabilityClass,
  CommandInput,
  CommandName,
  CommandOutput,
  CommandResult,
  InvocationContext,
  QueryInput,
  QueryName,
  QueryOutput,
} from "../types/commands.ts";
import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type { GraphDocument } from "../types/graph.ts";
import type { Revision } from "../types/ids.ts";
import type { IdFactory } from "../graph/ids.ts";
import type { GraphStore, GraphStoreView, HistoryOutcome } from "../graph/store.ts";
import { createGraphStore } from "../graph/store.ts";
import type { NodeRegistryView } from "../../nodes/registry/registry.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";

/**
 * The application command bus (§I.bus, T50).
 *
 * Every mutation in the product goes through `execute` — toolbar, keybind, inspector
 * edit, drag-connect, tests and every agent adapter alike (§V29). Adapters (WebMCP, an
 * MCP server, the future collab layer) are transport and schema only: they add commands
 * by declaration-merging `CommandMap`, never by forking this interface (§V39).
 *
 * Registering a command from another module:
 *
 * ```ts
 * declare module "@domain/types/commands.ts" {
 *   interface CommandMap {
 *     "node.setOutput": { input: { nodeId: NodeId }; output: { ok: boolean } };
 *   }
 * }
 *
 * bus.registerCommand({
 *   name: "node.setOutput",
 *   handler: (input, ctx) => {
 *     const applied = ctx.apply({ label: "Set output", recipe: (draft) => { ... } });
 *     return { status: "applied", output: { ok: true }, revision: applied.revision };
 *   },
 * });
 * ```
 *
 * A handler never touches the store directly. `ctx.apply` is the only mutation
 * primitive, and it is what stamps the actor, bumps the revision, writes the audit
 * entry and opens the undo group — so §V30, §V31 and §V34 hold for commands nobody has
 * written yet.
 */

export interface ApplyRequest {
  /** Human-readable label for the undo entry and the history UI. */
  label: string;
  recipe: (draft: GraphDocument) => void;
  /** Start a new undo group even inside a transaction (§V34). */
  splitUndo?: boolean;
}

export interface AppliedInfo {
  committed: boolean;
  changed: boolean;
  revision: Revision;
  undoGroupId: string | undefined;
}

export interface CommandContext {
  readonly invocation: InvocationContext;
  readonly actor: Actor;
  /** True when the caller asked for validation only — `apply` will not commit (§V36). */
  readonly dryRun: boolean;
  readonly commandName: string;
  /** Document snapshot taken when the command was invoked. */
  readonly graph: GraphDocument;
  readonly registry: NodeRegistryView;
  readonly store: GraphStoreView;
  readonly ids: IdFactory;
  /** The sole mutation primitive available to a handler (§V29). */
  apply: (request: ApplyRequest) => AppliedInfo;
  /** Actor-local history, used by the undo/redo commands (§V41). */
  undoLast: () => HistoryOutcome;
  redoLast: () => HistoryOutcome;
}

export interface CommandOutcome<TOutput> {
  status: "applied" | "rejected" | "conflict";
  output: TOutput;
  diagnostics?: RuntimeDiagnostic[];
  /** Defaults to the store revision after the handler ran. */
  revision?: Revision;
  undoGroupId?: string | undefined;
}

export type CommandHandler<TName extends CommandName> = (
  input: CommandInput<TName>,
  context: CommandContext,
) => CommandOutcome<CommandOutput<TName>> | Promise<CommandOutcome<CommandOutput<TName>>>;

export interface CommandRegistration<TName extends CommandName> {
  name: TName;
  handler: CommandHandler<TName>;
  /** Capability classes that must be granted before this command runs (§V38). */
  requiredCapabilities?: readonly CapabilityClass[];
  description?: string;
  /**
   * Builds the output value returned when the bus itself rejects the call (a missing
   * capability grant). Without it the bus throws instead, because it cannot invent a
   * typed result.
   */
  rejectionOutput?: (
    input: CommandInput<TName>,
    diagnostics: RuntimeDiagnostic[],
    revision: Revision,
  ) => CommandOutput<TName>;
}

export type QueryHandler<TName extends QueryName> = (
  input: QueryInput<TName>,
  context: QueryContext,
) => QueryOutput<TName> | Promise<QueryOutput<TName>>;

export interface QueryContext {
  readonly invocation: InvocationContext;
  readonly actor: Actor;
  readonly graph: GraphDocument;
  readonly registry: NodeRegistryView;
  readonly store: GraphStoreView;
}

export interface QueryRegistration<TName extends QueryName> {
  name: TName;
  handler: QueryHandler<TName>;
  requiredCapabilities?: readonly CapabilityClass[];
  description?: string;
}

export class UnknownCommandError extends Error {
  constructor(name: string) {
    super(`No command registered as "${name}".`);
    this.name = "UnknownCommandError";
  }
}

export class UnknownQueryError extends Error {
  constructor(name: string) {
    super(`No query registered as "${name}".`);
    this.name = "UnknownQueryError";
  }
}

export class InvalidInvocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidInvocationError";
  }
}

export class CapabilityDeniedError extends Error {
  readonly missing: readonly CapabilityClass[];

  constructor(name: string, missing: readonly CapabilityClass[]) {
    super(`Command "${name}" requires ungranted capabilities: ${missing.join(", ")}.`);
    this.name = "CapabilityDeniedError";
    this.missing = missing;
  }
}

interface StoredCommand {
  name: string;
  handler: (input: unknown, context: CommandContext) => unknown;
  requiredCapabilities: readonly CapabilityClass[];
  description: string | undefined;
  rejectionOutput:
    | ((input: unknown, diagnostics: RuntimeDiagnostic[], revision: Revision) => unknown)
    | undefined;
}

interface StoredQuery {
  name: string;
  handler: (input: unknown, context: QueryContext) => unknown;
  requiredCapabilities: readonly CapabilityClass[];
  description: string | undefined;
}

export interface ShaderloomBus extends AppCommandBus {
  registerCommand: <TName extends CommandName>(registration: CommandRegistration<TName>) => void;
  registerQuery: <TName extends QueryName>(registration: QueryRegistration<TName>) => void;
  hasCommand: (name: string) => boolean;
  hasQuery: (name: string) => boolean;
  listCommands: () => readonly string[];
  listQueries: () => readonly string[];
  /** Read-only document access for the UI. Mutation stays behind `execute` (§V29). */
  readonly store: GraphStoreView;
  readonly registry: NodeRegistryView;
}

export interface CommandBusOptions {
  store?: GraphStore;
  registry?: NodeRegistryView;
}

function assertContext(context: InvocationContext, name: string): void {
  // §V30: no anonymous mutation — an actor is not optional, and neither is its id.
  if (context.actor === undefined || context.actor === null) {
    throw new InvalidInvocationError(`"${name}" was invoked without an actor (§V30).`);
  }
  if (typeof context.actor.id !== "string" || context.actor.id.trim() === "") {
    throw new InvalidInvocationError(`"${name}" was invoked with an empty actor id (§V30).`);
  }
  if (typeof context.projectId !== "string" || context.projectId.trim() === "") {
    throw new InvalidInvocationError(`"${name}" was invoked without a projectId.`);
  }
}

function missingCapabilities(
  required: readonly CapabilityClass[],
  context: InvocationContext,
  nowMs: number,
): CapabilityClass[] {
  if (required.length === 0) return [];
  const granted = new Set<CapabilityClass>();
  for (const grant of context.capabilities ?? []) {
    if (grant.expiresAt !== undefined && Date.parse(grant.expiresAt) <= nowMs) continue;
    granted.add(grant.capability);
  }
  return required.filter((capability) => !granted.has(capability));
}

export function createCommandBus(options: CommandBusOptions = {}): ShaderloomBus {
  const store = options.store ?? createGraphStore();
  const registry = options.registry ?? createNodeRegistry().view();
  const commands = new Map<string, StoredCommand>();
  const queries = new Map<string, StoredQuery>();

  const bus: ShaderloomBus = {
    store: store.view,
    registry,

    registerCommand<TName extends CommandName>(registration: CommandRegistration<TName>): void {
      if (commands.has(registration.name)) {
        throw new Error(`Command "${registration.name}" is already registered.`);
      }
      commands.set(registration.name, {
        name: registration.name,
        handler: registration.handler as StoredCommand["handler"],
        requiredCapabilities: registration.requiredCapabilities ?? [],
        description: registration.description,
        rejectionOutput: registration.rejectionOutput as StoredCommand["rejectionOutput"],
      });
    },

    registerQuery<TName extends QueryName>(registration: QueryRegistration<TName>): void {
      if (queries.has(registration.name)) {
        throw new Error(`Query "${registration.name}" is already registered.`);
      }
      queries.set(registration.name, {
        name: registration.name,
        handler: registration.handler as StoredQuery["handler"],
        requiredCapabilities: registration.requiredCapabilities ?? [],
        description: registration.description,
      });
    },

    hasCommand: (name: string) => commands.has(name),
    hasQuery: (name: string) => queries.has(name),
    listCommands: () => [...commands.keys()].sort(),
    listQueries: () => [...queries.keys()].sort(),

    async query<TName extends QueryName>(
      name: TName,
      input: QueryInput<TName>,
      context: InvocationContext,
    ): Promise<QueryOutput<TName>> {
      assertContext(context, name);
      const registration = queries.get(name);
      if (registration === undefined) throw new UnknownQueryError(name);

      const missing = missingCapabilities(registration.requiredCapabilities, context, Date.now());
      if (missing.length > 0) throw new CapabilityDeniedError(name, missing);

      const queryContext: QueryContext = {
        invocation: context,
        actor: context.actor,
        graph: store.view.getGraph(),
        registry,
        store: store.view,
      };
      return (await registration.handler(input, queryContext)) as QueryOutput<TName>;
    },

    async execute<TName extends CommandName>(
      name: TName,
      input: CommandInput<TName>,
      context: InvocationContext,
    ): Promise<CommandResult<TName>> {
      assertContext(context, name);
      const registration = commands.get(name);
      if (registration === undefined) throw new UnknownCommandError(name);

      const dryRun = context.dryRun === true;
      const missing = missingCapabilities(registration.requiredCapabilities, context, Date.now());
      if (missing.length > 0) {
        const diagnostics: RuntimeDiagnostic[] = [
          {
            severity: "error",
            code: "capability.denied",
            message: `"${name}" requires the ${missing.join(", ")} capability.`,
            suggestion: "Ask the user to grant it; calling the tool never grants it (§V38).",
          },
        ];
        const revision = store.view.getRevision();
        if (registration.rejectionOutput === undefined) {
          throw new CapabilityDeniedError(name, missing);
        }
        if (!dryRun) {
          store.internals.recordAudit({ revision, actor: context.actor, command: name, status: "rejected" });
        }
        return {
          status: "rejected",
          revision,
          diagnostics,
          output: registration.rejectionOutput(input, diagnostics, revision) as CommandOutput<TName>,
        };
      }

      const commandContext: CommandContext = {
        invocation: context,
        actor: context.actor,
        dryRun,
        commandName: name,
        graph: store.view.getGraph(),
        registry,
        store: store.view,
        ids: store.internals.ids,
        apply: (request: ApplyRequest): AppliedInfo =>
          store.internals.apply({
            actor: context.actor,
            command: name,
            label: request.label,
            transactionId: context.transactionId,
            splitUndo: request.splitUndo === true,
            dryRun,
            recipe: request.recipe,
          }),
        undoLast: () => store.internals.undo(context.actor, name),
        redoLast: () => store.internals.redo(context.actor, name),
      };

      const outcome = (await registration.handler(input, commandContext)) as CommandOutcome<
        CommandOutput<TName>
      >;
      const revision = outcome.revision ?? store.view.getRevision();

      // A committed mutation already wrote its audit entry inside the store. What is
      // left is the negative space: rejections and conflicts still have to be visible
      // in the log (§V31). A dry run writes nothing at all (§V36).
      if (!dryRun && outcome.status !== "applied") {
        store.internals.recordAudit({
          revision,
          actor: context.actor,
          command: name,
          status: outcome.status,
          ...(outcome.undoGroupId === undefined ? {} : { undoGroupId: outcome.undoGroupId }),
        });
      }

      return {
        status: outcome.status,
        revision,
        diagnostics: outcome.diagnostics ?? [],
        output: outcome.output,
        ...(outcome.undoGroupId === undefined ? {} : { undoGroupId: outcome.undoGroupId }),
      };
    },
  };

  return bus;
}
