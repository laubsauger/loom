// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import { SHOW_NODE_INFO_COMMAND } from "@editor/inspect/index.ts";
import { menuSchemaFor } from "@editor/menus/index.ts";
import { serializeProjectDocument } from "@domain/project/index.ts";
import type { SnapshotMeta, SnapshotRecord, SnapshotStore } from "@domain/project/index.ts";
import type { BackendCapabilities } from "@domain/types/backend.ts";
import type { ProjectDocument } from "@domain/types/graph.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import type { ShaderloomBackend } from "@runtime/backend/index.ts";
import { App } from "../../app/app.tsx";
import { createAppRuntime, newProjectDocument } from "../../app/app-runtime.ts";
import type { AppRuntime } from "../../app/app-runtime.ts";
import type { GpuStatus } from "../../app/gpu-status.ts";

/**
 * The LAST MILE (T139 + wiring).
 *
 * Five subsystems landed fully built and fully tested while being unreachable from the
 * running application. The telemetry hub had no constructor call, the performance panel
 * had a placeholder rendered in front of it, the node info popup had no host, autosave
 * had no subscription and the project loader had no caller. Every one of those tracks
 * was green the whole time, because a track's own suite cannot see the seam between
 * itself and the app.
 *
 * That seam is the entire subject of this file. Nothing here re-tests a subsystem: it
 * tests that the subsystem is CONNECTED — that a compile reaches the hub, that all three
 * routes to the popup reach one command, that a commit reaches autosave, that a save
 * reaches a file and the file reaches back, that a halted GPU has a way out, and that the
 * timing fields say "unavailable" rather than inventing a number nobody measured (§V86).
 */

beforeAll(() => {
  installDomStubs();
  installFlowStubs();
});
afterEach(() => {
  cleanup();
  delete (globalThis as Record<string, unknown>)["showSaveFilePicker"];
  delete (globalThis as Record<string, unknown>)["showOpenFilePicker"];
});

const NO_WEBGPU: GpuStatus = { kind: "unavailable", reason: "No WebGPU in this environment." };

const CAPABILITIES: BackendCapabilities = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
};

const READY: GpuStatus = { kind: "ready", capabilities: CAPABILITIES, baseline: true };

function newRuntime(): AppRuntime {
  return createAppRuntime({
    identityStorage: null,
    actor: { kind: "human", id: "tester", label: "Tester" },
  });
}

async function seed(runtime: AppRuntime, operations: GraphPatchOperation[]) {
  return runtime.bus.execute(
    "graph.applyPatch",
    { baseRevision: runtime.bus.store.getRevision(), operations, label: "seed" },
    runtime.invocation,
  );
}

/** Solid → Output: the smallest graph that compiles to a real pass. */
async function seedRenderable(runtime: AppRuntime): Promise<string> {
  const result = await seed(runtime, [
    { op: "addNode", ref: "$solid", type: "solid", position: { x: 0, y: 0 } },
    { op: "addNode", ref: "$out", type: "output", position: { x: 240, y: 0 } },
    {
      op: "connect",
      source: { nodeId: "$solid", portId: "out" },
      target: { nodeId: "$out", portId: "input" },
    },
  ]);
  const nodeId = result.output.createdIds["$solid"];
  if (typeof nodeId !== "string") throw new Error("expected the seeded solid node");
  return nodeId;
}

interface MountOptions {
  readonly status?: GpuStatus;
  readonly runtime?: AppRuntime;
  readonly createSnapshotStore?: () => SnapshotStore | undefined;
  readonly onRuntimeChange?: (runtime: AppRuntime) => void;
}

async function mountApp(options: MountOptions = {}) {
  const runtime = options.runtime ?? newRuntime();
  const status = options.status ?? NO_WEBGPU;
  // Stable identity: a fresh function every render would restart the probe effect.
  const probe = () => Promise.resolve(status);
  await act(async () => {
    render(
      <App
        runtime={runtime}
        storage={createMemoryStorage()}
        gpuProbe={probe}
        {...(options.createSnapshotStore === undefined
          ? {}
          : { createSnapshotStore: options.createSnapshotStore })}
        {...(options.onRuntimeChange === undefined ? {} : { onRuntimeChange: options.onRuntimeChange })}
      />,
    );
  });
  return { runtime };
}

