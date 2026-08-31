import type { ShaderloomBus } from "@domain/commands/bus.ts";
import type { ComponentPath } from "@domain/types/components.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { readComponentInstance } from "@domain/components/instance.ts";
import { enterPath, parentPath } from "@domain/components/navigation.ts";
import type { ResolvedComponentPath } from "@domain/components/navigation.ts";
import type { ComponentRegistryView } from "@domain/components/registry.ts";

/**
 * `graph.diveIn` / `graph.jumpUp` — subgraph navigation (T423, §V307, §V82).
 *
 * These two were named by the default keymap (`i`, `enter`, `u`) and by the node menu
 * from T77 onward and registered by NOBODY, on purpose: §V307 says an openable surface is
 * opened by a COMMAND, and until there was a surface to open, a registered command would
 * have made the palette look complete while the key did nothing. That is the state the
 * `view.*` pair was in until T430 and `graph.layout*` was in until B84, and both left it
 * the same way — by registering beside the surface they move.
 *
 * WHERE THE PATH LIVES. Not in the document: which component you happen to be looking
 * inside is view state, exactly like the viewport, and writing it into the graph would
 * make walking around a project an undoable edit that dirties the file (§V16). So the
 * path is held here, beside the canvas, and the commands move it.
 *
 * WHY THE COMMANDS RESOLVE THE PATH THEMSELVES. `context.graph` is always the ROOT
 * document — the app bus owns the root store, and the graph the canvas is showing three
 * levels down is a component DEFINITION, which is not in the document at all (§V79). So
 * "is the thing under the cursor a component instance?" has to be asked of the graph at
 * the CURRENT depth, which is what `resolve()` supplies.
 *
 * RECURSION. There is nothing to guard here, and that is a claim rather than an
 * omission: `ComponentRegistry.register` refuses any definition that would close a cycle,
 * direct or indirect (§V83, `detectComponentRecursion`), so a component whose internals
 * reach itself cannot be in the catalogue for a dive to descend into.
 * `component-editing.test.tsx` proves the claim by trying to build one — directly, and
 * through a wrapper — and reading the refusal, rather than asserting a depth cap that
 * would hide it.
 *
 * `ui.createComponent` lives here too, at the bottom: it is the other half of the same
 * surface (making a component, as against walking into one), and putting a registrar in a
 * `.tsx` file costs a react-refresh boundary for nothing.
 */

declare module "@domain/types/commands.ts" {
  interface CommandMap {
    /**
     * Enter a component instance and edit its internals (T130).
     *
     * Takes both shapes on purpose: the keymap sends the SELECTION (`nodeIds`), the node
     * menu sends the node under the cursor (`nodeId`), and both were written down long
     * before this command existed. Making the command speak both is one small union;
     * making the two tables agree afterwards would have been an edit to each.
     */
    "graph.diveIn": { input: DiveInInput; output: ComponentPathOutput };
    /** Leave the current component for the graph one level out (T130). */
    "graph.jumpUp": { input: Record<string, never>; output: ComponentPathOutput };
  }
}

export interface DiveInInput {
  nodeId?: NodeId;
  nodeIds?: readonly NodeId[];
}

export interface ComponentPathOutput {
  /** Where the editor is after the command, innermost last. Empty is the root graph. */
  path: ComponentPath;
  /** Human-readable, the same string a diagnostic path uses (§V82). */
  label: string;
}

/**
 * The editor's current depth, plus the walk that resolves it.
 *
 * `resolve` is supplied by the app rather than computed here so there is ONE resolution
 * of the path per render — the breadcrumb, the graph the canvas edits, the lexical
 * `parent` scope and this command all read the same walk (§V29's shape, applied to a
 * derivation instead of to a mutation).
 */
export interface ComponentNavigation {
  getPath(): ComponentPath;
  setPath(path: ComponentPath): void;
  subscribe(listener: () => void): () => void;
  /** The resolved walk for the CURRENT path. */
  resolve(): ResolvedComponentPath;
  components: ComponentRegistryView;
}

