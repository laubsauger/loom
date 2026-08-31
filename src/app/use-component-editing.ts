import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ShaderloomBus } from "@domain/commands/bus.ts";
import type { ComponentPath, GraphComponentDefinition } from "@domain/types/components.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import { openComponentSession } from "@domain/components/session.ts";
import type { ComponentSession } from "@domain/components/session.ts";
import type { Breadcrumb, ResolvedComponentPath } from "@domain/components/navigation.ts";
import { resolveComponentNavigation } from "@editor/component/index.ts";
import type { AppRuntime } from "./app-runtime.ts";
import {
  createComponentNavigationStore,
  navigationHolderFor,
  registerComponentNavigationCommands,
} from "./component-navigation.ts";

/**
 * Editing inside a component (T423, T130, §V82).
 *
 * ## What actually changes when you dive in
 *
 * ONE thing: which graph the canvas and the inspector edit. The compile, the frame loop,
 * the viewer and the transport keep running against the ROOT document, because that is
 * what the project renders — walking into a component to fix a blur must not blank the
 * output, and TouchDesigner's network editor behaves the same way for the same reason.
 *
 * ## Why a second store, and why that is not a second mutation path
 *
 * A component's internals are a `GraphDocument` that is NOT in the project document
 * (§V79) — it lives in the catalogue, once, shared by every linked instance. The thing
 * that edits a `GraphDocument` correctly already exists, so `openComponentSession` opens
 * one of those over the definition and writes every committed change back to the
 * catalogue. Add-node, connect, undo, redo, the audit log and §V32's atomicity all work
 * inside a component with no second implementation (§V29 is about there being one KIND of
 * mutation path, and this is that kind, pointed at the other document).
 *
 * The session bus also carries `host`, which is what makes `component.publishParameter`,
 * `component.exposePort` and the rest legal: they are things you do while INSIDE a
 * component, and on the root bus they refuse by name.
 *
 * ## What does NOT work inside a component yet, stated rather than hidden
 *
 * Preview tiles and per-node error badges. Both are keyed on DOCUMENT node ids, and
 * `flattenComponents` prefixes an internal node's id with its instance chain (`c1/blurA`)
 * — so the flat plan does hold the internal node, under a name the canvas never asks for.
 * The honest consequence is that `compiledOutputs` is empty inside a component rather
 * than a root plan whose ids could collide with internal ones; a preview that showed the
 * WRONG node's picture would be far worse than no preview (§V8, B41's shape).
 */

export interface ComponentEditing {
  /** Instance-node chain from the root, innermost last. Empty is the root document. */
  path: ComponentPath;
  breadcrumbs: readonly Breadcrumb[];
  /** The graph the canvas edits: the root document, or a component's internals. */
  graph: GraphDocument;
  /** The bus the canvas and inspector mutate through — session bus when inside. */
  bus: ShaderloomBus;
  /** A runtime whose `bus` is the one above, for the panes that read it from context. */
  runtime: AppRuntime;
  /** The component being edited, or null at the root. */
  definition: GraphComponentDefinition | null;
  insideComponent: boolean;
  /** Path resolution problems — a stale instance, an uninstalled component (§V82). */
  diagnostics: readonly RuntimeDiagnostic[];
  navigate: (path: ComponentPath) => void;
  exit: () => void;
}

