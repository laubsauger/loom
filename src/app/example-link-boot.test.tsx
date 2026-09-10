// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import { starterPreferenceStore } from "@editor/inspect/index.ts";
import { exampleLinkUrl, listExampleProjects } from "@editor/library/index.ts";
import { serializeProjectDocument } from "@domain/project/index.ts";
import type { SnapshotMeta, SnapshotRecord, SnapshotStore } from "@domain/project/index.ts";
import type { ProjectDocument } from "@domain/types/graph.ts";
import { App } from "./app.tsx";
import type { AppRuntime } from "./app-runtime.ts";
import { newProjectDocument, PROJECT_STORAGE_KEY } from "./app-runtime.ts";
import { consumeExampleLink, currentExampleLink } from "./example-link-boot.ts";
import type { AddressBar } from "./example-link-boot.ts";
import { isolationReloadPending } from "./cross-origin-isolation.ts";
import type { GpuStatus } from "./gpu-status.ts";

/**
 * A LINK SOMEBODY SENT YOU (T1278).
 *
 * The owner's ask: *"did we implement linking to examples yet so that ui can send a link
 * to one and it will open a new file with that for whomever opens that?"* The person who
 * matters in every case below is the RECIPIENT — they did not choose this app's state,
 * they cannot see what the sender meant, and the only evidence they have that the link
 * worked is the document in front of them. So every assertion is about that document, or
 * about a sentence the recipient can read when there isn't one.
 *
 * The four ways this can go wrong, and one test each:
 *
 *  1. the link opens something PLAUSIBLE BUT WRONG — the starter — and nobody can tell;
 *  2. the link lands on top of work and destroys it;
 *  3. the link is eaten by the hosted build's one-time isolation reload (T1048);
 *  4. the link sticks, and every later refresh reopens somebody else's example forever.
 *
 * `starter-boot.test.tsx` is the neighbour: it owns the ladder this row inserts rule zero
 * at the top of, including the autosave rule that a link is now allowed to outrank.
 */

beforeAll(() => {
  installDomStubs();
  installFlowStubs();
});

const NO_GPU: GpuStatus = { kind: "unavailable", reason: "No WebGPU in this environment." };

/** A fixed project id, so a seeded snapshot lands in the slot the boot will look in. */
const PROJECT_ID = "project-example-link-test";

/**
 * The example the links here point at, and what "it is on screen" looks like.
 *
 * Deliberately NOT the starter (E6 — checker/noise/level/transform/displace/output): every
 * case below has to be able to tell "the link worked" apart from "the boot fell through to
 * the starter", which is failure 1 and the whole reason the unknown case exists.
 */
const LINKED_FILE = "E11-Gradient-Remap.loom.json";
const LINKED_NAME = "E11 Gradient Remap";
const LINKED_NODE_TYPES = ["lookup", "noise", "output", "ramp"];

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(PROJECT_STORAGE_KEY, PROJECT_ID);
  starterPreferenceStore().set(true);
  // Every case starts from an address with no link in it; the ones that need one say so.
  history.replaceState(null, "", "/");
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  history.replaceState(null, "", "/");
});

/**
 * Puts a link in the address bar the way the copy action would have written it.
 *
 * Built through `exampleLinkUrl` rather than typed out, so this file cannot quietly test a
 * URL shape the pane does not produce — the producer and the boot meet here.
 */
function arriveByLink(fileName: string): void {
  const url = new URL(exampleLinkUrl(fileName, location.origin, "/"));
  history.replaceState(null, "", `${url.pathname}${url.search}`);
}

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

function nodeTypesOf(runtime: AppRuntime | null): string[] {
  if (runtime === null) return [];
  return Object.values(runtime.bus.store.getGraph().nodes).map((node) => node.type);
}

/** Mounts the app the way `main.tsx` does — the only spelling a link acts on. */
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
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return {
    runtime: () => live as AppRuntime | null,
    nodeTypes: () => nodeTypesOf(live as AppRuntime | null),
  };
}

