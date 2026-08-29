import { createDomainBus } from "@domain/commands/index.ts";
import type { ShaderloomBus } from "@domain/commands/bus.ts";
import type { Actor, InvocationContext } from "@domain/types/commands.ts";
import type { ProjectSettings } from "@domain/types/graph.ts";
import { createNodeRuntimeStore } from "@editor/graph-canvas/index.ts";
import type { NodeRuntimeStore } from "@editor/graph-canvas/index.ts";
import { spikeNodeDefinitions } from "@nodes/definitions/index.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";
import type { LayoutStorage } from "./layout-storage.ts";
import { defaultLayoutStorage } from "./layout-storage.ts";

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
  /** Status / GPU-ms / agent-activity channel. Never the document store (§V16). */
  readonly nodeRuntime: NodeRuntimeStore;
  /** Actor + project identity stamped on every command (§V30). Stable per browser. */
  readonly invocation: InvocationContext;
  readonly settings: ProjectSettings;
  dispose(): void;
}

/** Project defaults until T43 loads a real `.loom.json`. */
export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  outputResolution: { width: 1280, height: 720 },
  workingFormat: "rgba16float",
  randomSeed: 1,
  previewLongEdge: 192,
  previewFps: 20,
  limits: {
    maxResolution: 4096,
    maxDispatch: 65_535,
    maxBufferBytes: 268_435_456,
    memoryBudgetBytes: 1_073_741_824,
  },
};

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
}

export function createAppRuntime(options: AppRuntimeOptions = {}): AppRuntime {
  const storage = options.identityStorage === undefined ? defaultLayoutStorage() : options.identityStorage;

  const registry = createNodeRegistry(spikeNodeDefinitions).view();
  const { bus } = createDomainBus({ registry });
  const nodeRuntime = createNodeRuntimeStore();

  const actor: Actor = options.actor ?? {
    kind: "human",
    id: stableLocalId(ACTOR_STORAGE_KEY, "human", storage),
    label: "You",
  };

  const invocation: InvocationContext = {
    actor,
    projectId: stableLocalId(PROJECT_STORAGE_KEY, "project", storage),
    // §V38/§V67: nothing here self-grants. Side-effect capabilities arrive from the
    // bus-owned grant store (T90) once it exists, never from the caller's own context.
    capabilities: [],
  };

  return {
    bus,
    registry,
    nodeRuntime,
    invocation,
    settings: options.settings ?? DEFAULT_PROJECT_SETTINGS,
    dispose() {
      nodeRuntime.dispose();
    },
  };
}
