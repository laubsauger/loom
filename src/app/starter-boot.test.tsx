// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import { starterPreferenceStore } from "@editor/inspect/index.ts";
import { newProjectDocument } from "./app-runtime.ts";
import { serializeProjectDocument } from "@domain/project/index.ts";
import type { SnapshotMeta, SnapshotRecord, SnapshotStore } from "@domain/project/index.ts";
import type { ProjectDocument } from "@domain/types/graph.ts";
import { App } from "./app.tsx";
import type { AppRuntime } from "./app-runtime.ts";
import type { GpuStatus } from "./gpu-status.ts";
import { PROJECT_STORAGE_KEY } from "./app-runtime.ts";
import { STARTER_EXAMPLE_FILE, starterProjectText } from "./use-starter-project.ts";

/**
 * THE STARTER NETWORK AND THE AUTOSAVE IT MUST NEVER TOUCH (owner request).
 *
 * The feature is small — a boot with nothing to restore opens a tiny shipped example so
 * the first thing anybody sees is moving. The DANGER is not small, and it is the whole
 * subject of this file:
 *
 *   1. a starter that loads over an existing autosave destroys real work;
 *   2. a starter that autosaves ITSELF becomes the user's document, which silently kills
 *      the preference (an autosave now exists on every boot forever) and starts offering
 *      people a "restore" of a file they never authored.
 *
 * So the assertions are about the DOCUMENT ON SCREEN after each kind of boot and about
 * what reached the snapshot store, never about whether a loader was called. `mountApp`
 * renders the bare `<App />` — no runtime prop — because that is the only spelling the
 * product uses (`main.tsx`) and the only one the starter acts on.
 */

beforeAll(() => {
  installDomStubs();
  installFlowStubs();
});

const NO_GPU: GpuStatus = { kind: "unavailable", reason: "No WebGPU in this environment." };

/** A fixed project id, so a seeded snapshot lands in the slot the boot will look in. */
const PROJECT_ID = "project-starter-boot-test";

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(PROJECT_STORAGE_KEY, PROJECT_ID);
  // The preference is a per-person singleton over `localStorage`; put it back to its
  // shipped default before each case rather than assuming the previous one left it there.
  starterPreferenceStore().set(true);
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

/** A `SnapshotStore` over a Map, with every `put` recorded. */
function memorySnapshotStore(seedRecords: SnapshotRecord[] = []) {
  const records = new Map<string, SnapshotRecord>(
    seedRecords.map((record) => [`${record.projectId}/${record.key}`, record]),
  );
  const puts: SnapshotRecord[] = [];
  const store: SnapshotStore = {
    async list(projectId: string): Promise<SnapshotMeta[]> {
      return [...records.values()]
        .filter((record) => record.projectId === projectId)
        .map(({ key, revision, savedAt, pinned }) => ({ key, revision, savedAt, pinned }));
    },
    async get(projectId: string, key: string): Promise<SnapshotRecord | undefined> {
      return records.get(`${projectId}/${key}`);
    },
    async put(record: SnapshotRecord): Promise<void> {
      puts.push(record);
      records.set(`${record.projectId}/${record.key}`, record);
    },
    async delete(projectId: string, key: string): Promise<void> {
      records.delete(`${projectId}/${key}`);
    },
  };
  return { store, puts, records };
}

/** Somebody's real work, as an autosave snapshot would hold it. */
function autosavedWork(projectId: string): ProjectDocument {
  return {
    ...newProjectDocument(projectId),
    name: "an evening of real work",
    graph: {
      revision: 12,
      nodes: {
        theirNode: {
          id: "theirNode",
          type: "solid",
          definitionVersion: 1,
          position: { x: 10, y: 20 },
          parameters: {},
        },
      },
      edges: {},
      groups: {},
    },
  };
}

function snapshotOf(document: ProjectDocument): SnapshotRecord {
  return {
    key: `1-r${document.graph.revision}`,
    projectId: document.projectId,
    revision: document.graph.revision,
    savedAt: 1,
    pinned: false,
    body: serializeProjectDocument(document),
  };
}

