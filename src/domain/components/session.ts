import type { GraphComponentDefinition } from "../types/components.ts";
import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type { GraphDocument } from "../types/graph.ts";
import type { ComponentId } from "../types/ids.ts";
import type { IdFactory } from "../graph/ids.ts";
import type { GraphStore, GraphStoreState } from "../graph/store.ts";
import { actorKeyOf, createGraphStore } from "../graph/store.ts";
import type { LoomBus } from "../commands/bus.ts";
import type { InstancePath } from "./addressing.ts";
import { createDomainBus } from "../commands/index.ts";
import type { NodeRegistryView } from "../../nodes/registry/registry.ts";
import { pruneComponentDefinition } from "./definition.ts";
import { registerComponentCommands, type ComponentCommandOptions } from "./commands.ts";
import type { ComponentRegistry } from "./registry.ts";

/**
 * Editing the inside of a component (T130).
 *
 * A component's internal network is a `GraphDocument`, and the thing that edits a
 * `GraphDocument` correctly already exists: a `GraphStore` behind a command bus. So
 * entering a component opens one of those over the definition's internal graph, and every
 * command the editor already has — add node, connect, set parameters, undo, redo, the
 * audit log — works inside a component with no second implementation and no second set of
 * invariants to keep in step (§V29, §V32, §V34).
 *
 * That is also what makes §V80 real rather than aspirational: turning a published knob
 * inside a component is `graph.applyPatch` with N `setParameters` operations, which the
 * store already guarantees is atomic and one undo group.
 *
 * Every committed change is written back into the catalogue, so a fix reaches every
 * linked instance immediately (§V79). Nesting needs nothing extra: a component inside a
 * component is entered by opening a session on it in turn.
 *
 * ## A write from OUTSIDE the session (§T1540b)
 *
 * The catalogue has other writers: a Store or Delete on a look instance writes its page
 * bank into this definition from the root bus, `preset.moveIntoComponent` adds a bank, an
 * import replaces the definition. The session's store still holds the graph it last
 * wrote, so its next commit — even an unrelated rename, even an undo — would register
 * that stale graph and silently drop the outside write.
 *
 * The session therefore tracks the graph it last synced with the catalogue. When the
 * catalogue's graph moves away from it, the session is STALE: it says so once through
 * `onStale` (`component.session.stale`), and from then on it refuses to write back — the
 * same refusal, by name. It does not merge in place: a `GraphStore` cannot adopt a graph
 * (no `replaceGraph`, and an `addNode` patch cannot reproduce the outside write's ids),
 * and its undo history holds entity states from before the write, so undoing across it
 * would drop the write too. The holder reopens a session over the new definition instead
 * (`use-component-editing.ts`) — the rebase. Nothing is lost there: every valid session
 * edit has already been committed by the time anything else can write, so the session
 * holds nothing the new definition lacks; what restarts is its undo history.
 *
 * ## Undo restores the definition too (§T1545b)
 *
 * The session's store holds the GRAPH; the rest of the definition — exposed ports, the
 * published page and its targets — lives only in the catalogue, and a graph step can change
 * it: the write-back prune drops a target or an exposure whose node is gone, and an
 * in-session `component.detach` moves the outer page's targets and exposures onto the
 * copies. Undoing the graph step alone brought the node back with its targets and exposures
 * still gone (a detach undone left the page aimed at copies that no longer exist, and the
 * prune then dropped them). So the session records, per undo step, the definition before and
 * after it — `before` when the step is pushed, `after` once it is written back and again
 * when the command that made it re-registers the definition in the same step
 * (`onDefinitionStep`) — and an undo or redo of that step puts the recorded side back,
 * field by field, for every field that still holds what the step left.
 *
 * A definition-only command (publish, unpublish, expose, unexpose, reorder) changes no
 * graph, so it makes its step with `context.applyStep` (§T1546b) — a revision, an audit
 * entry and a slot in the actor's history with no entity in it — and registers the edited
 * definition inside that step, which pairs before/after with it through `onDefinitionStep`
 * the same way. Undo and redo of that step move no graph entity; the revision bump is the
 * commit this listener reads, and the recorded side is put back like any other.
 *
 * ## The session's bus has a parent (§T1695b)
 *
 * This bus holds the commands that edit a graph, pointed at the definition. Everything else
 * a person can do while standing inside a component (reset a feedback loop, play, save,
 * open help) is the project's, and the session's bus answers it through `parent`, by what
 * each command declared (`InSession`, `commands/bus.ts`). A command about a running
 * instance reaches the instance named by `instancePath`: the one the editor dived through.
 * Without a parent the bus is what it was before, an island, which is what a build script
 * with no project wants.
 */

