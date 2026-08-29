import { enablePatches, produce, produceWithPatches, setAutoFreeze } from "immer";
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
// Patches are how commits learn WHICH entities a recipe touched without diffing the
// whole document per apply (T103): a one-parameter drag on a 1000-node graph must not
// sort three thousand keys per frame.
enablePatches();

/**
 * Bounds for per-commit state (T103). The audit array and owner map are copied on
 * every commit, and a 60Hz drag writes a commit per frame — unbounded, both are a
 * session-length memory leak with O(n) copies on top.
 */
const MAX_AUDIT_ENTRIES = 512;
const MAX_OWNER_ENTRIES = 4096;

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

/**
 * Builds per-entity changes for a KNOWN candidate key set (T103). Callers hand in the
 * keys a commit may have touched — from immer patches on apply, from the undo group on
 * restore — so cost scales with the edit, not the document. Keys are sorted so two
 * actors replaying the same edit build identical records (§V40).
 */
function diffRecordKeys<T>(
  before: Readonly<Record<string, T>>,
  after: Readonly<Record<string, T>>,
  candidateKeys: Iterable<string>,
): Record<string, EntityChange<T>> {
  const changes: Record<string, EntityChange<T>> = {};
  for (const key of [...new Set(candidateKeys)].sort()) {
    const prior = before[key];
    const next = after[key];
    if (prior !== next) changes[key] = { before: prior, after: next };
  }
  return changes;
}

type CollectionName = "nodes" | "edges" | "groups";

/**
 * Touched entity ids per collection, read off immer's patch list. A patch path deeper
 * than the collection names one entity; a patch replacing a whole collection (rare —
 * nothing does it today) degrades to every key of both sides, which is exactly the old
 * full-diff behavior.
 */
function touchedKeys(
  patches: ReadonlyArray<{ path: (string | number)[] }>,
  collection: CollectionName,
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
): Set<string> {
  const keys = new Set<string>();
  for (const patch of patches) {
    if (patch.path[0] !== collection) continue;
    const key = patch.path[1];
    if (typeof key === "string") {
      keys.add(key);
    } else {
      for (const k of Object.keys(before)) keys.add(k);
      for (const k of Object.keys(after)) keys.add(k);
    }
  }
  return keys;
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

    let owners: Record<string, EntityOwner> = { ...state.owners };
    const touched = [
      ...Object.keys(changes.nodes).map((id) => `node:${id}`),
      ...Object.keys(changes.edges).map((id) => `edge:${id}`),
      ...Object.keys(changes.groups).map((id) => `group:${id}`),
    ];
    for (const entity of touched) owners[entity] = { actorKey: key, revision };
    // T103: owner rows for long-gone entities (deleted nodes keep theirs so §V41 can
    // still block a stale redo) must not accumulate forever. Evict the oldest rows once
    // the map outgrows its bound; blocking degrades gracefully for ancient edits only.
    const ownerKeysAll = Object.keys(owners);
    if (ownerKeysAll.length > MAX_OWNER_ENTRIES) {
      const keep = ownerKeysAll
        .sort((a, b) => (owners[b]?.revision ?? 0) - (owners[a]?.revision ?? 0))
        .slice(0, Math.floor(MAX_OWNER_ENTRIES * 0.75));
      const pruned: Record<string, EntityOwner> = {};
      for (const entity of keep) pruned[entity] = owners[entity] as EntityOwner;
      owners = pruned;
    }

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
      // Bounded ring (T103): a 60Hz drag writes an entry per frame; unbounded, the
      // audit array is the store's memory leak. The viewer shows the recent window.
      audit: [...state.audit.slice(-(MAX_AUDIT_ENTRIES - 1)), entry],
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
    // Patches record which entities were touched, so the commit diffs only those (T103).
    const [drafted, patches] = produceWithPatches(base, (draft) => {
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
        nodes: diffRecordKeys(base.nodes, drafted.nodes, touchedKeys(patches, "nodes", base.nodes, drafted.nodes)),
        edges: diffRecordKeys(base.edges, drafted.edges, touchedKeys(patches, "edges", base.edges, drafted.edges)),
        groups: diffRecordKeys(base.groups, drafted.groups, touchedKeys(patches, "groups", base.groups, drafted.groups)),
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

    // The group already names every entity a restore may touch — no scan needed (T103).
    const changes = {
      nodes: diffRecordKeys(state.graph.nodes, nextGraph.nodes, Object.keys(group.nodes)),
      edges: diffRecordKeys(state.graph.edges, nextGraph.edges, Object.keys(group.edges)),
      groups: diffRecordKeys(state.graph.groups, nextGraph.groups, Object.keys(group.groups)),
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
    store.setState({
      audit: [...state.audit.slice(-(MAX_AUDIT_ENTRIES - 1)), { ...entry, timestamp: now() }],
    });
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
