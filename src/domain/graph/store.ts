import { produce, setAutoFreeze } from "immer";
import { createStore, type StoreApi } from "zustand/vanilla";

import type { Actor, AuditEntry } from "../types/commands.ts";
import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type { EdgeId, GroupId, NodeId, Revision } from "../types/ids.ts";
import type { GraphDocument, GraphEdge, GraphGroup, GraphNode } from "../types/graph.ts";
import { createIdFactory, type IdFactory } from "./ids.ts";

/**
 * The domain graph store (§V1, T10) with the revision counter and audit log (§V31, T52)
 * and actor-local undo groups (§V34, §V41, T53).
 *
 * This module contains zero React and zero DOM: the domain graph is the source of
 * truth, and React Flow is a projection of it, never the other way round (§V1). It runs
 * unchanged in Node for headless tests and offline renders (§V11, §V47).
 *
 * Nothing outside `src/domain/commands` may call `apply`, `undo` or `redo`: the command
 * bus is the only mutation path (§V29). That is why `createGraphStore` returns the
 * mutating half separately from the read-only `view` handed to the UI.
 */

// Frozen state makes an accidental direct mutation throw instead of silently
// desynchronising the document from the audit log (§V29).
setAutoFreeze(true);

export function emptyGraph(): GraphDocument {
  return { revision: 0, nodes: {}, edges: {}, groups: {} };
}

export interface EntityChange<T> {
  before: T | undefined;
  after: T | undefined;
}

/**
 * One undoable unit. Records per-entity before/after rather than whole-document
 * snapshots, so undoing one actor's group cannot roll back entities another actor
 * touched (§V41).
 */
export interface UndoGroup {
  id: string;
  actorKey: string;
  actor: Actor;
  command: string;
  label: string;
  transactionId: string | undefined;
  revisionBefore: Revision;
  revisionAfter: Revision;
  nodes: Record<NodeId, EntityChange<GraphNode>>;
  edges: Record<EdgeId, EntityChange<GraphEdge>>;
  groups: Record<GroupId, EntityChange<GraphGroup>>;
}

export interface ActorHistory {
  undo: UndoGroup[];
  redo: UndoGroup[];
}

interface EntityOwner {
  actorKey: string;
  revision: Revision;
}

export interface GraphStoreState {
  graph: GraphDocument;
  audit: AuditEntry[];
  /** Keyed by actor key: undo is per actor, never global (§V41). */
  history: Record<string, ActorHistory>;
  /** Last writer per entity, used to refuse clobbering another actor's newer edit. */
  owners: Record<string, EntityOwner>;
}

export function actorKeyOf(actor: Actor): string {
  return `${actor.kind}:${actor.id}`;
}

export interface ApplyInput {
  actor: Actor;
  /** Command name recorded in the audit entry (§V31). */
  command: string;
  label?: string;
  /** Mutations sharing a transaction id coalesce into one undo group (§V15, §V34). */
  transactionId?: string | undefined;
  /** Forces a fresh undo group even inside a transaction (§V34 "unless explicitly split"). */
  splitUndo?: boolean;
  /** Validate only: run the recipe against a scratch draft and discard it (§V36). */
  dryRun?: boolean;
  recipe: (draft: GraphDocument) => void;
}

export interface ApplyResult {
  committed: boolean;
  changed: boolean;
  revision: Revision;
  undoGroupId: string | undefined;
}

export interface HistoryOutcome {
  status: "applied" | "rejected";
  revision: Revision;
  undoGroupId: string | undefined;
  diagnostics: RuntimeDiagnostic[];
}

/** Read-only projection. Shaped so `useStore(view, selector)` works from React. */
export interface GraphStoreView {
  getState: () => GraphStoreState;
  getInitialState: () => GraphStoreState;
  subscribe: (listener: (state: GraphStoreState, previous: GraphStoreState) => void) => () => void;
  getGraph: () => GraphDocument;
  getRevision: () => Revision;
  getAudit: () => readonly AuditEntry[];
  getHistory: (actor: Actor) => ActorHistory;
}

/** Mutating half. Held only by the command bus (§V29). */
export interface GraphStoreInternals {
  apply: (input: ApplyInput) => ApplyResult;
  undo: (actor: Actor, command?: string) => HistoryOutcome;
  redo: (actor: Actor, command?: string) => HistoryOutcome;
  /** Records a mutation that did not happen: rejected or conflicting (§V31). */
  recordAudit: (entry: Omit<AuditEntry, "timestamp">) => void;
  ids: IdFactory;
}