export interface ComponentSession {
  componentId: ComponentId;
  version: number;
  bus: LoomBus;
  store: GraphStore;
  /** Stops syncing. The definition keeps whatever was last committed. */
  dispose: () => void;
}

export interface ComponentSessionOptions {
  components: ComponentRegistry;
  /** The COMPONENT-AWARE node registry, so nested components resolve inside. */
  nodes: NodeRegistryView;
  componentId: ComponentId;
  version: number;
  ids?: IdFactory;
  /**
   * Called when an edit leaves the definition in a state the catalogue refuses — in
   * practice only recursion, since dangling exposures are pruned. The edit stays in the
   * session; the definition keeps its last valid graph, and the user is told (§V83).
   */
  onInvalid?: (diagnostics: readonly RuntimeDiagnostic[]) => void;
  /**
   * §T1540b: the definition was changed by something other than this session. Called once,
   * on the outside write; every later commit of this session is refused. The holder should
   * reopen a session over the current definition.
   */
  onStale?: (diagnostic: RuntimeDiagnostic) => void;
  /**
   * §T1545b: the project document, read-only — so an in-session detach can name the root
   * instances whose paths into the detached instance it leaves dangling. The session never
   * writes it: it is another store, with its own undo history.
   */
  root?: () => GraphDocument;
  /** §T1695b: the project's bus, which this session's bus inherits the app's and the instance's commands from. */
  parent?: LoomBus;
  /**
   * §T1695b: the instance the editor is viewing this definition through (the editor's path,
   * innermost last), read at each call. Absent, or returning undefined: no instance is in
   * view, and a command about a running instance refuses by name.
   */
  instancePath?: () => InstancePath | undefined;
  /**
   * §T1695b: the composition root's own commands that edit a GRAPH (`"definition"`), which
   * therefore belong on every document bus and not on the project's alone. Called once, with
   * this session's bus.
   */
  registerDocumentCommands?: (bus: LoomBus) => void;
  /**
   * §T1696b: the host's file picker, for `component.import` asked with no file in hand. A
   * session's copy of the command had none, so "Import component…" inside a component
   * refused where the same row at the root opened the picker.
   */
  files?: Pick<ComponentCommandOptions, "readFile" | "retainsPickedFiles">;
}

export const COMPONENT_SESSION_STALE_CODE = "component.session.stale";