/**
 * Mounts the app the way the product does and reports the runtime that is LIVE when the
 * dust settles — the boot one, or whatever replaced it.
 */
async function mountApp(store: SnapshotStore | undefined) {
  let live: AppRuntime | null = null;
  await act(async () => {
    render(
      <App
        storage={createMemoryStorage()}
        gpuProbe={() => Promise.resolve(NO_GPU)}
        createSnapshotStore={() => store}
        onRuntimeChange={(next) => {
          live = next;
        }}
      />,
    );
  });
  // The starter decision waits on an IndexedDB round trip, so it lands a turn or two
  // after mount. Settle those turns rather than asserting into a race.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return {
    runtime: () => live as AppRuntime | null,
    nodeTypes: (): string[] => {
      const runtime = live as AppRuntime | null;
      if (runtime === null) return [];
      return Object.values(runtime.bus.store.getGraph().nodes).map((node) => node.type);
    },
  };
}

/**
 * Long enough for a queued autosave to have LANDED.
 *
 * `createAutosave`'s debounce is 2 s, and a shorter wait makes "nothing was written" a
 * statement about the clock rather than about the app — measured: with a deliberate
 * boot-time `notifyChange()` spliced in, a 60 ms wait still saw an empty store. Real time
 * rather than fake timers because the decision this file is about rides on an IndexedDB
 * promise as well as a timer, and faking only one half proves the wrong thing.
 */
const PAST_AUTOSAVE_DEBOUNCE_MS = 2_400;

async function settleAutosave(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, PAST_AUTOSAVE_DEBOUNCE_MS));
  });
}

function nodeTypesOf(runtime: AppRuntime): string[] {
  return Object.values(runtime.bus.store.getGraph().nodes).map((node) => node.type);
}

/** The node types E6 is made of — what "the starter is on screen" actually looks like. */
const STARTER_NODE_TYPES = ["checker", "noise", "level", "transform", "displace", "output"];

describe("first boot: something is happening (owner request)", () => {
  it("opens the starter network when there is nothing to restore", async () => {
    const { store } = memorySnapshotStore();
    const app = await mountApp(store);

    await waitFor(() => {
      expect(app.runtime()).not.toBeNull();
    });
    // The DOCUMENT, not the fact that a loader ran: six nodes, and the ones E6 is built
    // from. An empty canvas would have none.
    expect([...app.nodeTypes()].sort()).toEqual([...STARTER_NODE_TYPES].sort());
  });

  it("keeps the starter in the SAME autosave slot the rest of the app uses", async () => {
    const { store } = memorySnapshotStore();
    const app = await mountApp(store);

    await waitFor(() => {
      expect(app.runtime()).not.toBeNull();
    });
    /*
     * The shipped file carries `example-displacement-stack` as its project id, and the
     * snapshot ring is keyed by project id while the launch lookup asks for the
     * browser-local one. Left unstamped, every edit the user makes to the starter would
     * be autosaved into a slot no boot ever reads: drag a slider for ten minutes, reload,
     * and the work is gone with nothing even offering it back.
     */
    expect(app.runtime()?.invocation.projectId).toBe(PROJECT_ID);
  });

  it("costs no permission prompt and no download — the file is in the bundle already", () => {
    const starter = starterProjectText(PROJECT_ID);
    expect(starter, `${STARTER_EXAMPLE_FILE} must be in the shipped catalogue`).not.toBeNull();
    /*
     * A first boot may not open a browser permission dialog or start a fetch. These are
     * the node types that would cause one, and the assertion is against the STARTER'S OWN
     * GRAPH rather than against a promise in a docblock — swapping the starter for an
     * example with a webcam in it fails here.
     */
    const gated = new Set([
      "webcam",
      "audioFileIn",
      "audioDeviceIn",
      "channelIn",
      "movieFileIn",
      "depth",
      "inference",
      "personMask",
      "midiIn",
      "osc",
    ]);
    const parsed = JSON.parse(starter!.text) as { graph: { nodes: Record<string, { type: string }> } };
    const types = Object.values(parsed.graph.nodes).map((node) => node.type);
    expect(types.filter((type) => gated.has(type))).toEqual([]);
    // And it is small enough to read at a glance, which is the other half of the ask.
    expect(types.length).toBeLessThanOrEqual(8);
  });
});