export function createComponentNavigationStore(): {
  getPath(): ComponentPath;
  setPath(path: ComponentPath): void;
  subscribe(listener: () => void): () => void;
} {
  let path: ComponentPath = [];
  const listeners = new Set<() => void>();
  return {
    getPath: () => path,
    setPath(next) {
      // Reference-stable when nothing moved: `useSyncExternalStore` compares snapshots by
      // identity, and a fresh array every time would re-render the canvas on every dive
      // that went nowhere.
      if (next.length === path.length && next.every((id, index) => path[index] === id)) return;
      path = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const holders = new WeakMap<object, { current: ComponentNavigation | null }>();

export function navigationHolderFor(bus: ShaderloomBus): { current: ComponentNavigation | null } {
  const existing = holders.get(bus);
  if (existing !== undefined) return existing;
  const holder: { current: ComponentNavigation | null } = { current: null };
  holders.set(bus, holder);
  return holder;
}

function warning(code: string, message: string, suggestion?: string): RuntimeDiagnostic {
  return { severity: "warning", code, message, ...(suggestion === undefined ? {} : { suggestion }) };
}

const NO_CANVAS = warning(
  "component.navigation.noCanvas",
  "No graph canvas is mounted, so there is nowhere to dive into.",
);

/** Idempotent, like `registerViewCommands`: the bus has no unregister and React remounts. */
export function registerComponentNavigationCommands(bus: ShaderloomBus): {
  current: ComponentNavigation | null;
} {
  const holder = navigationHolderFor(bus);
  if (bus.hasCommand("graph.diveIn")) return holder;

  bus.registerCommand({
    name: "graph.diveIn",
    description: "Open a component instance and edit its internals (T130, §V82).",
    handler: (input, context) => {
      const revision = context.store.getRevision();
      const navigation = holder.current;
      const reject = (diagnostic: RuntimeDiagnostic) =>
        ({
          status: "rejected" as const,
          revision,
          diagnostics: [diagnostic],
          output: { path: navigation?.getPath() ?? [], label: "Main" },
        });

      if (navigation === null) return reject(NO_CANVAS);
      const resolved = navigation.resolve();
      const candidates =
        input.nodeId !== undefined ? [input.nodeId] : [...(input.nodeIds ?? [])].sort();

      if (candidates.length === 0) {
        return reject(
          warning(
            "component.navigation.noSelection",
            "Select a component instance to dive into.",
          ),
        );
      }

      // The FIRST instance among the candidates, not "the selection must be exactly one":
      // `i` is bound to the whole selection, and refusing a two-node selection that
      // contains one component would be a refusal the user cannot act on.
      const target = candidates.find((nodeId) => {
        const node = resolved.graph.nodes[nodeId];
        return node !== undefined && readComponentInstance(node) !== null;
      });

      if (target === undefined) {
        // §V288: name what was asked for and what is there. "Nothing happened" on a key
        // press is indistinguishable from a broken key.
        const named = candidates
          .map((nodeId) => resolved.graph.nodes[nodeId]?.label ?? nodeId)
          .join(", ");
        return reject(
          warning(
            "component.navigation.notAComponent",
            `Nothing to dive into: ${named} ${candidates.length === 1 ? "is not a component instance" : "are not component instances"}.`,
            "Select a component instance, or save a selection as a component first.",
          ),
        );
      }

      const state = readComponentInstance(resolved.graph.nodes[target] as never);
      if (state !== null && !navigation.components.has(state.componentId, state.version)) {
        return reject(
          warning(
            "component.navigation.notInstalled",
            `Cannot open "${state.componentId}" version ${state.version}: it is not installed.`,
            "A placeholder instance keeps its values but has no internals to show (§V10).",
          ),
        );
      }

      const next = enterPath(navigation.getPath(), target);
      // §V36: a dry run validates and moves nothing.
      if (context.dryRun) {
        return { status: "validated" as const, revision, output: { path: next, label: "Main" } };
      }
      navigation.setPath(next);
      const after = navigation.resolve();
      return {
        status: "applied" as const,
        revision,
        // Not `context.apply`: entering a component edits no document, so it must not bump
        // the revision or open an undo group. Cmd+Z after walking into a component has to
        // undo the last EDIT, not the walk (§V34, §V16).
        output: { path: after.resolvedPath, label: crumbLabel(after) },
      };
    },
    rejectionOutput: () => ({ path: [], label: "Main" }),
  });

  bus.registerCommand({
    name: "graph.jumpUp",
    description: "Leave the current component for the graph one level out (T130).",
    handler: (_input, context) => {
      const revision = context.store.getRevision();
      const navigation = holder.current;
      if (navigation === null) {
        return {
          status: "rejected" as const,
          revision,
          diagnostics: [NO_CANVAS],
          output: { path: [], label: "Main" },
        };
      }
      const path = navigation.getPath();
      if (path.length === 0) {
        return {
          status: "rejected" as const,
          revision,
          diagnostics: [
            {
              severity: "info" as const,
              code: "component.navigation.atRoot",
              message: "Already at the top of the project.",
            },
          ],
          output: { path: [], label: "Main" },
        };
      }
      const next = parentPath(path);
      if (context.dryRun) {
        return { status: "validated" as const, revision, output: { path: next, label: "Main" } };
      }
      navigation.setPath(next);
      const after = navigation.resolve();
      return {
        status: "applied" as const,
        revision,
        output: { path: after.resolvedPath, label: crumbLabel(after) },
      };
    },
    rejectionOutput: () => ({ path: [], label: "Main" }),
  });

  return holder;
}

function crumbLabel(resolved: ResolvedComponentPath): string {
  return resolved.breadcrumbs.map((crumb) => crumb.label).join(" / ");
}

declare module "@domain/types/commands.ts" {
  interface CommandMap {
    /**
     * Open the "save selection as a component" prompt on the canvas (T423, §V307).
     *
     * `ui.*` because it opens a SURFACE. The document edit it leads to is
     * `component.saveSelection`, which the prompt runs once it has a name.
     */
    "ui.createComponent": { input: { nodeIds?: readonly NodeId[] }; output: { open: boolean } };
  }
}

export interface CreateComponentHolder {
  current: ((nodeIds: readonly NodeId[]) => void) | null;
}

const creationHolders = new WeakMap<object, CreateComponentHolder>();

export function componentCreationHolderFor(bus: ShaderloomBus): CreateComponentHolder {
  const existing = creationHolders.get(bus);
  if (existing !== undefined) return existing;
  const holder: CreateComponentHolder = { current: null };
  creationHolders.set(bus, holder);
  return holder;
}

/** Idempotent, like the view and navigation registrars. */
export function registerCreateComponentCommand(bus: ShaderloomBus): CreateComponentHolder {
  const holder = componentCreationHolderFor(bus);
  if (bus.hasCommand("ui.createComponent")) return holder;

  bus.registerCommand({
    name: "ui.createComponent",
    description: "Name the selected nodes and save them as a reusable component (§V79).",
    handler: (input, context) => {
      const revision = context.store.getRevision();
      const nodeIds = [...new Set(input.nodeIds ?? [])].sort();
      if (holder.current === null) {
        return {
          status: "rejected" as const,
          revision,
          diagnostics: [
            {
              severity: "warning" as const,
              code: "component.create.noCanvas",
              message: "No graph canvas is mounted, so there is nothing to save.",
            },
          ],
          output: { open: false },
        };
      }
      if (nodeIds.length === 0) {
        // §V288: a refusal that names what is missing. An empty selection silently opening
        // a prompt that then refuses would waste the gesture twice.
        return {
          status: "rejected" as const,
          revision,
          diagnostics: [
            {
              severity: "warning" as const,
              code: "component.create.noSelection",
              message: "Select the nodes to save as a component first.",
            },
          ],
          output: { open: false },
        };
      }
      if (context.dryRun) return { status: "validated" as const, revision, output: { open: false } };
      holder.current(nodeIds);
      return { status: "applied" as const, revision, output: { open: true } };
    },
    rejectionOutput: () => ({ open: false }),
  });

  return holder;
}
