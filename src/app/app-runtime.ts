import { createDomainBus } from "@domain/commands/index.ts";
import type { ShaderloomBus } from "@domain/commands/bus.ts";
import type { Actor, InvocationContext } from "@domain/types/commands.ts";
import { DEFAULT_PROJECT_SETTINGS } from "@domain/types/graph.ts";
import type { GraphDocument, ProjectDocument, ProjectSettings } from "@domain/types/graph.ts";
import { SCHEMA_VERSION } from "@domain/types/schemas.ts";
import type { UnknownParameter } from "@domain/project/index.ts";
import { createNodeRuntimeStore } from "@editor/graph-canvas/index.ts";
import type { NodeRuntimeStore } from "@editor/graph-canvas/index.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { createComponentSystem, registerComponentCommands } from "@domain/components/index.ts";
import { installStarterComponents } from "@editor/component/index.ts";
import type { StarterSetInstall } from "@editor/component/index.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";
import { createTelemetryHub } from "@runtime/telemetry/index.ts";
import type { TelemetryHub } from "@runtime/telemetry/index.ts";
import type { LayoutStorage } from "./layout-storage.ts";
import { defaultLayoutStorage } from "./layout-storage.ts";
import { registerProjectCommands } from "./project-commands.ts";

/**
 * Everything the app is made of, built once (T51).
 *
 * This module and `app.tsx` are the composition root: the only place that decides which
 * registry, which store, which bus and which identity the running application uses.
 * Nothing else constructs any of them, which is what makes §V29 checkable by reading one
 * file — there is exactly one bus, so there is exactly one mutation path.
 *
 * No React here on purpose: a headless caller (a test, a future offline renderer, an
 * agent adapter) gets the same object graph without mounting a tree.
 */

export interface AppRuntime {
  readonly bus: ShaderloomBus;
  readonly registry: NodeRegistryView;
  /** Component catalogue. Definitions live here, not in the GraphDocument. */
  readonly components: ReturnType<typeof createComponentSystem>["components"];
  /** Status / GPU-ms / agent-activity channel. Never the document store (§V16). */
  readonly nodeRuntime: NodeRuntimeStore;
  /**
   * The ONE metrics pipe (T41/T42, §V16). Built here so there is exactly one, sunk into
   * the canvas's existing per-node channel rather than standing up a second one, and
   * disposed with it. Nothing in this object writes a metric — producers push, the UI
   * samples at <= 10 Hz.
   */
  readonly telemetry: TelemetryHub;
  /** Actor + project identity stamped on every command (§V30). Stable per browser. */
  readonly invocation: InvocationContext;
  /**
   * Which DOCUMENT this runtime holds — the boundary a load crosses (T519, B106).
   *
   * Deliberately NOT `project.projectId`, and the difference is the whole point. A
   * project id names a FILE: reopening the same file, or opening a copy of it, yields
   * the same id while the runtime, the store, the plan and every GPU resource behind it
   * have been thrown away and rebuilt. This names the LOADED INSTANCE. It is minted in
   * the constructor, and `createAppRuntime` is the only way a project is ever opened
   * (`adoptDocument`/`startNewProject` in `app.tsx`; `GraphStore` has no `replace`), so
   * a load cannot happen without establishing a new one — the property is enforced by
   * where it is minted rather than by remembering to mint it (§V437).
   *
   * Opaque: compared for equality and never parsed. What consumes it is anything that
   * caches by NODE ID — the recompile classifier (`classify-revision.ts`), the preview
   * tile atlas, temporal history — because two documents share node ids as soon as they
   * share node names, and `out` is in every shipped example.
   */
  readonly documentIdentity: string;
  /**
   * The project's settings, LIVE (§V177, T272).
   *
   * A getter over the store, not a snapshot taken at construction. It used to be the
   * latter, which meant a project saved at 4K opened at 1280x720 until T139 fixed the
   * SOURCE — and left the shape that caused it: a value copied once cannot reflect an
   * edit made later, so `project.setSettings` would have written to the store while every
   * reader kept the old numbers.
   */
  readonly settings: ProjectSettings;
  /**
   * Everything about the open project EXCEPT its graph, which lives in the store. Set
   * from the loaded `.loom.json` (§V10) — not a fixed default — so a project's
   * resolution, seed and limits survive a round trip.
   */
  readonly project: Omit<ProjectDocument, "graph">;
  /**
   * Parameter values the open file carried that this build cannot interpret (§V68,
   * §V69). Reported by the loader, kept verbatim, and NEVER given a control to edit.
   */
  readonly unknownParameters: readonly UnknownParameter[];
  /**
   * The shipped starter components, installed at boot (T190, §V94, §V193).
   *
   * A field rather than a fire-and-forget call because a shipped file that fails to
   * install has to be SAYABLE. `component-sync.test.ts` gates the files, so a diagnostic
   * here means the build is broken — which is exactly when silence is worst (§V8).
   */
  readonly starterComponents: StarterSetInstall;
  /** The document as it would be saved right now: `project` plus the live graph. */
  projectDocument(): ProjectDocument;
  dispose(): void;
}