/**
 * THE GATE (rule 1). Everything else here is behaviour; this is the one that must not be
 * able to regress, because the failure it describes costs somebody a project.
 */
describe("an existing autosave ALWAYS wins", () => {
  it("does not load the starter over work that is waiting to be restored", async () => {
    const work = autosavedWork(PROJECT_ID);
    const { store } = memorySnapshotStore([snapshotOf(work)]);
    const app = await mountApp(store);

    // The restore prompt is on screen, offering their document…
    expect(await screen.findByText(/is newer than what is open/i)).toBeDefined();

    // …and nothing was opened over it. `onRuntimeChange` fires on every document swap, so
    // a null runtime here IS "the boot document is still the one that is open", and the
    // boot document is empty.
    expect(app.runtime()).toBeNull();
  });

  it("still refuses the starter when the user asked for one but there is work to restore", async () => {
    starterPreferenceStore().set(true);
    const { store } = memorySnapshotStore([snapshotOf(autosavedWork(PROJECT_ID))]);
    const app = await mountApp(store);

    expect(await screen.findByText(/is newer than what is open/i)).toBeDefined();
    // The preference chooses between a starter and an empty canvas. It is never allowed
    // to choose between a starter and the user's project.
    expect(app.nodeTypes()).toEqual([]);
  });
});

