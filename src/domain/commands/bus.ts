import type {
  Actor,
  AppCommandBus,
  CapabilityClass,
  CommandInput,
  CommandName,
  CommandOutput,
  CommandResult,
  CommandStatus,
  InvocationContext,
  QueryInput,
  QueryName,
  QueryOutput,
} from "../types/commands.ts";
import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type { GraphDocument, ProjectSettings } from "../types/graph.ts";
import type { ChannelResolver } from "../parameters/resolve.ts";
import type { Revision } from "../types/ids.ts";
import type { IdFactory } from "../graph/ids.ts";
import type { GraphStore, GraphStoreView, HistoryOutcome } from "../graph/store.ts";
import { createCapabilityGrantStore, type CapabilityGrantStore } from "./grants.ts";
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

export interface ApplySettingsRequest {
  /** Human-readable label for the undo entry, TD-style: "Set frame rate" (§V177). */
  label: string;
  /** A PARTIAL patch — absent fields keep their current value (T272). */
  patch: Partial<ProjectSettings>;
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
  /**
   * Whether the INVOKING actor holds a capability (T315, §V38).
   *
   * Bound to `actor`, so a handler can ask what the caller may do and cannot ask about
   * anyone else. Deliberately not the grant store itself: a handler must be able to READ
   * an authorization and must never be able to write one — "calling a tool never grants a
   * capability" is only structural if the granting API is out of reach here.
   *
   * `requiredCapabilities` on the registration covers a command that is wholly gated.
   * This exists for the case it cannot express: `graph.applyPatch` carries a batch of
   * mixed operations (§V32) and exactly one of them, `setViewport`, needs a grant — a
   * command-level requirement would gate every graph edit there is, which §V38 explicitly
   * does not want.
   */
  readonly holds: (capability: CapabilityClass) => boolean;
  /**
   * THE channel resolver the running app is resolving `driven` parameters through, or
   * `undefined` when no app is attached (T593, B121, B8, §V61, §V109).
   *
   * ## Why it arrives here rather than being built here
   *
   * A command that wanted channels could call `graphChannelResolver(graph, registry)` for
   * itself — it has both. That is precisely the move B8 forbids. The app's resolver is a
   * LADDER (`use-graph-compile.ts`): an Analyze's readback, then the value graph's CPU
   * signal chain, then the graph shorthand as the backstop. A rebuild inside the domain
   * would answer for the LFO/Constant/Timer trio and for nothing else, so
   * `mouse1 → lag1 → param` and `constant1 → math1 → param` would resolve one way for the
   * compiler and another way for the validator, on the same document, in the same tab.
   * `use-graph-compile.ts:50` states the rule this field exists to keep: THE TWO MUST NOT
   * BE TWO RESOLVERS.
   *
   * So it is the same object the plan was compiled from, published by whoever owns it
   * (`attachChannelResolver`) and read per invocation, never a merge of the same inputs.
   *
   * FRAMELESS on this side. A command is asked outside any frame, and the app's resolver
   * answers a no-frame read from a throwaway zero-frame session keyed on the document
   * revision — so validating cannot advance a stateful stage (a Lag must not move because
   * an agent asked whether the graph is valid).
   *
   * UNDEFINED IS A REAL ANSWER, and it means "no app": a headless bus, a test, an
   * out-of-process caller. §V338 — a consumer must report that as itself and never as
   * "the channel is not attached", which is a claim about the DOCUMENT.
   */
  readonly channels: ChannelResolver | undefined;
  /** The sole mutation primitive available to a handler (§V29). */
  apply: (request: ApplyRequest) => AppliedInfo;
  /**
   * The settings mutation primitive (T272, §V177).
   *
   * Separate from `apply` because settings are not a graph entity and a recipe over a
   * `GraphDocument` draft cannot reach them — not because there are two mutation paths.
   * Both land in the same `commit`: one revision, one audit entry, one undo group.
   */
  applySettings: (request: ApplySettingsRequest) => AppliedInfo;
  /**
   * Records an APPLIED audit entry for a mutation that never touches the document
   * (T214, §V31, §V124).
   *
   * `apply` covers everything that edits the graph: it bumps the revision, opens the
   * undo group and writes the audit entry together, because for a document edit those
   * three are one event. A pulse is the case where they come apart — clearing a feedback
   * buffer changes what is on screen and changes nothing in the file, so there is no
   * revision to bump and nothing for undo to restore, and a recipe that mutated nothing
   * would have been recorded as "no change" and left no trace at all.
   *
   * §V31 says every mutation is audited, and "it was not a document edit" is not an
   * exemption — the audit ring is how a user (or an agent reading `graph.audit`) finds
   * out that something reset the loop they were watching.
   *
   * Rejections are NOT this function's business: the bus already writes those from the
   * outcome status, and calling both would log the same failure twice.
   */
  audit: () => void;
  /** Actor-local history, used by the undo/redo commands (§V41). */
  undoLast: () => HistoryOutcome;
  redoLast: () => HistoryOutcome;
}