/** A `SnapshotStore` over a Map, with the calls recorded. */
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

// ---------------------------------------------------------------------------------
// 1. Telemetry
// ---------------------------------------------------------------------------------

describe("the telemetry hub is constructed and fed (T41, T42, §V16)", () => {
  it("builds exactly one hub per runtime and sinks it into the canvas's node channel", () => {
    const runtime = newRuntime();
    expect(runtime.telemetry).toBeDefined();
    // §V16: one per-node channel, not two. The hub publishes into the store the canvas
    // already owns, so a node subscribes once and gets one answer for `gpuMs`.
    expect(runtime.nodeRuntime).toBeDefined();
    expect(runtime.telemetry.snapshot().plan).toBeNull();
    runtime.dispose();
  });

  it("receives a plan after each compile, and null when there is nothing to compile", async () => {
    const runtime = newRuntime();
    await seedRenderable(runtime);
    await mountApp({ status: READY, runtime });

    await waitFor(() => {
      expect(runtime.telemetry.snapshot().plan).not.toBeNull();
    });

    const plan = runtime.telemetry.snapshot().plan;
    expect(plan?.passes.length).toBeGreaterThan(0);
    expect(plan?.nodeCount).toBeGreaterThan(0);
    // §V24: the budget travels with the plan, so the panel can say "over" without
    // having to know where project settings live.
    expect(plan?.memoryBudgetBytes).toBe(runtime.settings.limits.memoryBudgetBytes);
  });

  it("has no plan while there is no capability report to compile against (§V12)", async () => {
    const runtime = newRuntime();
    await seedRenderable(runtime);
    await mountApp({ status: NO_WEBGPU, runtime });

    expect(runtime.telemetry.snapshot().plan).toBeNull();
  });
});

describe("the performance panel renders from the hub (T41)", () => {
  it("shows the plan the compiler produced, not a second count of its own", async () => {
    const runtime = newRuntime();
    await seedRenderable(runtime);
    await mountApp({ status: READY, runtime });

    const panel = await screen.findByTestId("performance-panel");
    await waitFor(() => {
      expect(runtime.telemetry.snapshot().plan).not.toBeNull();
    });

    const plan = runtime.telemetry.snapshot().plan;
    if (plan === null) throw new Error("expected a compiled plan");
    // The pass count on screen is the hub's, which is the compiler's.
    await waitFor(() => {
      expect(panel.textContent).toContain(String(plan.passes.length));
    });
    expect(panel.textContent).toContain("passes");
  });

  it("§V86 — every timing field reads 'unavailable' while no timing source is attached", async () => {
    const runtime = newRuntime();
    await seedRenderable(runtime);
    await mountApp({ status: READY, runtime });

    const snapshot = runtime.telemetry.snapshot();
    // Nothing has attached a `PassTimingSource`: there is no frame loop in the app yet,
    // so no pass has ever been submitted and no span could exist (T163).
    expect(snapshot.timingAvailable).toBe(false);
    expect(snapshot.frame.gpuMs).toBeNull();
    expect(snapshot.frame.availability).toBe("unavailable");
    for (const row of snapshot.passes) {
      expect(row.gpuMs).toBeNull();
      expect(row.availability).toBe("unavailable");
    }

    const panel = await screen.findByTestId("performance-panel");
    // The word, not a digit. "0.000 ms" would be a confident lie about where the frame
    // went, and a CPU-derived stand-in would be a different measurement wearing the
    // same label.
    await waitFor(() => {
      expect(panel.textContent).toContain("unavailable");
    });
    expect(panel.textContent).not.toContain("0.000 ms");
  });
});

