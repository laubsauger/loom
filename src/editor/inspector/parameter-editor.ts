import type { LoomBus } from "@domain/commands/bus.ts";
import type { InvocationContext } from "@domain/types/commands.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { NodeFormatOverride, NodeResolutionOverride } from "@domain/types/graph.ts";
import type { EdgeId, NodeId, PortId } from "@domain/types/ids.ts";
import type { ParameterValue, StoredParameter } from "@domain/types/parameters.ts";
import type { GraphPatchResult } from "@domain/types/patch.ts";
import { createFrameCoalescer, rafScheduler } from "@ui/controls/coalesce.ts";
import type { FrameScheduler } from "@ui/controls/coalesce.ts";
import type { EditPhase } from "@ui/controls/types.ts";

/**
 * The bridge from a parameter control to the command bus (T37, T38).
 *
 * Three invariants meet here, and they are the reason this is a module rather than a
 * few lines inside the inspector component:
 *
 * §V29 — every edit goes through `bus.execute`. Nothing here touches the store.
 * §V5  — a value change is one `setParameters` operation, coalesced to an animation
 *        frame. Intermediate drag values reach the document (so the preview is live)
 *        without one patch per pointer event.
 * §V15 — a continuous gesture is ONE undo entry. That is done with the mechanism the
 *        store already has: mutations sharing an `InvocationContext.transactionId`
 *        merge into a single undo group, keeping the oldest `before` value. The editor
 *        mints a transaction id on the first `"live"` value of a gesture, reuses it for
 *        every subsequent value, and drops it after the `"commit"` — so undo after a
 *        drag lands on the value the drag started from, in one step.
 *
 * Patches are queued rather than fired concurrently: `graph.applyPatch` rejects a stale
 * `baseRevision` as a conflict (§V33), so two in-flight patches built against the same
 * revision would make the second one fail. The queue reads the revision at the moment
 * each patch is sent.
 */

export interface ParameterEditorOptions {
  bus: LoomBus;
  /** Actor, project and capability grants for every command this editor sends (§V30). */
  context: InvocationContext;
  /** Frame scheduler; injected in tests to make coalescing deterministic. */
  schedule?: FrameScheduler;
  /** Transaction id source. Injected in tests; defaults to a monotonic local id. */
  newTransactionId?: () => string;
  /** Called with the diagnostics of any patch the bus did not apply. */
  onDiagnostics?: (diagnostics: readonly RuntimeDiagnostic[]) => void;
}

export interface ParameterEditor {
  /** Report a value from a control. `"live"` coalesces; `"commit"` closes the gesture. */
  setParameter: (nodeId: NodeId, key: string, value: ParameterValue, phase: EditPhase) => void;
  /**
   * Report several stored parameters — mode envelopes included — as ONE patch (§V114).
   *
   * This is what keeps a colour pick to one undo entry once its channels carry their own
   * slots (§V113): four component keys, one `setParameters` operation, one transaction.
   * A gesture across the same key SET coalesces as a single-key gesture does.
   */
  setStored: (
    nodeId: NodeId,
    entries: Readonly<Record<string, StoredParameter>>,
    phase: EditPhase,
  ) => void;
  /**
   * T601: which INNER node a component instance's preview shows. Null returns to the
   * default — the node behind the first output socket, the component's Out (T607).
   */
  setComponentPreview: (nodeId: NodeId, inner: string | null) => Promise<GraphPatchResult>;
  setResolution: (
    nodeId: NodeId,
    resolution: NodeResolutionOverride | null,
  ) => Promise<GraphPatchResult>;
  /**
   * T1049 — one variadic input port's edges, in the order the user has just arranged
   * them. Every call inside one gesture shares a transaction, so a drag across three
   * positions is ONE undo entry (§V15) that lands on the order the drag started from.
   *
   * Sent per position crossed rather than once on release, because for Over and Composite
   * the layer order IS the operation: the point of the gesture is watching the picture
   * restack. Nothing is coalesced to a frame — a crossing is a discrete event a few times
   * per drag, not a value stream.
   */
  reorderPortEdges: (
    nodeId: NodeId,
    portId: PortId,
    edgeIds: readonly EdgeId[],
  ) => Promise<GraphPatchResult>;
  /**
   * T1049 — closes the reorder gesture on that port. Writes NOTHING: the last
   * `reorderPortEdges` already carries the final order, and a commit patch restating it
   * would be a second revision saying the same thing.
   */
  endReorderGesture: (nodeId: NodeId, portId: PortId) => void;
  /** T1049 — drop wires from the connections list. One patch, one undo entry (§V32). */
  disconnectEdges: (edgeIds: readonly EdgeId[]) => Promise<GraphPatchResult>;
  setFormat: (nodeId: NodeId, format: NodeFormatOverride | null) => Promise<GraphPatchResult>;
  /**
   * Fires a momentary pulse (T214, §V124).
   *
   * Deliberately NOT queued behind the patch queue and deliberately returning nothing to
   * write back: a pulse is not a patch. It carries no `baseRevision` to go stale, it
   * cannot conflict, and it must land the instant it is pressed — a reset that waited its
   * turn behind a slider drag would clear a buffer the user has since moved on from.
   * Failures still reach `onDiagnostics`, which is how "this pulse fires a command nobody
   * registered" becomes visible instead of a button that does nothing.
   */
  pulse: (nodeId: NodeId, key: string) => void;
  /** Apply anything waiting for the next frame right now. */
  flush: () => void;
  /** Resolves once every queued patch has been applied. */
  settled: () => Promise<void>;
  /** True while a gesture is open — one undo group is still accumulating. */
  isEditing: (nodeId: NodeId, key: string) => boolean;
  dispose: () => void;
}