export function openComponentSession(options: ComponentSessionOptions): ComponentSession {
  const definition = options.components.get(options.componentId, options.version);
  if (definition === undefined) {
    throw new Error(
      `Cannot edit component "${options.componentId}" version ${options.version}: it is not installed.`,
    );
  }

  const store = createGraphStore({
    initialGraph: definition.graph,
    ...(options.ids === undefined ? {} : { ids: options.ids }),
  });
  const { bus } = createDomainBus({
    store,
    registry: options.nodes,
    referenceHost: { componentId: options.componentId, version: options.version },
    ...(options.parent === undefined
      ? {}
      : {
          parent: options.parent,
          scope: {
            subject: () => `component "${options.components.get(options.componentId, options.version)?.name ?? definition.name}"`,
            instancePath: () => options.instancePath?.(),
          },
        }),
  });

  // T1545b: the definition around each undo step (see "Undo restores the definition too").
  const steps = new Map<string, DefinitionStep>();
  let lastPush: { readonly id: string; readonly before: DefinitionShell } | undefined;
  const registered = (): GraphComponentDefinition | undefined => options.components.get(options.componentId, options.version);
  const record = (id: string, before: DefinitionShell): void => {
    const now = registered();
    if (now === undefined) return;
    const after = shellOf(now);
    if (sameShell(before, after)) steps.delete(id);
    else steps.set(id, { before, after });
  };

  // A coalesced push (a drag) keeps the definition from where the step began.
  const startOf = (id: string, coalesced: boolean, shell: DefinitionShell): DefinitionShell =>
    coalesced ? (steps.get(id)?.before ?? (lastPush?.id === id ? lastPush.before : shell)) : shell;

  registerComponentCommands(bus, {
    components: options.components,
    host: { componentId: options.componentId, version: options.version },
    onDefinitionStep: (undoGroupId) => {
      if (lastPush?.id === undoGroupId) record(undoGroupId, lastPush.before);
    },
    ...(options.root === undefined ? {} : { rootGraph: options.root }),
    ...(options.files ?? {}),
  });
  options.registerDocumentCommands?.(bus);

  // The definition graph this session and the catalogue last agreed on. Identity is the
  // test: every writer registers a new graph object, and nothing else replaces it.
  let synced = definition.graph;
  let stale = false;
  const outsideWrite = `Component "${definition.name}" was changed outside this editor (a preset stored on an instance, a move, an import)`;
  const markStale = (): void => {
    if (stale) return;
    stale = true;
    options.onStale?.({
      severity: "warning",
      code: COMPONENT_SESSION_STALE_CODE,
      message: `${outsideWrite}.`,
      suggestion: "Reopen the component to edit the current definition; its undo history starts again there.",
    });
  };

  const unsubscribeCatalogue = options.components.subscribe(() => {
    const current = options.components.get(options.componentId, options.version);
    if (current !== undefined && current.graph !== synced) markStale();
  });

  const unsubscribe = store.view.subscribe((state, previous) => {
    if (state.graph === previous.graph) return;
    const current = options.components.get(options.componentId, options.version);
    if (current === undefined) return;
    // The backstop: never register a graph built on a definition that has moved on.
    if (stale || current.graph !== synced) {
      markStale();
      options.onInvalid?.([
        {
          severity: "error",
          code: COMPONENT_SESSION_STALE_CODE,
          message: `${outsideWrite}, so this edit was not written over it.`,
          suggestion: "Reopen the component and make the edit again on the current definition.",
        },
      ]);
      return;
    }
    // T1545b: which step this commit is, and the definition around it.
    const step = historyStep(state, previous);
    const shell = shellOf(current);
    // §T1546b: a step with no graph entity in it (a definition-only edit, its undo or redo)
    // moves only the store's revision. The definition keeps its graph object, so nothing
    // keyed on it sees a change and a saved component's graph does not churn its revision.
    // T1821b: a moved tie is a graph edit too — it is saved in the definition's graph.
    const graphMoved = state.graph.nodes !== previous.graph.nodes || state.graph.edges !== previous.graph.edges || state.graph.groups !== previous.graph.groups || state.graph.ties !== previous.graph.ties;
    if (!graphMoved && step.direction === "push") {
      // Nothing to write back: the command registers the edit itself, inside this step.
      if (step.id !== undefined) lastPush = { id: step.id, before: startOf(step.id, step.coalesced, shell) };
      if (steps.size > MAX_STEPS) forgetEvicted(steps, state);
      return;
    }
    let restored: DefinitionShell = shell;
    if (step.direction !== "push") {
      const recorded = step.id === undefined ? undefined : steps.get(step.id);
      if (recorded !== undefined) {
        restored = step.direction === "undo" ? rewind(shell, recorded.after, recorded.before) : rewind(shell, recorded.before, recorded.after);
      }
    }
    const next = pruneComponentDefinition({ ...current, ...restored, graph: graphMoved ? state.graph : current.graph }, options.nodes, options.components);
    const problems = options.components.validate(next);
    if (problems.some((diagnostic) => diagnostic.severity === "error")) {
      options.onInvalid?.(problems);
      return;
    }
    // Before `register`, whose notification re-enters the catalogue listener above.
    const before = synced;
    synced = next.graph;
    try {
      options.components.register(next);
    } catch (error) {
      synced = before;
      throw error;
    }
    if (step.direction === "push" && step.id !== undefined) {
      const from = startOf(step.id, step.coalesced, shell);
      lastPush = { id: step.id, before: from };
      record(step.id, from);
      if (steps.size > MAX_STEPS) forgetEvicted(steps, state);
    }
  });

  return {
    componentId: options.componentId,
    version: options.version,
    bus,
    store,
    dispose: () => {
      unsubscribe();
      unsubscribeCatalogue();
    },
  };
}