/**
 * Re-exported from the domain (T272): settings are document state and the STORE seeds
 * itself with them, so the value cannot live here. Kept as an export because every
 * existing caller imports it from the composition root.
 */
export { DEFAULT_PROJECT_SETTINGS };

export const ACTOR_STORAGE_KEY = "shaderloom.actor.id.v1";
export const PROJECT_STORAGE_KEY = "shaderloom.project.id.v1";

function randomId(prefix: string): string {
  const uuid =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${uuid}`;
}

/**
 * A stable local id, remembered across reloads.
 *
 * §V30 wants every mutation attributed, and §V41 keys undo history on the actor: an id
 * regenerated on every reload would make the audit log unreadable and, once collab
 * lands, would make one person look like a crowd. Storage being unavailable degrades to
 * a per-session id rather than to no id at all.
 */
export function stableLocalId(key: string, prefix: string, storage: LayoutStorage | null): string {
  if (storage === null) return randomId(prefix);
  try {
    const existing = storage.getItem(key);
    if (existing !== null && existing.trim() !== "") return existing;
    const minted = randomId(prefix);
    storage.setItem(key, minted);
    return minted;
  } catch {
    return randomId(prefix);
  }
}

export interface AppRuntimeOptions {
  /** Defaults to `localStorage`; `null` runs without persisted identity. */
  identityStorage?: LayoutStorage | null;
  settings?: ProjectSettings;
  /** Injectable for tests that want a deterministic actor. */
  actor?: Actor;
  /**
   * The project this runtime opens with. Opening a file rebuilds the runtime around the
   * loaded document rather than mutating one in place — see the note on `openDocument`
   * in `project-commands.ts` for why, and what `src/domain/commands` would need to make
   * that unnecessary.
   */
  document?: ProjectDocument;
  /** Values from a newer build, carried through untouched (§V68). */
  unknownParameters?: readonly UnknownParameter[];
}

/** A brand-new, empty project. The graph half lives in the store. */
export function newProjectDocument(projectId: string, settings = DEFAULT_PROJECT_SETTINGS): Omit<ProjectDocument, "graph"> {
  const stamp = new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    projectId,
    name: "untitled",
    settings,
    assets: [],
    createdAt: stamp,
    updatedAt: stamp,
  };
}

/**
 * The project half of the runtime.
 *
 * §T139: `AppRuntime.settings` used to be the fixed `DEFAULT_PROJECT_SETTINGS`, which
 * meant a project saved at 4K opened at 1280x720 and compiled against the wrong limits.
 * It comes from the loaded document now; the defaults are the NEW-project case only.
 */
function projectMetaFrom(options: AppRuntimeOptions, projectId: string): Omit<ProjectDocument, "graph"> {
  if (options.document === undefined) {
    return newProjectDocument(projectId, options.settings ?? DEFAULT_PROJECT_SETTINGS);
  }
  const { graph: _graph, ...rest } = options.document;
  return options.settings === undefined ? rest : { ...rest, settings: options.settings };
}

export function createAppRuntime(options: AppRuntimeOptions = {}): AppRuntime {
  const storage = options.identityStorage === undefined ? defaultLayoutStorage() : options.identityStorage;

  // The bus is given the COMPONENT-AWARE registry, not the raw node registry: a component
  // instance is an ordinary node whose type is `component:<id>@<version>`, and without the
  // wrapper every instance reads as an unknown node type. The wrapper composes over the
  // node registry rather than replacing it, so re-authoring a component changes every
  // linked instance with no cache to invalidate (§V79).
  // The whole catalogue, not just the three Phase 0 spike nodes — 20 TD-vocabulary
  // nodes plus Noise. This one import is what makes them reachable from the library.
  const nodeRegistry = createNodeRegistry(allNodeDefinitions).view();
  const { components, nodes: registry } = createComponentSystem(nodeRegistry);
  // Installed BEFORE the document's own library, so a project that carries its own copy
  // of a starter component (an older version, or an edited one) replaces the shipped one
  // rather than the other way round: an instance is pinned to the definition it was saved
  // against (§V84), and the document is the authority on that.
  const starterComponents = installStarterComponents(components);
  const initialGraph: GraphDocument | undefined = options.document?.graph;
  const initialSettings = options.settings ?? options.document?.settings ?? DEFAULT_PROJECT_SETTINGS;
  const { bus } = createDomainBus({
    registry,
    initialSettings,
    ...(initialGraph === undefined ? {} : { initialGraph }),
    // §V148: "copy reference" is only worth anything if the string can be pasted into an
    // expression field, which means it has to reach the system clipboard. Best effort —
    // the write is asynchronous and permission-gated, and a refusal costs the trip
    // through a text field, not the copy itself (the bus clipboard still holds it).
    clipboard: (text) => {
      void globalThis.navigator?.clipboard?.writeText(text).catch(() => undefined);
    },
  });
  registerComponentCommands(bus, { components });
  registerProjectCommands(bus);
  const nodeRuntime = createNodeRuntimeStore();

  // §V16: the hub sinks into the channel the canvas ALREADY owns. A second per-node
  // channel would mean two coalescers, two subscriptions per node and two answers to
  // "what is this node's gpu ms".
  const telemetry = createTelemetryHub({ sink: nodeRuntime });

  const actor: Actor = options.actor ?? {
    kind: "human",
    id: stableLocalId(ACTOR_STORAGE_KEY, "human", storage),
    label: "You",
  };

  /**
   * The person at the keyboard controls their own camera (T315, §V38).
   *
   * `setViewport` is capability-gated because another actor moving the viewport seizes
   * the screen of whoever is using the app. That gate would be a permanent wall rather
   * than a permission if nobody could ever hold the grant — nothing in the product
   * issues one today, the confirm flow that owns `bus.grants` being T90's unbuilt half —
   * so the composition root grants it to the human actor it just constructed. That is
   * not self-granting (§V67): the grant store's owner is issuing it, which is exactly
   * who §V38 says may, and the caller can still fabricate nothing.
   *
   * An AGENT is deliberately not granted it here. When the confirm flow lands, an agent
   * asking to frame the graph is a question a person can answer; until then it is
   * refused with the capability named, which the agent surface already reports as
   * `ungranted` per tool.
   */
  if (actor.kind === "human") bus.grants.grant(actor, "viewportControl");

  // An opened project brings its own id; otherwise the browser-local one keeps autosave
  // snapshots and audit attribution stable across reloads.
  const projectId = options.document?.projectId ?? stableLocalId(PROJECT_STORAGE_KEY, "project", storage);

  const invocation: InvocationContext = {
    actor,
    projectId,
    // §V38/§V67: nothing here self-grants. Side-effect capabilities arrive from the
    // bus-owned grant store (T90) once it exists, never from the caller's own context.
    capabilities: [],
  };

  const project = projectMetaFrom(options, projectId);

  return {
    bus,
    registry,
    components,
    nodeRuntime,
    telemetry,
    invocation,
    // T519: per CONSTRUCTION, not per project id — see `documentIdentity` above. Random
    // rather than a counter so two runtimes built in two windows cannot collide.
    documentIdentity: randomId("document"),
    get settings() {
      return bus.store.getSettings();
    },
    project,
    unknownParameters: options.unknownParameters ?? [],
    starterComponents,
    projectDocument() {
      // Settings come from the STORE: a save must write what the user last set, and
      // `project` holds the copy the document was opened with (§V177).
      return { ...project, settings: bus.store.getSettings(), graph: bus.store.getGraph() };
    },
    dispose() {
      telemetry.dispose();
      nodeRuntime.dispose();
    },
  };
}