describe("a link opens the example it names, in a document of the recipient's own", () => {
  it("boots the named example rather than the starter", async () => {
    arriveByLink(LINKED_FILE);
    const { store } = memorySnapshotStore();
    const app = await mountApp(store);

    await waitFor(() => {
      expect(app.runtime()).not.toBeNull();
    });
    // The DOCUMENT, node for node. The starter would be six other types.
    expect([...app.nodeTypes()].sort()).toEqual([...LINKED_NODE_TYPES].sort());
    expect(app.nodeTypes()).not.toContain("checker");
  });

  it("opens it into THIS browser's own project slot, not the example's", async () => {
    /*
     * "opens a new file with that for whomever opens that" — the recipient gets a document
     * of their own, not a shared identity with the sender. The shipped file carries
     * `example-e11-gradient-remap`; unstamped, every edit the recipient made would be
     * autosaved into a slot no boot of theirs ever reads.
     */
    arriveByLink(LINKED_FILE);
    const { store, puts } = memorySnapshotStore();
    const app = await mountApp(store);

    await waitFor(() => {
      expect(app.runtime()).not.toBeNull();
    });
    expect(app.runtime()?.invocation.projectId).toBe(PROJECT_ID);
    // …and it is untitled work in progress, not yet theirs: a link nobody edited commits
    // nothing, exactly as a starter nobody edited commits nothing.
    expect(puts).toEqual([]);
  });

  it("takes the bare id somebody truncated the link down to", async () => {
    history.replaceState(null, "", "/?example=E11");
    const { store } = memorySnapshotStore();
    const app = await mountApp(store);

    await waitFor(() => {
      expect(app.runtime()).not.toBeNull();
    });
    expect([...app.nodeTypes()].sort()).toEqual([...LINKED_NODE_TYPES].sort());
  });
});

describe("a link that names nothing this build ships fails LOUDLY", () => {
  it("says so, and does not hand the recipient the starter instead", async () => {
    /*
     * FAILURE 1, and the reason this row exists at all. A silent fall-through gives the
     * recipient a document that looks like a real answer, with nothing anywhere to suggest
     * the link they were sent did not work — they would go on to discuss the wrong graph.
     */
    history.replaceState(null, "", "/?example=E999-Not-Shipped");
    const { store } = memorySnapshotStore();
    const app = await mountApp(store);

    // Loud: the strip names what was asked for, so the sender can be told what to fix.
    const notice = await screen.findByText(/does not ship/i);
    expect(notice.textContent).toContain("E999-Not-Shipped");

    // And nothing was opened. `onRuntimeChange` fires on every document swap, so a null
    // runtime here IS "the empty boot document is still what is on screen".
    expect(app.runtime()).toBeNull();
    expect(app.nodeTypes()).toEqual([]);
  });

  it("refuses a name that is merely close, rather than opening the nearest thing", async () => {
    history.replaceState(null, "", "/?example=Gradient");
    const { store } = memorySnapshotStore();
    const app = await mountApp(store);

    expect(await screen.findByText(/does not ship/i)).toBeDefined();
    expect(app.runtime()).toBeNull();
  });

  it("boots normally when the link names nothing at all", async () => {
    // `?example=` is a truncation, not a wrong name: there is no name to report and no
    // reason to refuse the boot. The starter is the honest answer to a first visit.
    history.replaceState(null, "", "/?example=");
    const { store } = memorySnapshotStore();
    const app = await mountApp(store);

    await waitFor(() => {
      expect(app.runtime()).not.toBeNull();
    });
    expect(app.nodeTypes()).toContain("checker");
    expect(screen.queryByText(/does not ship/i)).toBeNull();
  });
});

