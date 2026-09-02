import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type { ComponentId } from "../types/ids.ts";
import type { IdFactory } from "../graph/ids.ts";
import type { GraphStore } from "../graph/store.ts";
import { createGraphStore } from "../graph/store.ts";
import type { LoomBus } from "../commands/bus.ts";
import { createDomainBus } from "../commands/index.ts";
import type { NodeRegistryView } from "../../nodes/registry/registry.ts";
import { pruneComponentDefinition } from "./definition.ts";
import { registerComponentCommands } from "./commands.ts";
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
}

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
  const { bus } = createDomainBus({ store, registry: options.nodes });
  registerComponentCommands(bus, {
    components: options.components,
    host: { componentId: options.componentId, version: options.version },
  });

  const unsubscribe = store.view.subscribe((state, previous) => {
    if (state.graph === previous.graph) return;
    const current = options.components.get(options.componentId, options.version);
    if (current === undefined) return;
    const next = pruneComponentDefinition({ ...current, graph: state.graph }, options.nodes);
    const problems = options.components.validate(next);
    if (problems.some((diagnostic) => diagnostic.severity === "error")) {
      options.onInvalid?.(problems);
      return;
    }
    options.components.register(next);
  });

  return {
    componentId: options.componentId,
    version: options.version,
    bus,
    store,
    dispose: unsubscribe,
  };
}