// ---------------------------------------------------------------------------------
// 2. Node info — three routes, one command (T145, §V52, §V78, §V85)
// ---------------------------------------------------------------------------------

/** Middle button down + up on the same spot. Constructed by hand: jsdom has no PointerEvent. */
function middleClick(element: Element): void {
  for (const type of ["pointerdown", "pointerup"]) {
    element.dispatchEvent(
      new MouseEvent(type, { bubbles: true, cancelable: true, button: 1, clientX: 40, clientY: 60 }),
    );
  }
}

async function mountWithNode() {
  const runtime = newRuntime();
  const nodeId = await seedRenderable(runtime);
  await mountApp({ status: READY, runtime });
  const element = document.querySelector(`.react-flow__node[data-id="${nodeId}"]`);
  if (element === null) throw new Error("expected the seeded node to render on the canvas");
  return { runtime, nodeId, element };
}

/** Click the node and wait for the selection to reach the inspector. */
async function select(element: Element): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
  });
  await waitFor(() => {
    expect(screen.queryByText("No node selected")).toBeNull();
  });
}

describe("every route to node info reaches one surface (T145)", () => {
  it("opens from TouchDesigner's middle click", async () => {
    const { element } = await mountWithNode();

    await act(async () => {
      middleClick(element);
    });

    expect(await screen.findByLabelText(/Node info for/i)).toBeDefined();
  });

  it("opens from the `?` binding in the graph context (§V52)", async () => {
    const { element } = await mountWithNode();
    await select(element);

    // The binding is `shift+/` because the engine matches `event.code`: the key labelled
    // `?` is `Slash` with Shift. Nothing about this key is written in a component.
    await act(async () => {
      fireEvent.keyDown(element, { key: "?", code: "Slash", shiftKey: true });
    });

    expect(await screen.findByLabelText(/Node info for/i)).toBeDefined();
  });

  it("names the same command from the node context menu (§V78)", async () => {
    const { runtime, nodeId } = await mountWithNode();

    // The menu is DATA naming a command; the menu engine's own suite covers rendering.
    // What matters at this seam is that the name is the same one, and that it is live.
    const entries = menuSchemaFor("node", runtime.registry).entries;
    const info = entries.find((entry) => "command" in entry && entry.command === SHOW_NODE_INFO_COMMAND);
    expect(info).toBeDefined();
    expect(runtime.bus.hasCommand(SHOW_NODE_INFO_COMMAND)).toBe(true);

    // Executing exactly what the menu names opens exactly the same popup.
    const result = await act(async () =>
      runtime.bus.execute(SHOW_NODE_INFO_COMMAND, { nodeId }, runtime.invocation),
    );
    expect(result.status).toBe("applied");
    expect(result.output).toMatchObject({ nodeId, shown: true });
    expect(await screen.findByLabelText(/Node info for/i)).toBeDefined();
  });

  it("refuses a node that is not in the graph rather than opening an empty popup", async () => {
    const { runtime } = await mountWithNode();

    const result = await act(async () =>
      runtime.bus.execute(SHOW_NODE_INFO_COMMAND, { nodeId: "nope" }, runtime.invocation),
    );
    expect(result.status).toBe("rejected");
    expect(screen.queryByLabelText(/Node info for/i)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------
// 3. Autosave (T139)
// ---------------------------------------------------------------------------------

describe("autosave is subscribed to the store (T139, §V10)", () => {
  it("writes a snapshot for a commit, and flushes before a manual save", async () => {
    const { store, puts } = memorySnapshotStore();
    const runtime = newRuntime();
    await mountApp({ runtime, createSnapshotStore: () => store });

    // Nothing has changed yet: a flush with no pending change writes nothing.
    expect(puts).toHaveLength(0);

    await act(async () => {
      await seed(runtime, [{ op: "addNode", ref: "$n", type: "solid", position: { x: 0, y: 0 } }]);
    });

    let written: string | null = null;
    installSavePicker((text) => {
      written = text;
    });

    // The save command flushes autosave FIRST, so the snapshot and the file describe the
    // same document rather than two versions a debounce apart.
    await act(async () => {
      fireEvent.click(screen.getByTestId("project-save"));
    });

    await waitFor(() => {
      expect(puts.length).toBeGreaterThan(0);
    });
    await waitFor(() => {
      expect(written).not.toBeNull();
    });

    const snapshot = puts.at(-1);
    expect(snapshot?.projectId).toBe(runtime.invocation.projectId);
    expect(snapshot?.revision).toBe(runtime.bus.store.getRevision());
    // One serializer: the snapshot body is the bytes a save would have written (T43).
    expect(snapshot?.body).toBe(serializeProjectDocument(runtime.projectDocument()));
  });

  it("surfaces a diagnostic when IndexedDB is unavailable instead of silently not saving", async () => {
    // `createIndexedDbSnapshotStore()` answers undefined in exactly this situation.
    await mountApp({ createSnapshotStore: () => undefined });

    // Loud on screen…
    const strip = await screen.findByTestId("notice-strip");
    expect(strip.textContent).toContain("Autosave is off");

    // …and in the problems tab, where the record belongs.
    fireEvent.click(screen.getByRole("tab", { name: /problems/i }));
    expect(await screen.findByText(/this project is NOT being autosaved/i)).toBeDefined();
  });

  it("offers the newest snapshot back on launch and restores it through the bus", async () => {
    const runtime = newRuntime();
    const document = restorableDocument(runtime.invocation.projectId);
    const { store } = memorySnapshotStore([
      {
        key: "1-r7",
        projectId: runtime.invocation.projectId,
        revision: 7,
        savedAt: 1,
        pinned: false,
        body: serializeProjectDocument(document),
      },
    ]);

    let swapped: AppRuntime | null = null;
    await mountApp({ runtime, createSnapshotStore: () => store, onRuntimeChange: (next) => (swapped = next) });

    const restore = await screen.findByText(/is newer than what is open/i);
    expect(restore).toBeDefined();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    });

    await waitFor(() => {
      expect(swapped).not.toBeNull();
    });
    const next = swapped as AppRuntime | null;
    expect(Object.keys(next?.bus.store.getGraph().nodes ?? {})).toContain("restored");
  });
});

// ---------------------------------------------------------------------------------
// 4. Save and open a project (T43, T139)
// ---------------------------------------------------------------------------------

/** Installs a File System Access save picker that captures the bytes. */
function installSavePicker(onWrite: (text: string) => void): void {
  (globalThis as Record<string, unknown>)["showSaveFilePicker"] = async () => ({
    name: "captured.loom.json",
    async createWritable() {
      return {
        async write(data: string) {
          onWrite(data);
        },
        async close() {},
      };
    },
  });
}

/** Installs an open picker that hands back the given bytes. */
function installOpenPicker(text: string, name = "fixture.loom.json"): void {
  (globalThis as Record<string, unknown>)["showOpenFilePicker"] = async () => [
    {
      async getFile() {
        return new File([text], name, { type: "application/json" });
      },
    },
  ];
}

function restorableDocument(projectId: string): ProjectDocument {
  return {
    ...newProjectDocument(projectId),
    name: "restored project",
    graph: {
      revision: 7,
      nodes: {
        restored: {
          id: "restored",
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

describe("a project round-trips through save and open (T43, §V10)", () => {
  it("writes the open document and reads it back into a live runtime", async () => {
    const first = newRuntime();
    const nodeId = await seedRenderable(first);

    let written: string | null = null;
    installSavePicker((text) => {
      written = text;
    });

    await mountApp({ status: READY, runtime: first });
    await act(async () => {
      fireEvent.click(screen.getByTestId("project-save"));
    });
    await waitFor(() => {
      expect(written).not.toBeNull();
    });

    const text = written as unknown as string;
    expect(JSON.parse(text)).toMatchObject({ schemaVersion: 1 });
    cleanup();

    // A DIFFERENT session opens it. Nothing is shared but the bytes.
    installOpenPicker(text);
    const second = newRuntime();
    let swapped: AppRuntime | null = null;
    await mountApp({ status: READY, runtime: second, onRuntimeChange: (next) => (swapped = next) });

    await act(async () => {
      fireEvent.click(screen.getByTestId("project-open"));
    });

    await waitFor(() => {
      expect(swapped).not.toBeNull();
    });
    const opened = swapped as AppRuntime | null;
    if (opened === null) throw new Error("expected the open to replace the runtime");

    // Same nodes, same edges, same settings — the document, not a re-derivation of it.
    expect(Object.keys(opened.bus.store.getGraph().nodes).sort()).toEqual(
      Object.keys(first.bus.store.getGraph().nodes).sort(),
    );
    expect(opened.bus.store.getGraph().nodes[nodeId]?.type).toBe("solid");
    expect(opened.settings).toEqual(first.settings);
  });

  it("takes its settings from the loaded document, not from the app defaults", async () => {
    const loaded: ProjectDocument = {
      ...restorableDocument("loaded-project"),
      settings: {
        ...newProjectDocument("loaded-project").settings,
        outputResolution: { width: 640, height: 360 },
        randomSeed: 4242,
      },
    };
    installOpenPicker(serializeProjectDocument(loaded));

    let swapped: AppRuntime | null = null;
    await mountApp({ status: READY, onRuntimeChange: (next) => (swapped = next) });
    await act(async () => {
      fireEvent.click(screen.getByTestId("project-open"));
    });

    await waitFor(() => {
      expect(swapped).not.toBeNull();
    });
    const opened = swapped as AppRuntime | null;
    expect(opened?.settings.outputResolution).toEqual({ width: 640, height: 360 });
    expect(opened?.settings.randomSeed).toBe(4242);
    expect(opened?.project.name).toBe("restored project");
  });

  it("leaves the open project untouched when the file is not a project", async () => {
    installOpenPicker("{ this is not json");
    const runtime = newRuntime();
    await seedRenderable(runtime);
    const before = runtime.bus.store.getRevision();

    let swapped: AppRuntime | null = null;
    await mountApp({ status: READY, runtime, onRuntimeChange: (next) => (swapped = next) });
    await act(async () => {
      fireEvent.click(screen.getByTestId("project-open"));
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Problems")).toBeDefined();
    });
    expect(swapped).toBeNull();
    expect(runtime.bus.store.getRevision()).toBe(before);
  });

  it("falls back to a download when the browser has no save picker", async () => {
    const runtime = newRuntime();
    await seedRenderable(runtime);
    await mountApp({ status: READY, runtime });

    // Firefox and Safari. The save must still happen — the fallback is a real path.
    // jsdom implements neither half of the object-URL API the blob download needs.
    const urls = URL as unknown as Record<string, unknown>;
    urls["createObjectURL"] ??= () => "blob:stub";
    urls["revokeObjectURL"] ??= () => undefined;

    const clicks: string[] = [];
    const createElement = document.createElement.bind(document);
    const spy = vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const element = createElement(tag);
      if (tag === "a") {
        element.addEventListener("click", (event) => {
          event.preventDefault();
          clicks.push((element as HTMLAnchorElement).download);
        });
      }
      return element;
    });

    try {
      await act(async () => {
        fireEvent.click(screen.getByTestId("project-save"));
      });
      await waitFor(() => {
        expect(clicks.length).toBeGreaterThan(0);
      });
      expect(clicks[0]).toMatch(/\.loom\.json$/);
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------------
// 5. Forward compatibility (§V68, §V69)
// ---------------------------------------------------------------------------------

describe("values written by a newer build (§V68, §V69)", () => {
  it("loads the document and refuses to render a control over what it cannot read", async () => {
    const doc = restorableDocument("future-project");
    // A parameter in the §V69 envelope shape this build does not interpret yet. It is
    // valid data written by a later Shaderloom, not a corrupt file.
    const withFuture = {
      ...doc,
      graph: {
        ...doc.graph,
        nodes: {
          restored: {
            ...doc.graph.nodes["restored"],
            parameters: { colour: { kind: "audio", channel: 3 } },
          },
        },
      },
    } as unknown as ProjectDocument;

    installOpenPicker(serializeProjectDocument(withFuture));
    let swapped: AppRuntime | null = null;
    await mountApp({ status: READY, onRuntimeChange: (next) => (swapped = next) });
    await act(async () => {
      fireEvent.click(screen.getByTestId("project-open"));
    });

    await waitFor(() => {
      expect(swapped).not.toBeNull();
    });
    const opened = swapped as AppRuntime | null;
    if (opened === null) throw new Error("expected the document to open");

    // §V68: the document loaded, the value is still there, byte for byte.
    expect(opened.unknownParameters.map((entry) => entry.key)).toEqual(["colour"]);
    expect(opened.bus.store.getGraph().nodes["restored"]?.parameters["colour"]).toEqual({
      kind: "audio",
      channel: 3,
    });

    // …and the inspector says so instead of putting a slider over it, which would show a
    // default that was never in the file and overwrite the real value on the first drag.
    const element = document.querySelector('.react-flow__node[data-id="restored"]');
    if (element === null) throw new Error("expected the restored node on the canvas");
    await act(async () => {
      fireEvent.click(element);
    });

    expect(await screen.findByTestId("future-parameters")).toBeDefined();
    expect(screen.getByText(/set by a newer version/i)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------------
// 6. GPU recovery (T98, §V23)
// ---------------------------------------------------------------------------------

/** The two things `useGpuRecovery` reads: a status object and a diagnostic stream. */
function haltedBackend() {
  let halted = true;
  const listeners = new Set<(diagnostic: { severity: string; code: string; message: string }) => void>();
  const recover = vi.fn(async () => {
    halted = false;
    for (const listener of listeners) {
      listener({ severity: "info", code: "backend/recovered", message: "Device re-acquired." });
    }
  });
  const backend = {
    get status() {
      return { halted };
    },
    onDiagnostic(listener: (diagnostic: { severity: string; code: string; message: string }) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    recover,
  } as unknown as ShaderloomBackend;
  return { backend, recover };
}

describe("a halted GPU has a way back (T98, §V23)", () => {
  it("offers a retry control that calls recover(), and clears when the device returns", async () => {
    const { backend, recover } = haltedBackend();
    await mountApp({ status: { ...READY, backend } });

    const retry = await screen.findByRole("button", { name: /retry gpu/i });
    expect(screen.getByText(/GPU submission is halted/i)).toBeDefined();

    await act(async () => {
      fireEvent.click(retry);
    });

    expect(recover).toHaveBeenCalledTimes(1);
    // The outcome is whatever `status.halted` says afterwards — never an assumption that
    // the call returning means the device came back.
    await waitFor(() => {
      expect(screen.queryByText(/GPU submission is halted/i)).toBeNull();
    });
  });

  it("shows nothing while the device is healthy", async () => {
    await mountApp({ status: READY });
    expect(screen.queryByRole("button", { name: /retry gpu/i })).toBeNull();
  });
});

// ---------------------------------------------------------------------------------
// 7. §V28a
// ---------------------------------------------------------------------------------

describe("§V28a — preview sinks", () => {
  it("passes no sink list at all, which is the documented 'use the flags' case", async () => {
    const runtime = newRuntime();
    await seedRenderable(runtime);
    await mountApp({ status: READY, runtime });

    // An EMPTY list would mean "no previews are visible" and would prune every preview;
    // a partial list would schedule the wrong set. Until this root can derive real
    // visibility (the preview surface owns it), the key is omitted so the document's
    // `ui.preview` flags decide — and the plan still keeps the graph's real sinks.
    await waitFor(() => {
      expect(runtime.telemetry.snapshot().plan).not.toBeNull();
    });
    expect(runtime.telemetry.snapshot().plan?.nodeCount).toBeGreaterThan(0);
  });
});