/** A definition without its graph: the exposures and the page a session step can change. */
type DefinitionShell = Omit<GraphComponentDefinition, "graph">;

/** T1545b: the definition just before and just after one undo step, when they differ. */
interface DefinitionStep {
  readonly before: DefinitionShell;
  readonly after: DefinitionShell;
}

const MAX_STEPS = 256;

function shellOf(definition: GraphComponentDefinition): DefinitionShell {
  const { graph: _graph, ...shell } = definition;
  void _graph;
  return shell;
}

function sameShell(a: DefinitionShell, b: DefinitionShell): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * `current`, with every field that still holds what the step left (`from`) put back to what
 * the step started from (`to`). A field something else has changed since — a publish, which
 * has no undo step of its own — is kept as it is now.
 */
function rewind(current: DefinitionShell, from: DefinitionShell, to: DefinitionShell): DefinitionShell {
  const next: Record<string, unknown> = { ...current };
  const fields = new Set([...Object.keys(from), ...Object.keys(to)]);
  for (const field of fields) {
    const now = (current as Record<string, unknown>)[field];
    if (JSON.stringify(now) !== JSON.stringify((from as Record<string, unknown>)[field])) continue;
    const wanted = (to as Record<string, unknown>)[field];
    if (wanted === undefined) delete next[field];
    else next[field] = wanted;
  }
  return next as unknown as DefinitionShell;
}

/**
 * Which undo step the commit that produced `state` is, and how: read off the store's own
 * record of it (the audit entry it appended and the actor's stacks), never inferred from
 * the graph. An undo moves the group from the undo stack's top to the redo stack's; a redo
 * the other way; anything else pushed (or, coalescing, re-pushed) it.
 */
function historyStep(state: GraphStoreState, previous: GraphStoreState): { id: string | undefined; direction: "push" | "undo" | "redo"; coalesced: boolean } {
  const entry = state.audit[state.audit.length - 1];
  if (entry === undefined || entry.revision !== state.graph.revision || entry.undoGroupId === undefined) {
    return { id: undefined, direction: "push", coalesced: false };
  }
  const id = entry.undoGroupId;
  const key = actorKeyOf(entry.actor);
  const top = (stack: readonly { id: string }[] | undefined): string | undefined => stack?.[stack.length - 1]?.id;
  const now = state.history[key];
  const before = previous.history[key];
  if (top(now?.redo) === id && top(before?.undo) === id) return { id, direction: "undo", coalesced: false };
  if (top(now?.undo) === id && top(before?.redo) === id) return { id, direction: "redo", coalesced: false };
  return { id, direction: "push", coalesced: top(before?.undo) === id };
}

/** Drops the steps no actor can undo or redo any more (the store caps its history). */
function forgetEvicted(steps: Map<string, DefinitionStep>, state: GraphStoreState): void {
  const live = new Set<string>();
  for (const history of Object.values(state.history)) {
    for (const group of [...history.undo, ...history.redo]) live.add(group.id);
  }
  for (const id of [...steps.keys()]) if (!live.has(id)) steps.delete(id);
}