describe("a link outranks an autosave — and costs it nothing (rule zero)", () => {
  it("opens the linked example over a boot that had a snapshot waiting", async () => {
    /*
     * The one real product decision in T1278. Every other rule in `use-starter-project.ts`
     * ranks THIS browser's own history; a link is somebody else's explicit request,
     * clicked a second ago. Ranking it under an autosave means the person who was sent a
     * link gets whatever they happened to have open, with no sign a link was involved.
     */
    const { store } = memorySnapshotStore([snapshotOf(autosavedWork(PROJECT_ID))]);
    arriveByLink(LINKED_FILE);
    const app = await mountApp(store);

    await waitFor(() => {
      expect(app.runtime()).not.toBeNull();
    });
    expect([...app.nodeTypes()].sort()).toEqual([...LINKED_NODE_TYPES].sort());
  });

  it("still offers the autosave, so outranking it loses nobody anything", async () => {
    /*
     * THE GATE that makes the ordering above defensible rather than merely decided. The
     * autosave is OFFERED, never consumed: opening the link rebuilds the runtime, the
     * launch lookup runs again for the same project id, and the restore notice comes back
     * over the linked example. If this goes red, a link has started costing people work
     * and rule zero is wrong.
     */
    const { store, puts, records } = memorySnapshotStore([snapshotOf(autosavedWork(PROJECT_ID))]);
    const before = records.size;
    arriveByLink(LINKED_FILE);
    const app = await mountApp(store);

    await waitFor(() => {
      expect(app.runtime()).not.toBeNull();
    });
    expect(await screen.findByText(/is newer than what is open/i)).toBeDefined();
    // Their snapshot is exactly where it was — nothing overwritten, nothing deleted.
    expect(puts).toEqual([]);
    expect(records.size).toBe(before);

    // And the offer works: restoring puts their evening back on screen.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    });
    await waitFor(() => {
      expect(nodeTypesOf(app.runtime())).toEqual(["solid"]);
    });
  });
});

describe("a link over unsaved work ASKS first (§V93)", () => {
  /**
   * The library's `choose()` has applied this rule to a click since T189 and the boot path
   * had no equivalent. It matters more here, not less: the person about to lose an hour
   * did not click anything — somebody sent them a URL.
   *
   * The work has to exist BEFORE the boot decision fires, which is why the lookup is held
   * open: it lands on an IndexedDB round trip, and the app is fully usable meanwhile.
   */
  async function bootOverUnsavedWork() {
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

    arriveByLink(LINKED_FILE);
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

    // Real work, made the way a user makes it: a node from the node library, which runs
    // the add through the bus. The boot document is now dirty and is still the boot one.
    const library = screen.getByRole("region", { name: "generator" });
    await act(async () => {
      fireEvent.click(within(library).getByText("Noise"), { detail: 1 });
    });

    await act(async () => {
      releaseLookup();
      await gate;
      await Promise.resolve();
      await Promise.resolve();
    });
    return { runtime: () => live as AppRuntime | null };
  }

  it("does not replace unsaved work behind the user's back", async () => {
    const app = await bootOverUnsavedWork();

    // The question, naming the example so the answer is informed.
    const notice = await screen.findByText(/wants to open the example/i);
    expect(notice.textContent).toContain(LINKED_NAME);
    /*
     * …and nothing has been opened. `onRuntimeChange` fires on every document swap, so a
     * null runtime here IS "the node they just added is still the document on screen".
     */
    expect(app.runtime()).toBeNull();
    // A question, with both answers reachable — not a warning they can only watch.
    expect(screen.getByRole("button", { name: "Open example" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Keep my work" })).toBeDefined();
  });

  it("opens the example when they say so", async () => {
    const app = await bootOverUnsavedWork();
    await screen.findByText(/wants to open the example/i);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open example" }));
    });
    await waitFor(() => {
      expect(app.runtime()).not.toBeNull();
    });
    expect([...nodeTypesOf(app.runtime())].sort()).toEqual([...LINKED_NODE_TYPES].sort());
  });

  it("keeps their work when they decline, and stops asking", async () => {
    const app = await bootOverUnsavedWork();
    await screen.findByText(/wants to open the example/i);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Keep my work" }));
    });
    expect(screen.queryByText(/wants to open the example/i)).toBeNull();
    expect(app.runtime()).toBeNull();
  });
});