export interface CommandOutcome<TOutput> {
  /** `"validated"` = a dry run that passed: reported, not applied, not audited (§V36). */
  status: CommandStatus;
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
  /**
   * THE authority on capability grants (T90, §V38). The confirm flow writes here; the
   * bus checks here; adapters cannot reach it through a tool call.
   */
  readonly grants: CapabilityGrantStore;
  registerCommand: <TName extends CommandName>(registration: CommandRegistration<TName>) => void;
  registerQuery: <TName extends QueryName>(registration: QueryRegistration<TName>) => void;
  hasCommand: (name: string) => boolean;
  hasQuery: (name: string) => boolean;
  listCommands: () => readonly string[];
  listQueries: () => readonly string[];
  /**
   * Publishes the composition root's ONE channel resolver into every `CommandContext`
   * (T593, B121). See `CommandContext.channels`.
   *
   * A READ FUNCTION rather than the resolver, for the same reason `attachStateSources`
   * takes one: the app's resolver is re-memoized per document revision, and a source that
   * captured one render's object would hand every later command a stale ladder. Last
   * attach wins — the bus has no unregister and React mounts more than once.
   */
  attachChannelResolver: (read: () => ChannelResolver | undefined) => void;
  /** What is currently attached, for the composition root and its gates. */
  readonly channelResolver: () => ChannelResolver | undefined;
  /** Read-only document access for the UI. Mutation stays behind `execute` (§V29). */
  readonly store: GraphStoreView;
  readonly registry: NodeRegistryView;
}

export interface CommandBusOptions {
  store?: GraphStore;
  registry?: NodeRegistryView;
  /** Bus-owned grant store (T90, §V38). Created empty when not supplied. */
  grants?: CapabilityGrantStore;
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

/**
 * T90 (§V38): grants are read from the BUS-OWNED store, never from the invocation.
 * `InvocationContext.capabilities` still exists in the frozen contract but is advisory —
 * an adapter fabricating it changes nothing, which is what "calling a tool never grants
 * a capability" actually requires.
 */
function missingCapabilities(
  required: readonly CapabilityClass[],
  actor: InvocationContext["actor"],
  grants: CapabilityGrantStore,
): CapabilityClass[] {
  if (required.length === 0) return [];
  return required.filter((capability) => !grants.has(actor, capability));
}

export function createCommandBus(options: CommandBusOptions = {}): ShaderloomBus {
  const store = options.store ?? createGraphStore();
  const registry = options.registry ?? createNodeRegistry().view();
  const grants = options.grants ?? createCapabilityGrantStore();
  const commands = new Map<string, StoredCommand>();
  const queries = new Map<string, StoredQuery>();
  /** T593: null until a composition root attaches one. Null means "no app", not "empty". */
  let readChannels: (() => ChannelResolver | undefined) | null = null;

  const bus: ShaderloomBus = {
    store: store.view,
    registry,
    grants,

    attachChannelResolver(read: () => ChannelResolver | undefined): void {
      readChannels = read;
    },
    channelResolver: () => readChannels?.() ?? undefined,

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

      const missing = missingCapabilities(registration.requiredCapabilities, context.actor, grants);
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
      const missing = missingCapabilities(registration.requiredCapabilities, context.actor, grants);
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
        // T593: read AT INVOCATION, so a handler sees the ladder the app is compiling
        // through right now rather than the one it held when the command registered.
        channels: readChannels?.() ?? undefined,
        holds: (capability: CapabilityClass): boolean => grants.has(context.actor, capability),
        applySettings: (request: ApplySettingsRequest): AppliedInfo =>
          store.internals.applySettings({
            actor: context.actor,
            command: name,
            label: request.label,
            transactionId: context.transactionId,
            splitUndo: request.splitUndo === true,
            dryRun,
            patch: request.patch,
          }),
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
        audit: (): void => {
          // §V36: a dry run reports and records nothing, including this.
          if (dryRun) return;
          store.internals.recordAudit({
            revision: store.view.getRevision(),
            actor: context.actor,
            command: name,
            status: "applied",
          });
        },
        undoLast: () => store.internals.undo(context.actor, name),
        redoLast: () => store.internals.redo(context.actor, name),
      };

      let outcome: CommandOutcome<CommandOutput<TName>>;
      try {
        outcome = (await registration.handler(input, commandContext)) as CommandOutcome<
          CommandOutput<TName>
        >;
      } catch (thrown) {
        // §V31/§V66: a handler that throws must not become an unhandled rejection with
        // no trace in the log. The mutation did not happen, so it is recorded as
        // rejected and reported as a diagnostic — the same shape every other failure
        // has. A command with no `rejectionOutput` cannot be answered (the bus cannot
        // invent a typed result), so it rethrows AFTER the audit entry exists.
        const revision = store.view.getRevision();
        if (!dryRun) {
          store.internals.recordAudit({ revision, actor: context.actor, command: name, status: "rejected" });
        }
        if (registration.rejectionOutput === undefined) throw thrown;
        const diagnostics: RuntimeDiagnostic[] = [
          {
            severity: "error",
            code: "command.failed",
            // The error's TYPE only. Its message may quote untrusted document text (§V37).
            message: `"${name}" failed: ${thrown instanceof Error ? thrown.name : "a non-Error value was thrown"}.`,
            suggestion: "This is a defect in the command, not in the request; nothing was changed.",
          },
        ];
        return {
          status: "rejected",
          revision,
          diagnostics,
          output: registration.rejectionOutput(input, diagnostics, revision) as CommandOutput<TName>,
        };
      }

      const revision = outcome.revision ?? store.view.getRevision();

      // A committed mutation already wrote its audit entry inside the store. What is
      // left is the negative space: rejections and conflicts still have to be visible
      // in the log (§V31). A dry run writes nothing at all (§V36) — including one that
      // answers "validated", which is a report about a mutation that did not happen.
      if (!dryRun && (outcome.status === "rejected" || outcome.status === "conflict")) {
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
