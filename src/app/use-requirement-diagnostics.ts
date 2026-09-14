import { useCallback, useMemo, useSyncExternalStore } from "react";
import { resolveParameters } from "@domain/parameters/index.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { nodeRuntimeRequirements } from "@domain/types/node-definition.ts";
import {
  assessRequirements,
  describeRequirementProblem,
  type HostFacts,
  type RuntimeRequirementId,
} from "@domain/types/requirements.ts";
import type { OscBridgeState } from "@domain/osc/osc-status.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";

/**
 * T1340b — THE NODE CARRIES ITS OWN LIMITATION, as a diagnostic and not as new chrome.
 *
 * Owner: *"in the nodes, like the SYPHON node — if there's a limitation and warnings we
 * show 'source macOS desktop required', that should EQUALLY be highlighted in the same
 * kind of color here… and ideally THE NODE ITSELF would also be highlighted as if there's
 * a warning on it, with the usual warning text exposed ON THE NODE as we do with all
 * other kinds of warnings and errors."*
 *
 * ## It is a REAL diagnostic, not a lookalike
 *
 * What comes out of here is `RuntimeDiagnostic[]`, and app.tsx feeds it into the SAME two
 * places every other session diagnostic goes: `problems` (the panel, the agent surface,
 * the error count) and `sessionNodeDiagnostics` (T1067's per-node badge roll-up). So a
 * Syphon node in a browser reads "1 warn" on its badge, shows its sentence on the node,
 * appears in the problems pane and is counted by the dock's warning tally — because it IS
 * one, not because three surfaces were each taught to draw a lookalike. A badge that says
 * one and a panel that says none is the failure this avoids; a user trusts whichever they
 * saw first.
 *
 * ## Why this is not folded into `use-native-inputs`
 *
 * That hook reports on nodes the render is DEMANDING, at their resolved size. A Syphon
 * node the user has just dropped and not wired yet demands nothing — and is exactly the
 * node they are looking at. The limitation is a property of the node's TYPE and the
 * machine, so it is answered from the document, before and regardless of any render.
 *
 * ## What it does not claim
 *
 * `describeRequirementProblem` skips requirements marked `liveState` — the local helper,
 * and only it. OSC, laser and Vision each narrate the helper with a detail no static
 * derivation can reach (connecting, unreachable, refused-your-code), and a second
 * "needs the helper" beside "the helper refused your code" would be two warnings on one
 * node disagreeing about how much is known. See the note on `RuntimeRequirement.liveState`.
 */

/** Map an OSC/device bridge state onto the helper's three-valued fact (§V986).
 *
 * ⚑ `idle` AND `connecting` ARE BOTH `unknown`, AND THAT IS THE WHOLE POINT. `idle` is the
 * state on load and whenever no node has asked for a device — the socket has NOT been
 * probed, so "the helper is not running" is unsupported by anything. Collapsing either
 * into `absent` produces a confident wrong sentence about the user's machine one second
 * after the page opens. `refused` IS `absent`: something answered and would not pair, so
 * this page has no helper even though a process exists.
 */
export function helperFactFrom(state: OscBridgeState): HostFacts["helper"] {
  switch (state.kind) {
    // `error` is in here on purpose: attached, and the stream is in trouble — which is a
    // helper PROBLEM, not an absent helper. The pump that owns the stream has the words
    // for what is wrong with it.
    case "attached":
    case "listening":
    case "error":
      return "paired";
    case "unreachable":
    case "refused":
      return "absent";
    case "idle":
    case "connecting":
      return "unknown";
  }
}

/**
 * The DOCUMENT node a flattened id belongs to. A Syphon node inside a component has the
 * flattened id `instance/inner` (`a/b/c` when nested twice) and the canvas draws the
 * top-level instance — so the instance is what must light up, or the warning is published
 * against an id no node on the canvas carries and is silently dropped.
 *
 * Splitting on the first "/" is the documented inverse of `flattenedNodeId`: node ids may
 * not contain "/", and `src/compiler/flatten.ts` rejects one that does with a diagnostic.
 * A ROOT node's flat id is its own id unchanged (the root prefix is ""), so this is the
 * identity for the common case.
 */