describe("the link does not outlive the visit it arrived on", () => {
  it("is gone from the address bar once the boot has answered it", async () => {
    arriveByLink(LINKED_FILE);
    const { store } = memorySnapshotStore();
    const app = await mountApp(store);

    await waitFor(() => {
      expect(app.runtime()).not.toBeNull();
    });
    // FAILURE 4: a link that stays in the URL turns every later refresh into somebody
    // else's example, forever.
    expect(location.search).toBe("");
    expect(currentExampleLink()).toBeNull();
  });

  it("is stripped even while the confirmation is still on screen", async () => {
    // A refresh mid-question is a refusal to answer it, and should get the ordinary boot
    // rather than the same question again on every load.
    history.replaceState(null, "", "/?example=E999-Not-Shipped");
    const { store } = memorySnapshotStore();
    await mountApp(store);

    await screen.findByText(/does not ship/i);
    expect(location.search).toBe("");
  });

  it("a refresh without the param does NOT reopen it (no `rememberExample`)", async () => {
    /*
     * `last-opened.ts` records what THIS PERSON opened on purpose so a refresh returns
     * them to it. A link is somebody else's choice arriving once; writing it there would
     * reopen a document the recipient never picked on every future boot — T1164's
     * complaint in a new hat. Following a link deliberately writes nothing.
     */
    arriveByLink(LINKED_FILE);
    const { store } = memorySnapshotStore();
    const first = await mountApp(store);
    await waitFor(() => {
      expect(first.runtime()).not.toBeNull();
    });
    cleanup();

    // Same browser, same localStorage, no link. A first visit, so: the starter.
    history.replaceState(null, "", "/");
    const second = await mountApp(store);
    await waitFor(() => {
      expect(second.runtime()).not.toBeNull();
    });
    expect(second.nodeTypes()).toContain("checker");
    expect(second.nodeTypes()).not.toContain("lookup");
  });
});

/** A stand-in address bar, so a whole link lifecycle needs no navigation. */
function fakeAddress(initial: string): AddressBar {
  let href = initial;
  return {
    get href() {
      return href;
    },
    get search() {
      return new URL(href).search;
    },
    replace(next: string) {
      href = next;
    },
  };
}

describe("the one-time isolation reload does not eat the link (T1048)", () => {
  it("leaves the link in place while the reload is still coming, and strips it after", () => {
    /*
     * FAILURE 3. On the first hosted visit the COI service worker registers and calls
     * `location.reload()`. The reload PRESERVES the query — so leaving the link alone is
     * exactly what carries it across — but a boot that had already `replaceState`d it away
     * would come back with no link and hand the recipient the starter: failure 1, arrived
     * at by a different road, and only on the hosted build nobody can reproduce locally.
     */
    const address = fakeAddress("https://host.example/loom/?example=E11-Gradient-Remap");

    expect(consumeExampleLink(address, () => true)).toBe(false);
    // …the reload fires here, and the load after it reads the same address.
    expect(currentExampleLink(address)).toBe("E11-Gradient-Remap");

    // Once the reload window has closed — isolated, or given up — it is consumed normally.
    expect(consumeExampleLink(address, () => false)).toBe(true);
    expect(currentExampleLink(address)).toBeNull();
    expect(address.href).toBe("https://host.example/loom/");
  });

  it("asks the isolation decision itself, rather than a flag somebody has to set", () => {
    /*
     * The wiring, not the mechanism: `app.tsx` calls `consumeExampleLink()` with no
     * arguments, so the default IS the product behaviour. A dev build never reloads, so it
     * strips immediately — which is also why every case above sees an empty query.
     */
    expect(isolationReloadPending()).toBe(false);
    const address = fakeAddress("https://host.example/?example=E11-Gradient-Remap");
    expect(consumeExampleLink(address)).toBe(true);
  });

  it("reports honestly when there was no link to consume", () => {
    expect(consumeExampleLink(fakeAddress("https://host.example/loom/"), () => false)).toBe(false);
  });
});

describe("the catalogue a link is resolved against is the shipped one", () => {
  it("ships the example every case here links to", () => {
    // Guards the fixture rather than the feature: if E11 is ever renamed or dropped, this
    // says so in one line instead of eleven confusing failures.
    expect(listExampleProjects().map((entry) => entry.fileName)).toContain(LINKED_FILE);
  });
});