export interface GraphStore {
  view: GraphStoreView;
  internals: GraphStoreInternals;
  /** Escape hatch for tests and devtools only — never call from app code. */
  raw: StoreApi<GraphStoreState>;
}

export interface GraphStoreOptions {
  initialGraph?: GraphDocument;
  ids?: IdFactory;
  now?: () => string;
  /** Cap on retained undo groups per actor. */
  historyLimit?: number;
}

function diffRecord<T>(
  before: Readonly<Record<string, T>>,
  after: Readonly<Record<string, T>>,
): Record<string, EntityChange<T>> {
  const changes: Record<string, EntityChange<T>> = {};
  // Sorted so two actors replaying the same edit build identical records (§V40).
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  for (const key of keys) {
    const prior = before[key];
    const next = after[key];
    if (prior !== next) changes[key] = { before: prior, after: next };
  }
  return changes;
}

function mergeChanges<T>(
  target: Record<string, EntityChange<T>>,
  incoming: Record<string, EntityChange<T>>,
): void {
  for (const [key, change] of Object.entries(incoming)) {
    const existing = target[key];
    // Keep the oldest `before` so undoing the coalesced group lands on the value the
    // drag started from, not on the previous intermediate frame (§V15).
    target[key] = existing === undefined ? change : { before: existing.before, after: change.after };
  }
}