interface PendingValue {
  nodeId: NodeId;
  entries: Readonly<Record<string, StoredParameter>>;
  transactionId: string;
}

/**
 * Gesture identity. A multi-key write (a compound, §V114) is ONE gesture, so its keys are
 * sorted into a single identity: consecutive frames of the same drag then coalesce and
 * share one transaction, exactly as a single-key drag does.
 */
const editKey = (nodeId: NodeId, keys: readonly string[]): string =>
  `${nodeId} ${[...keys].sort().join(",")}`;

/**
 * Gesture identity for a reorder, kept in the SAME transaction map as parameter edits and
 * therefore prefixed: a port and a parameter can share a name (`in2`), and two gestures
 * sharing a key would merge two unrelated undo groups.
 */
const reorderKey = (nodeId: NodeId, portId: PortId): string => `reorder ${nodeId} ${portId}`;

function createTransactionIds(): () => string {
  let counter = 0;
  const prefix = Math.random().toString(36).slice(2, 8);
  return () => {
    counter += 1;
    return `param-${prefix}-${counter}`;
  };
}

export function createParameterEditor(options: ParameterEditorOptions): ParameterEditor {
  const { bus, context } = options;
  const schedule = options.schedule ?? rafScheduler;
  const newTransactionId = options.newTransactionId ?? createTransactionIds();
  const onDiagnostics = options.onDiagnostics;

  /** Open gestures: edit key → the transaction every value in the gesture shares. */
  const transactions = new Map<string, string>();
  let queue: Promise<unknown> = Promise.resolve();

  const report = (result: GraphPatchResult): GraphPatchResult => {
    if (result.status !== "applied" && onDiagnostics !== undefined) {
      onDiagnostics(result.diagnostics);
    }
    return result;
  };

  const enqueue = <T>(run: () => Promise<T>): Promise<T> => {
    // Chained through both settle paths so one rejected patch cannot stall the queue.
    const next = queue.then(run, run);
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const sendParameters = (
    nodeId: NodeId,
    parameters: Readonly<Record<string, StoredParameter>>,
    label: string,
    transactionId: string | undefined,
  ): Promise<GraphPatchResult> =>
    enqueue(async () => {
      const result = await bus.execute(
        "graph.applyPatch",
        {
          // Read at send time: the queue guarantees no other patch of ours is in flight.
          baseRevision: bus.store.getRevision(),
          label,
          // `GraphPatchOperation` still types this field as `ParameterValue`, while
          // `GraphNode.parameters`, the zod boundary and `applyGraphPatch` all speak
          // `StoredParameter` — a slot is accepted end to end at runtime. The cast is
          // the same one `apply-patch.ts` already makes; widening the operation type is
          // a change in `src/domain/types/patch.ts`, which this track does not own.
          operations: [
            { op: "setParameters", nodeId, parameters: parameters as Record<string, ParameterValue> },
          ],
        },
        {
          ...context,
          ...(transactionId === undefined ? {} : { transactionId }),
        },
      );
      return report(result.output);
    });

  const labelFor = (keys: readonly string[]): string => `Set ${keys.join(", ")}`;

  const coalescer = createFrameCoalescer<PendingValue>((entries) => {
    for (const [, pending] of entries) {
      void sendParameters(
        pending.nodeId,
        pending.entries,
        labelFor(Object.keys(pending.entries)),
        pending.transactionId,
      );
    }
  }, schedule);

  const write = (
    nodeId: NodeId,
    entries: Readonly<Record<string, StoredParameter>>,
    phase: EditPhase,
  ): void => {
    const keys = Object.keys(entries);
    const identity = editKey(nodeId, keys);

    if (phase === "live") {
      let transactionId = transactions.get(identity);
      if (transactionId === undefined) {
        transactionId = newTransactionId();
        transactions.set(identity, transactionId);
      }
      coalescer.schedule(identity, { nodeId, entries, transactionId });
      return;
    }

    // Commit: the final value supersedes anything queued this frame, and closes the
    // undo group the gesture opened (§V15).
    coalescer.cancel(identity);
    const transactionId = transactions.get(identity);
    transactions.delete(identity);
    void sendParameters(nodeId, entries, labelFor(keys), transactionId);
  };

  return {
    setParameter(nodeId, key, value, phase) {
      write(nodeId, { [key]: value }, phase);
    },

    setStored(nodeId, entries, phase) {
      write(nodeId, entries, phase);
    },

    setResolution(nodeId, resolution) {
      return enqueue(async () => {
        const result = await bus.execute("node.setResolution", { nodeId, resolution }, context);
        return report(result.output);
      });
    },

    setFormat(nodeId, format) {
      return enqueue(async () => {
        const result = await bus.execute("node.setFormat", { nodeId, format }, context);
        return report(result.output);
      });
    },

    reorderPortEdges(nodeId, portId, edgeIds) {
      // Read and opened SYNCHRONOUSLY, before the queue: the gesture's identity must not
      // depend on when its patch happens to be sent.
      const identity = reorderKey(nodeId, portId);
      let transactionId = transactions.get(identity);
      if (transactionId === undefined) {
        transactionId = newTransactionId();
        transactions.set(identity, transactionId);
      }
      const gesture = transactionId;
      const order = [...edgeIds];
      return enqueue(async () => {
        const result = await bus.execute(
          "graph.applyPatch",
          {
            baseRevision: bus.store.getRevision(),
            label: "Reorder connections",
            operations: [{ op: "reorderEdges", nodeId, portId, edgeIds: order }],
          },
          { ...context, transactionId: gesture },
        );
        return report(result.output);
      });
    },

    endReorderGesture(nodeId, portId) {
      transactions.delete(reorderKey(nodeId, portId));
    },

    disconnectEdges(edgeIds) {
      const removed = [...edgeIds];
      return enqueue(async () => {
        const result = await bus.execute(
          "graph.applyPatch",
          {
            baseRevision: bus.store.getRevision(),
            label: "Disconnect",
            operations: [{ op: "disconnect", edgeIds: removed }],
          },
          context,
        );
        return report(result.output);
      });
    },

    setComponentPreview(nodeId, inner) {
      return enqueue(async () => {
        const result = await bus.execute(
          "graph.applyPatch",
          {
            baseRevision: bus.store.getRevision(),
            label: inner === null ? "Reset component preview" : "Set component preview",
            operations: [{ op: "setNodeUi", nodeId, ui: { componentPreview: inner } }],
          },
          context,
        );
        return report(result.output);
      });
    },

    pulse(nodeId, key) {
      void bus
        .execute("parameter.pulse", { nodeId, parameterKey: key }, context)
        .then((result) => {
          if (result.status !== "applied" && onDiagnostics !== undefined) {
            onDiagnostics(result.diagnostics);
          }
        })
        .catch((thrown: unknown) => {
          onDiagnostics?.([
            {
              severity: "error",
              code: "parameter.pulse.failed",
              // The error TYPE only: its message may quote untrusted document text (§V37).
              message: `Firing "${key}" failed: ${thrown instanceof Error ? thrown.name : "a non-Error value was thrown"}.`,
              nodeId,
            },
          ]);
        });
    },

    flush: coalescer.flush,

    async settled() {
      coalescer.flush();
      // Two awaits: the first drains what is queued now, the second anything the
      // flushed patches queued behind it.
      await queue;
      await queue;
    },

    isEditing: (nodeId, key) => transactions.has(editKey(nodeId, [key])),

    dispose() {
      coalescer.dispose();
      transactions.clear();
    },
  };
}