describe("the starter never lands on a document somebody chose", () => {
  it("stands down when a project is opened while the launch lookup is still in flight", async () => {
    /*
     * The window is real: the lookup is an IndexedDB round trip and the app is usable the
     * whole time it runs. `e2e/node-box.spec.ts` navigates and opens an example in the
     * same breath and hit exactly this — the starter arrived a beat later and replaced the
     * example it had just loaded.
     *
     * A store whose `list` never settles holds the boot open so the race is deterministic
     * rather than a matter of who wins today.
     */
    let releaseLookup = (): void => {};
    const gate = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    const store: SnapshotStore = {
      async list(): Promise<SnapshotMeta[]> {
        await gate;
        return [];
      },
      async get() {
        return undefined;
      },
      async put() {},
      async delete() {},
    };

    let live: AppRuntime | null = null;
    await act(async () => {
      render(
        <App
          storage={createMemoryStorage()}
          gpuProbe={() => Promise.resolve(NO_GPU)}
          createSnapshotStore={() => store}
          onRuntimeChange={(next) => {
            live = next;
          }}
        />,
      );
    });
    expect(live as AppRuntime | null, "nothing has replaced the boot document yet").toBeNull();

    /*
     * The real door: the examples tab is the bottom dock's first and open tab now, and its
     * rows execute `project.open` on the bus (§V29, §V88). A hand-rolled adopt here would
     * be testing a path the product does not have.
     */
    const chosen = "E3 Animated Noise Field";
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${chosen}`) }));
    });
    await waitFor(() => {
      expect(live as AppRuntime | null, "the example should have replaced the runtime").not.toBeNull();
    });
    const afterOpen = new Set(nodeTypesOf(live as unknown as AppRuntime));

    // NOW let the lookup answer "nothing to restore". The starter must stand down.
    await act(async () => {
      releaseLookup();
      await gate;
    });
    await settleAutosave();

    // Still the example they chose, node for node — not E6 on top of it.
    expect(new Set(nodeTypesOf(live as unknown as AppRuntime))).toEqual(afterOpen);
    expect(nodeTypesOf(live as unknown as AppRuntime)).not.toContain("checker");
  });
});

describe("the starter does not become the user's document", () => {
  it("writes NOTHING to the snapshot store on a boot nobody touched", async () => {
    const { store, puts } = memorySnapshotStore();
    const app = await mountApp(store);

    await waitFor(() => {
      expect(app.runtime()).not.toBeNull();
    });
    // Give the autosave debounce every chance to fire: it is 2 s, and a fake clock would
    // only prove the timer was not set rather than that nothing was queued.
    await settleAutosave();

    /*
     * This is the property the whole design rests on. `GraphStore` takes its graph at
     * CONSTRUCTION and autosave writes only from a committed mutation, so a starter
     * nobody edited leaves no trace — which is what keeps the NEXT boot's lookup empty,
     * keeps the preference meaningful, and keeps the restore prompt from offering a
     * document the user never authored.
     *
     * If this ever goes red, something now commits during boot, and the starter is on its
     * way into the snapshot ring.
     */
    expect(puts, "a pristine starter must leave no snapshot behind").toEqual([]);
  });

  it("autosaves normally the moment the user edits it", async () => {
    const { store, puts } = memorySnapshotStore();
    const app = await mountApp(store);

    await waitFor(() => {
      expect(app.runtime()).not.toBeNull();
    });
    const runtime = app.runtime()!;

    await act(async () => {
      await runtime.bus.execute(
        "graph.applyPatch",
        {
          baseRevision: runtime.bus.store.getRevision(),
          operations: [{ op: "addNode", ref: "$n", type: "solid", position: { x: 0, y: 0 } }],
          label: "the user does something",
        },
        runtime.invocation,
      );
    });

    await waitFor(
      () => {
        expect(puts.length).toBeGreaterThan(0);
      },
      { timeout: 4000 },
    );
    // Their edited starter, in the slot the next boot reads. It is their document now.
    expect(puts.at(-1)?.projectId).toBe(PROJECT_ID);
  });
});

describe("the preference (persisted, per person, not in the .loom.json)", () => {
  it("boots to an empty canvas when it is off and there is nothing to restore", async () => {
    starterPreferenceStore().set(false);
    const { store, puts } = memorySnapshotStore();
    const app = await mountApp(store);

    await settleAutosave();
    expect(app.runtime()).toBeNull();
    expect(puts).toEqual([]);
  });

  it("boots to the restore prompt when it is off and an autosave exists", async () => {
    starterPreferenceStore().set(false);
    const { store } = memorySnapshotStore([snapshotOf(autosavedWork(PROJECT_ID))]);
    const app = await mountApp(store);

    expect(await screen.findByText(/is newer than what is open/i)).toBeDefined();
    expect(app.runtime()).toBeNull();
  });
});

describe("File → New means an empty canvas, and it stays empty", () => {
  it("does not reinstall the starter under a user who asked for nothing", async () => {
    const { store } = memorySnapshotStore();
    const app = await mountApp(store);

    await waitFor(() => {
      expect(app.runtime()).not.toBeNull();
    });
    const started = app.runtime()!;

    /*
     * No confirmation is expected, and that is an assertion in itself: nobody has edited
     * the starter, so there is nothing to lose and §V165 has nothing to ask about. Before
     * `document-dirty.ts` was rekeyed to the bus, this call sat on an unsaved-changes
     * dialog forever, because every shipped example carries `graph.revision: 1` and the
     * baseline was still the empty document's 0.
     */
    await act(async () => {
      await started.bus.execute("project.new", {}, started.invocation);
    });
    // The user-visible half of the same fact: no dialog was raised, so nothing asked them
    // to save a document they had not written a line of.
    expect(screen.queryByText(/unsaved/i)).toBeNull();
    // `project.new` builds a fresh runtime, which re-runs the launch lookup. A per-runtime
    // decision would answer "nothing to restore" again and put the starter straight back.
    await settleAutosave();

    expect(app.nodeTypes()).toEqual([]);
  });
});