export function useComponentEditing(runtime: AppRuntime): ComponentEditing {
  const store = useMemo(() => createComponentNavigationStore(), []);
  const path = useSyncExternalStore(store.subscribe, store.getPath, store.getPath);

  const rootGraph = useSyncExternalStore<GraphDocument>(
    runtime.bus.store.subscribe,
    runtime.bus.store.getGraph,
    runtime.bus.store.getGraph,
  );

  // Re-authoring a component is not a document edit, so the graph store never fires for
  // it and the resolved path would keep the definition it saw when the user entered.
  const [catalogueRevision, bumpCatalogue] = useState(0);
  useEffect(
    () => runtime.components.subscribe(() => bumpCatalogue((count) => count + 1)),
    [runtime.components],
  );

  const componentsView = useMemo(() => runtime.components.view(), [runtime.components]);

  const resolved: ResolvedComponentPath = useMemo(
    () => {
      void catalogueRevision;
      return resolveComponentNavigation({
        root: rootGraph,
        path,
        components: componentsView,
        nodes: runtime.registry,
      });
    },
    [catalogueRevision, componentsView, path, rootGraph, runtime.registry],
  );

  /**
   * The commands need `resolve()` synchronously, from a handler that runs outside React.
   * A ref rather than a closure over `resolved`: the bus registration happens once, and a
   * handler holding the first render's walk would dive relative to wherever the user was
   * when the app booted.
   */
  const resolvedRef = useRef(resolved);
  resolvedRef.current = resolved;

  const holder = useMemo(() => navigationHolderFor(runtime.bus), [runtime.bus]);
  useEffect(() => {
    registerComponentNavigationCommands(runtime.bus);
    holder.current = {
      getPath: store.getPath,
      setPath: store.setPath,
      subscribe: store.subscribe,
      resolve: () => resolvedRef.current,
      components: componentsView,
    };
    return () => {
      holder.current = null;
    };
  }, [componentsView, holder, runtime.bus, store]);

  /**
   * A path that stopped resolving — the instance was deleted, the component uninstalled —
   * truncates rather than throwing, and the editor follows it back to somewhere real.
   *
   * IT RE-RESOLVES AGAINST THE LIVE STORES rather than trusting `resolved`, and that is
   * the whole point of the effect. `resolved` is a memo over THREE independent sources —
   * the navigation store, the graph store and a catalogue counter that arrives as ordinary
   * React state — so a render can legitimately hold a path from one of them beside a
   * snapshot from another. Observed live: entering a component saved seconds earlier
   * ejected the user back to the root on the next click, from a one-render disagreement
   * and not from anything being wrong. Ejecting someone out of the network they are
   * editing is not a recoverable mistake, so the decision is made from what is true NOW,
   * and a path that is merely momentarily unresolvable stays put.
   */
  useEffect(() => {
    if (path.length === 0) return;
    const live = resolveComponentNavigation({
      root: runtime.bus.store.getGraph(),
      path,
      components: componentsView,
      nodes: runtime.registry,
    });
    if (live.resolvedPath.length !== path.length) store.setPath(live.resolvedPath);
  }, [componentsView, path, resolved, runtime.bus, runtime.registry, store]);

  const innermost = resolved.frames[resolved.frames.length - 1];
  const componentId = innermost?.componentId ?? null;
  const version = innermost?.version ?? null;

  const [session, setSession] = useState<ComponentSession | null>(null);
  useEffect(() => {
    if (componentId === null || version === null) {
      setSession(null);
      return;
    }
    // Keyed on the component and version ALONE. Re-keying on the definition object would
    // reopen the session on every edit the session itself makes, throwing away the undo
    // history the user is standing in the middle of.
    const opened = openComponentSession({
      components: runtime.components,
      nodes: runtime.registry,
      componentId,
      version,
    });
    setSession(opened);
    return () => {
      opened.dispose();
      setSession(null);
    };
  }, [componentId, runtime.components, runtime.registry, version]);

  const live = session !== null && session.componentId === componentId && session.version === version;
  const editBus = live && session !== null ? session.bus : runtime.bus;

  const graph = useSyncExternalStore<GraphDocument>(
    editBus.store.subscribe,
    editBus.store.getGraph,
    editBus.store.getGraph,
  );

  const scopedRuntime = useMemo<AppRuntime>(
    () => (editBus === runtime.bus ? runtime : { ...runtime, bus: editBus }),
    [editBus, runtime],
  );

  const navigate = useCallback((next: ComponentPath) => store.setPath(next), [store]);
  const exit = useCallback(() => store.setPath(path.slice(0, -1)), [path, store]);

  return {
    path,
    breadcrumbs: resolved.breadcrumbs,
    graph,
    bus: editBus,
    runtime: scopedRuntime,
    definition: live ? (innermost?.definition ?? null) : null,
    insideComponent: componentId !== null,
    diagnostics: resolved.diagnostics,
    navigate,
    exit,
  };
}