export function createGraphStore(options: GraphStoreOptions = {}): GraphStore {
  const ids = options.ids ?? createIdFactory();
  const now = options.now ?? (() => new Date().toISOString());
  const historyLimit = options.historyLimit ?? 200;

  const store = createStore<GraphStoreState>()(() => ({
    graph: options.initialGraph ?? emptyGraph(),
    audit: [],
    history: {},
    owners: {},
  }));

  const historyFor = (state: GraphStoreState, key: string): ActorHistory =>
    state.history[key] ?? { undo: [], redo: [] };

  const ownerKeys = (group: UndoGroup): string[] => [
    ...Object.keys(group.nodes).map((id) => `node:${id}`),
    ...Object.keys(group.edges).map((id) => `edge:${id}`),
    ...Object.keys(group.groups).map((id) => `group:${id}`),
  ];

  function commit(
    nextGraph: GraphDocument,
    changes: {
      nodes: Record<NodeId, EntityChange<GraphNode>>;
      edges: Record<EdgeId, EntityChange<GraphEdge>>;
      groups: Record<GroupId, EntityChange<GraphGroup>>;
    },
    meta: {
      actor: Actor;
      command: string;
      label: string;
      transactionId: string | undefined;
      splitUndo: boolean;
      /** Reuse an existing undo group id (undo/redo re-apply, not a new group). */
      historyMode: "push" | "undo" | "redo";
      group?: UndoGroup;
    },
  ): ApplyResult {
    const state = store.getState();
    const revision = state.graph.revision + 1;
    const graph = produce(nextGraph, (draft) => {
      draft.revision = revision;
    });

    const key = actorKeyOf(meta.actor);
    const history = historyFor(state, key);
    let undoGroupId: string;
    let undoStack = history.undo;
    let redoStack = history.redo;

    if (meta.historyMode === "push") {
      const top = undoStack[undoStack.length - 1];
      const coalesce =
        !meta.splitUndo &&
        meta.transactionId !== undefined &&
        top !== undefined &&
        top.transactionId === meta.transactionId;

      if (coalesce && top !== undefined) {
        const merged: UndoGroup = {
          ...top,
          revisionAfter: revision,
          nodes: { ...top.nodes },
          edges: { ...top.edges },
          groups: { ...top.groups },
        };
        mergeChanges(merged.nodes, changes.nodes);
        mergeChanges(merged.edges, changes.edges);
        mergeChanges(merged.groups, changes.groups);
        undoStack = [...undoStack.slice(0, -1), merged];
        undoGroupId = merged.id;
      } else {
        const group: UndoGroup = {
          id: ids.undoGroup(),
          actorKey: key,
          actor: meta.actor,
          command: meta.command,
          label: meta.label,
          transactionId: meta.transactionId,
          revisionBefore: state.graph.revision,
          revisionAfter: revision,
          nodes: changes.nodes,
          edges: changes.edges,
          groups: changes.groups,
        };
        undoStack = [...undoStack, group].slice(-historyLimit);
        undoGroupId = group.id;
      }
      // A fresh edit invalidates this actor's redo branch.
      redoStack = [];
    } else if (meta.historyMode === "undo") {
      const group = meta.group;
      if (group === undefined) throw new Error("undo commit requires a group");
      undoStack = undoStack.slice(0, -1);
      redoStack = [...redoStack, group];
      undoGroupId = group.id;
    } else {
      const group = meta.group;
      if (group === undefined) throw new Error("redo commit requires a group");
      redoStack = redoStack.slice(0, -1);
      undoStack = [...undoStack, group];
      undoGroupId = group.id;
    }

    const owners: Record<string, EntityOwner> = { ...state.owners };
    const touched = [
      ...Object.keys(changes.nodes).map((id) => `node:${id}`),
      ...Object.keys(changes.edges).map((id) => `edge:${id}`),
      ...Object.keys(changes.groups).map((id) => `group:${id}`),
    ];
    for (const entity of touched) owners[entity] = { actorKey: key, revision };

    const entry: AuditEntry = {
      revision,
      timestamp: now(),
      actor: meta.actor,
      command: meta.command,
      undoGroupId,
      status: "applied",
    };

    store.setState({
      graph,
      audit: [...state.audit, entry],
      history: { ...state.history, [key]: { undo: undoStack, redo: redoStack } },
      owners,
    });

    return { committed: true, changed: true, revision, undoGroupId };
  }

  function apply(input: ApplyInput): ApplyResult {
    if (input.actor.id.trim() === "") {
      // §V30: no anonymous mutation, ever.
      throw new Error("InvocationContext.actor.id is required for every mutation (§V30)");
    }

    const state = store.getState();
    const base = state.graph;
    // If the recipe throws, `produce` discards the draft: nothing is applied (§V32).
    const drafted = produce(base, (draft) => {
      input.recipe(draft as GraphDocument);
      // Revision belongs to the store, not to a command recipe.
      draft.revision = base.revision;
    });

    const changed = drafted !== base;
    if (input.dryRun === true) {
      // §V36: validated against a scratch draft, discarded. No revision, no audit entry.
      return { committed: false, changed, revision: base.revision, undoGroupId: undefined };
    }
    if (!changed) {
      return { committed: false, changed: false, revision: base.revision, undoGroupId: undefined };
    }

    return commit(
      drafted,
      {
        nodes: diffRecord(base.nodes, drafted.nodes),
        edges: diffRecord(base.edges, drafted.edges),
        groups: diffRecord(base.groups, drafted.groups),
      },
      {
        actor: input.actor,
        command: input.command,
        label: input.label ?? input.command,
        transactionId: input.transactionId,
        splitUndo: input.splitUndo === true,
        historyMode: "push",
      },
    );
  }

  function restore(
    group: UndoGroup,
    direction: "undo" | "redo",
    command: string,
  ): HistoryOutcome {
    const state = store.getState();
    const diagnostics: RuntimeDiagnostic[] = [];
    const blocked = new Set<string>();

    const verb = direction === "undo" ? "undoing" : "redoing";

    // §V41: refuse to roll back — or re-apply — an entity another actor has since
    // edited. Redo needs the same guard as undo: after A's blocked undo, the group sits
    // on A's redo stack still carrying B's entity, and re-applying `after` would erase
    // B's newer work.
    for (const entity of ownerKeys(group)) {
      const owner = state.owners[entity];
      if (owner !== undefined && owner.actorKey !== group.actorKey && owner.revision > group.revisionAfter) {
        blocked.add(entity);
        diagnostics.push({
          severity: "warning",
          code: "history.blocked",
          message: `Skipped ${entity} while ${verb}: ${owner.actorKey} changed it more recently.`,
          suggestion: "Ask the other actor to undo their change first.",
        });
      }
    }

    const pick = <T,>(change: EntityChange<T>): T | undefined =>
      direction === "undo" ? change.before : change.after;

    // §V40 also binds restore, not just removeNodes: a restore must never leave an edge
    // pointing at a missing node. Cascading the offending edges is not an option — they
    // may be another actor's work (§V41) — so the deletion is kept back instead.
    for (const [id, change] of Object.entries(group.nodes)) {
      if (blocked.has(`node:${id}`)) continue;
      if (pick(change) !== undefined) continue;
      if (state.graph.nodes[id] === undefined) continue;
      const stranded = Object.values(state.graph.edges).filter((edge) => {
        if (edge.source.nodeId !== id && edge.target.nodeId !== id) return false;
        const edgeChange = group.edges[edge.id];
        const removedByRestore =
          edgeChange !== undefined && !blocked.has(`edge:${edge.id}`) && pick(edgeChange) === undefined;
        return !removedByRestore;
      });
      if (stranded.length > 0) {
        blocked.add(`node:${id}`);
        diagnostics.push({
          severity: "warning",
          code: "history.integrity",
          message: `Kept node ${id} while ${verb}: ${stranded.length} edge(s) outside this history entry still connect to it.`,
          nodeId: id,
          suggestion: "Disconnect those edges first, then retry.",
        });
      }
    }

    // Mirror image: an edge only comes back if both endpoints exist in the restored
    // document (present now and not deleted by this restore, or re-added by it).
    for (const [id, change] of Object.entries(group.edges)) {
      if (blocked.has(`edge:${id}`)) continue;
      const value = pick(change);
      if (value === undefined) continue;
      const missing = [value.source.nodeId, value.target.nodeId].some((nodeId) => {
        const nodeChange = group.nodes[nodeId];
        const present =
          nodeChange !== undefined && !blocked.has(`node:${nodeId}`)
            ? pick(nodeChange) !== undefined
            : state.graph.nodes[nodeId] !== undefined;
        return !present;
      });
      if (missing) {
        blocked.add(`edge:${id}`);
        diagnostics.push({
          severity: "warning",
          code: "history.integrity",
          message: `Skipped edge ${id} while ${verb}: an endpoint node no longer exists.`,
          suggestion: "Restore the missing node first, then retry.",
        });
      }
    }

    const nextGraph = produce(state.graph, (writable) => {
      // The recorded values are whole frozen entities; immer's Draft<> mapping only
      // differs in array mutability, which restoring never relies on.
      const draft = writable as unknown as GraphDocument;
      for (const [id, change] of Object.entries(group.nodes)) {
        if (blocked.has(`node:${id}`)) continue;
        const value = pick(change);
        if (value === undefined) delete draft.nodes[id];
        else draft.nodes[id] = value;
      }
      for (const [id, change] of Object.entries(group.edges)) {
        if (blocked.has(`edge:${id}`)) continue;
        const value = pick(change);
        if (value === undefined) delete draft.edges[id];
        else draft.edges[id] = value;
      }
      for (const [id, change] of Object.entries(group.groups)) {
        if (blocked.has(`group:${id}`)) continue;
        const value = pick(change);
        if (value === undefined) delete draft.groups[id];
        else draft.groups[id] = value;
      }
    });

    const changes = {
      nodes: diffRecord(state.graph.nodes, nextGraph.nodes),
      edges: diffRecord(state.graph.edges, nextGraph.edges),
      groups: diffRecord(state.graph.groups, nextGraph.groups),
    };

    const result = commit(nextGraph, changes, {
      actor: group.actor,
      command,
      label: group.label,
      transactionId: undefined,
      splitUndo: true,
      historyMode: direction,
      group,
    });

    return {
      status: "applied",
      revision: result.revision,
      undoGroupId: group.id,
      diagnostics,
    };
  }

  function undo(actor: Actor, command = "graph.undo"): HistoryOutcome {
    const state = store.getState();
    const history = historyFor(state, actorKeyOf(actor));
    const group = history.undo[history.undo.length - 1];
    if (group === undefined) {
      return {
        status: "rejected",
        revision: state.graph.revision,
        undoGroupId: undefined,
        diagnostics: [
          { severity: "info", code: "history.empty", message: "Nothing to undo for this actor." },
        ],
      };
    }
    return restore(group, "undo", command);
  }

  function redo(actor: Actor, command = "graph.redo"): HistoryOutcome {
    const state = store.getState();
    const history = historyFor(state, actorKeyOf(actor));
    const group = history.redo[history.redo.length - 1];
    if (group === undefined) {
      return {
        status: "rejected",
        revision: state.graph.revision,
        undoGroupId: undefined,
        diagnostics: [
          { severity: "info", code: "history.empty", message: "Nothing to redo for this actor." },
        ],
      };
    }
    return restore(group, "redo", command);
  }

  function recordAudit(entry: Omit<AuditEntry, "timestamp">): void {
    const state = store.getState();
    store.setState({ audit: [...state.audit, { ...entry, timestamp: now() }] });
  }

  const view: GraphStoreView = {
    getState: store.getState,
    getInitialState: store.getInitialState,
    subscribe: store.subscribe,
    getGraph: () => store.getState().graph,
    getRevision: () => store.getState().graph.revision,
    getAudit: () => store.getState().audit,
    getHistory: (actor: Actor) => historyFor(store.getState(), actorKeyOf(actor)),
  };

  return {
    view,
    internals: { apply, undo, redo, recordAudit, ids },
    raw: store,
  };
}