function documentOwner(flatId: string): NodeId {
  const slash = flatId.indexOf("/");
  return (slash === -1 ? flatId : flatId.slice(0, slash)) as NodeId;
}

export function requirementDiagnostics(
  flatGraph: GraphDocument,
  registry: NodeRegistryView,
  host: HostFacts,
): readonly RuntimeDiagnostic[] {
  const out: RuntimeDiagnostic[] = [];
  const seen = new Set<string>();
  // Sorted so the array is a pure function of the document, not of key insertion order —
  // app.tsx re-publishes node status on array identity change and a churning order would
  // republish every frame.
  for (const flatId of Object.keys(flatGraph.nodes).sort()) {
    const node = flatGraph.nodes[flatId];
    if (node === undefined) continue;
    const definition = registry.get(node.type);
    if (definition === undefined) continue;
    let declared: readonly RuntimeRequirementId[];
    try {
      declared = nodeRuntimeRequirements(definition, resolveParameters(node, definition).values);
    } catch {
      /* The definition refused to classify itself — a transport value it does not know.
         The compiler is already reporting that same value as an invalid parameter, and a
         second warning saying "we could not work out what this needs" would be a louder
         restatement of a problem the user is already being shown. */
      continue;
    }
    if (declared.length === 0) continue;
    const owner = documentOwner(flatId);
    const problem = describeRequirementProblem(
      definition.title,
      assessRequirements(declared, host),
    );
    if (problem === null) continue;
    // One row per (node, message): two Syphon nodes inside one component instance say the
    // same sentence about the same instance, and the badge should read 1, not 2.
    const key = `${owner}\u0000${problem.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      severity: "warning",
      code: "requirement.unmet",
      nodeId: owner,
      message: problem.message,
      ...(problem.suggestion === undefined ? {} : { suggestion: problem.suggestion }),
    });
  }
  return out;
}

/**
 * The session's requirement warnings, recomputed when the document or the component
 * catalogue changes and at no other time.
 *
 * It reads the store itself rather than taking `compile.graph`, and that is a sequencing
 * fact rather than a preference: `sessionNodeDiagnostics` is an INPUT to `useGraphCompile`
 * (T1067 folds it into the per-node badge counts), so anything that feeds it has to be
 * available before the compile, which `compile.graph` is not. `flattened.current()` is the
 * composition root's memo — the same one the compile reads — so this costs a map lookup,
 * not a second flattening (§V529).
 */
export function useRequirementDiagnostics(
  runtime: {
    readonly bus: { readonly store: { subscribe(listener: () => void): () => void } };
    readonly components: { subscribe(listener: () => void): () => void };
    readonly flattened: { current(): { readonly graph: GraphDocument } };
    readonly registry: NodeRegistryView;
  },
  host: HostFacts,
): readonly RuntimeDiagnostic[] {
  const subscribe = useCallback(
    (listener: () => void) => {
      // §V210(c): a component's INTERNALS can change with the host document untouched —
      // same nodes, same edges, same revision. A Syphon node added inside a component
      // definition must still light its instance, so both notifications are wired.
      const offStore = runtime.bus.store.subscribe(listener);
      const offCatalogue = runtime.components.subscribe(listener);
      return () => { offStore(); offCatalogue(); };
    },
    [runtime],
  );
  // `current()` is memoized on (document, catalogue revision) and returns the SAME object
  // when neither moved, which is exactly the stable snapshot `useSyncExternalStore` needs.
  const snapshot = useCallback(() => runtime.flattened.current(), [runtime]);
  const flattened = useSyncExternalStore(subscribe, snapshot, snapshot);
  return useMemo(
    () => requirementDiagnostics(flattened.graph, runtime.registry, host),
    [flattened, runtime.registry, host],
  );
}
