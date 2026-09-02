// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import { SHOW_NODE_INFO_COMMAND } from "@editor/inspect/index.ts";
import { TOGGLE_REFERENCE_LINES_COMMAND } from "@editor/edges/index.ts";
import { menuSchemaFor } from "@editor/menus/index.ts";
import { serializeProjectDocument } from "@domain/project/index.ts";
import type { SnapshotMeta, SnapshotRecord, SnapshotStore } from "@domain/project/index.ts";
import type { BackendCapabilities } from "@domain/types/backend.ts";
import type { ProjectDocument } from "@domain/types/graph.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";
import type { AgentToolSurface } from "@agent/index.ts";
import { App } from "../../app/app.tsx";
import type { OpenPaneWindow } from "../../app/pane-window.tsx";
import { createAppRuntime, newProjectDocument } from "../../app/app-runtime.ts";
import type { AppRuntime } from "../../app/app-runtime.ts";
import type { GpuStatus } from "../../app/gpu-status.ts";
import { SCHEMA_VERSION } from "@domain/types/schemas.ts";

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

/**
 * The bridge's socket, played by the test (T451). Assignable handlers and a recorder —
 * the app's own adapter wires a real `WebSocket`'s events onto exactly these four fields.
 */
class FakeBridgeSocket {
  readonly sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.onclose?.();
  }

  emit(message: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

/**
 * One transport's row in the connections panel.
 *
 * Scoped rather than global: the panel declares a row per transport (§V338 — an absent row
 * and a forgotten row are the same pixels), so "Connect" and "Disconnect" are ambiguous by
 * design and a test that clicks the first one it finds is clicking whichever row happens to
 * come first today.
 */
function transportRow(kind: string): HTMLElement {
  const row = screen.getByTestId("mcp-connection-panel").querySelector(`[data-transport="${kind}"]`);
  if (row === null) throw new Error(`No connections row for transport "${kind}".`);
  return row as HTMLElement;
}

const NO_WEBGPU: GpuStatus = { kind: "unavailable", reason: "No WebGPU in this environment." };

const CAPABILITIES: BackendCapabilities = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
};

/**
 * A backend the composed fixtures can hand to the app (T292): construction-complete —
 * every method exists so PORTS wire — while pixel methods refuse honestly (this
 * fixture has no GPU; availability is about WIRING, not about rendering).
 */
function fixtureBackend(): LoomBackend {
  const noGpu = () => Promise.reject(new Error("composition fixture has no GPU"));
  return {
    status: {
      initialized: true,
      disposed: false,
      halted: false,
      deviceGeneration: 1,
      temporalResets: 0,
      resourceBuilds: 0,
      framesSubmitted: 0,
      readbacks: 0,
      stale: false,
      estimatedResourceBytes: 0,
    },
    initialize: () => Promise.resolve(CAPABILITIES),
    compile: (plan) => Promise.resolve({ id: "fixture", logical: plan }),
    render() {},
    resize() {},
    readOutput: noGpu,
    onDiagnostic: () => () => {},
    dispose() {},
    // T619: a loop that TICKS — the frame-observer seam (pulses, analyze, telemetry
    // frame counters) is invisible to any test whose backend never invokes its
    // callback. ~30fps on a timer; jsdom has no rAF worth trusting.
    loop: (onFrame) => {
      const timer = setInterval(() => onFrame(), 33);
      return {
        stop() {
          clearInterval(timer);
        },
      };
    },
    updateUniforms() {},
    resetTemporalHistory() {},
    recover: () => Promise.resolve(),
    present: (_canvas, options) => ({ id: "p", outputId: options.outputId, setOutput() {}, dispose() {} }),
    previewHost: () => ({ setPreviewProgram() {}, presentPreviews() {}, dispose() {} }),
    onGpuTimings: () => () => {},
    compileShader: () => Promise.resolve({ ok: false, validated: false, diagnostics: [] }),
    readBuffer: noGpu,
    registerMediaSource: () => () => {},
    setCookPolicy() {},
  };
}

const READY: GpuStatus = { kind: "ready", capabilities: CAPABILITIES, baseline: true, backend: fixtureBackend() };

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
  readonly onAgentSurface?: (surface: AgentToolSurface) => void;
  readonly openPaneWindow?: OpenPaneWindow;
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
        {...(options.onAgentSurface === undefined ? {} : { onAgentSurface: options.onAgentSurface })}
        {...(options.openPaneWindow === undefined ? {} : { openPaneWindow: options.openPaneWindow })}
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
    expect(JSON.parse(text)).toMatchObject({ schemaVersion: SCHEMA_VERSION });
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
    // valid data written by a later Loom, not a corrupt file.
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

/**
 * What `useGpuRecovery` reads — a status object and a diagnostic stream — plus the
 * members the composition root calls on ANY backend it is handed.
 *
 * `loop` and `previewHost` are stubbed for a reason worth stating: the root starts a
 * frame loop and attaches a preview host as soon as a backend exists, from effects that
 * run on mount. A stub that carried only the recovery surface therefore threw during
 * render, and the failure surfaced as an unrelated `AggregateError` from React's act
 * queue rather than as "your stub is incomplete". Every member here returns an inert
 * handle: this file's subject is the recovery affordance, not the render path.
 */
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
    loop: () => ({ stop: () => {} }),
    previewHost: () => ({
      setPreviewProgram: () => {},
      presentPreviews: () => {},
      dispose: () => {},
    }),
    present: () => ({
      id: "present-stub",
      outputId: "",
      setOutput: () => {},
      dispose: () => {},
    }),
    onGpuTimings: () => () => {},
    compile: () => Promise.reject(new Error("the halted-backend stub compiles nothing")),
    render: () => {},
    resize: () => {},
    updateUniforms: () => {},
    resetTemporalHistory: () => {},
    // T326: part of the backend contract; a fixture without it is incomplete.
    setCookPolicy: () => {},
    dispose: () => {},
  } as unknown as LoomBackend;
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

// ---------------------------------------------------------------------------------
// 8. Surfaces that were built, tested, and not connected (B12, T200, T188, T189)
// ---------------------------------------------------------------------------------

/**
 * This whole section is the B12 shape: a finished, green track that the running app
 * never constructs. Nothing here re-tests those tracks — each assertion is only that the
 * thing is REACHABLE from a mounted app, which is the one property their own suites
 * structurally cannot see.
 */
describe("the agent tool surface is constructed (B12, T220, §V39, §V42)", () => {
  /**
   * T292: EVERY tool, enumerated. Three findings this project (B12's agent surface,
   * T264's media registration, B23's preview port) shared one shape: built, green unit
   * tests, dead in the product — because a port or a mount is precisely the thing a
   * unit test cannot see; the test supplies it. Per-tool composed tests caught none of
   * them, because each was written by someone who knew their own tool and not the
   * wiring. An enumeration covers a NEW tool the day it exists rather than the day
   * someone remembers — a tool added without its wiring turns this red the same hour.
   */
  it("T292: every tool on the surface is LIVE — ports, queries and commands wired", async () => {
    let surface: AgentToolSurface | null = null;
    await mountApp({ status: READY, onAgentSurface: (next) => (surface = next) });
    const built = surface as AgentToolSurface | null;
    if (built === null) throw new Error("the composition root constructed no agent surface");

    // Ports arrive with the backend, one render after mount — wait for the live set.
    await waitFor(() => {
      expect(built.listTools().filter((tool) => !tool.available && tool.name !== "set_output")).toEqual([]);
    });
    const tools = built.listTools();
    expect(tools.length).toBeGreaterThan(20); // the roster, not a subset
    // Exemptions are EXPLICIT and carry the reason: an entry here is a declared feature
    // gap, never an excuse for a missing wire. Anything else unavailable is a bug.
    const declaredGaps = new Map([
      ["set_output", "graph.setOutput needs a document-level output designation first (§V59)"],
    ]);
    for (const tool of tools) {
      if (declaredGaps.has(tool.name)) continue;
      const missing = [...tool.missing.commands, ...tool.missing.queries, ...tool.missing.ports];
      expect(
        tool.available,
        `${tool.name} is on the surface but not wired: missing ${missing.join(", ")}`,
      ).toBe(true);
    }
  });

  it("hands out a surface whose tools are available, not `unavailable`", async () => {
    let surface: AgentToolSurface | null = null;
    await mountApp({ status: READY, onAgentSurface: (next) => (surface = next) });

    const built = surface as AgentToolSurface | null;
    if (built === null) throw new Error("the composition root constructed no agent surface");

    const byName = new Map(built.listTools().map((tool) => [tool.name, tool]));
    // The read tools that used to need INJECTED PORTS. They are bus queries now (T175),
    // and the root attaches the sources — so an out-of-process adapter sees them too.
    for (const name of ["get_selection", "get_diagnostics", "get_runtime_metrics"]) {
      expect(byName.get(name)?.available, `${name} has no source attached`).toBe(true);
    }
    // The mutation and workflow tools the criterion names.
    for (const name of ["apply_graph_patch", "validate_project", "compile_project", "save_project"]) {
      expect(byName.get(name)?.available, `${name} has no command behind it`).toBe(true);
    }
  });

  it("reads the LIVE selection through the bus, not a snapshot taken at construction", async () => {
    const runtime = newRuntime();
    const nodeId = await seedRenderable(runtime);
    let surface: AgentToolSurface | null = null;
    await mountApp({ status: READY, runtime, onAgentSurface: (next) => (surface = next) });
    const built = surface as AgentToolSurface | null;
    if (built === null) throw new Error("no agent surface");

    const before = await built.callTool("get_selection", {});
    expect(before.data).toEqual({ nodeIds: [], edgeIds: [] });

    const element = document.querySelector(`.react-flow__node[data-id="${nodeId}"]`);
    if (element === null) throw new Error("expected the seeded node on the canvas");
    await select(element);

    const after = await built.callTool("get_selection", {});
    expect(after.status).toBe("ok");
    expect(after.data).toEqual({ nodeIds: [nodeId], edgeIds: [] });
  });

  it("compiles through the bus, seeing an edit the agent has only just made (§V39)", async () => {
    const runtime = newRuntime();
    let surface: AgentToolSurface | null = null;
    await mountApp({ status: READY, runtime, onAgentSurface: (next) => (surface = next) });
    const built = surface as AgentToolSurface | null;
    if (built === null) throw new Error("no agent surface");

    interface Report {
      readonly compiled: boolean;
      readonly nodeCount: number;
      readonly passCount: number;
    }
    // A holder rather than a `let`: TypeScript narrows a variable only assigned inside a
    // closure to `never`, which reads as a type error about the test rather than the code.
    const captured: { report: Report | null } = { report: null };
    await act(async () => {
      await built.callTool("apply_graph_patch", {
        baseRevision: runtime.bus.store.getRevision(),
        label: "agent builds a chain",
        operations: [
          { op: "addNode", ref: "$solid", type: "solid", position: { x: 0, y: 0 } },
          { op: "addNode", ref: "$out", type: "output", position: { x: 240, y: 0 } },
          {
            op: "connect",
            source: { nodeId: "$solid", portId: "out" },
            target: { nodeId: "$out", portId: "input" },
          },
        ],
      });
      // Deliberately NOT awaiting a re-render first: the handler must read the store, or
      // an agent that edits and then compiles is handed the plan from before its edit.
      const outcome = await built.callTool("compile_project", {});
      captured.report = outcome.data as Report;
      expect(outcome.status).toBe("ok");
    });

    expect(captured.report?.compiled).toBe(true);
    expect(captured.report?.nodeCount).toBe(2);
    expect(captured.report?.passCount).toBeGreaterThan(0);
  });

  it("shows what the agent is doing, rather than mutating invisibly (§V42)", async () => {
    await mountApp({ status: READY });
    // The presence pane is MOUNTED — the panel had no host at all before T220.
    expect(await screen.findByTestId("agent-presence-panel")).toBeDefined();
    expect(screen.getByTestId("agent-activity").textContent).toBe("Idle");
  });

  /**
   * T397/§V338: the app performs a feature detection and must SAY what it found.
   *
   * These two run the REAL path — `App` builds the surface, `useMcpTransports` registers
   * it, and the panel renders whatever that registration reported. Nothing here hands the
   * panel a status: that is the whole point, because a test that supplies the wiring it
   * checks is the shape §V220 keeps catching us with. The pair is also the sensitivity
   * argument, because the same code produces two different screens depending only on
   * whether the host has `navigator.modelContext`.
   *
   * §V339, stated rather than glossed: jsdom paints nothing, so this proves the panel is
   * MOUNTED with the right data, not that it is visible. It sits in the agent pane
   * beside `agent-presence-panel`, whose visibility the same slot already carries.
   */
  it("T397/§V338: reports what its WebMCP detection FOUND, naming the missing capability", async () => {
    await mountApp({ status: READY });

    expect(await screen.findByTestId("mcp-connection-panel")).toBeDefined();
    expect(screen.getByTestId("mcp-state-webmcp").textContent).toBe("Unavailable");
    // §V288: the row names the problem. Before T397 this sentence existed nowhere.
    expect(screen.getByTestId("mcp-detail-webmcp").textContent).toContain("navigator.modelContext");
    expect(screen.getByTestId("mcp-consent").textContent).toBe("Nothing attached.");
    // Nothing was published, so there is nothing to withdraw.
    expect(screen.queryByText("Disconnect")).toBeNull();
  });

  it("T397: flips to Connected, and the count is the app's OWN publication", async () => {
    const provided: Array<{ tools: Array<{ name: string }> }> = [];
    Object.defineProperty(globalThis.navigator, "modelContext", {
      value: { provideContext: (context: { tools: Array<{ name: string }> }) => provided.push(context) },
      configurable: true,
    });
    try {
      let surface: AgentToolSurface | null = null;
      await mountApp({ status: READY, onAgentSurface: (next) => (surface = next) });
      const built = surface as AgentToolSurface | null;
      if (built === null) throw new Error("the composition root constructed no agent surface");

      expect(screen.getByTestId("mcp-state-webmcp").textContent).toBe("Connected");
      expect(screen.getByTestId("mcp-consent").textContent).toBe("Attached agents can edit this document.");

      // Read off the host the APP called, then off the surface the app built — the panel
      // is only allowed to agree with both, never to be the source of either.
      const publishedNames = provided[0]?.tools.map((tool) => tool.name) ?? [];
      expect(publishedNames).toEqual(built.listTools().map((tool) => tool.name));
      const toggle = screen.getByTestId("mcp-tools-toggle-webmcp");
      expect(toggle.textContent).toBe(`${String(publishedNames.length)} tools`);

      // Drill in: the tool list, then one tool's schema — what a client is actually handed.
      await act(async () => {
        fireEvent.click(toggle);
      });
      const toolButton = within(screen.getByTestId("mcp-tool-list")).getByText("add_node");
      await act(async () => {
        fireEvent.click(toolButton);
      });
      const detail = screen.getByTestId("mcp-tool-detail-add_node");
      expect(detail.textContent).toContain('"type": "object"');

      // Disconnect genuinely withdraws the publication from the host the app registered
      // with — not merely a local state flip (§V288: the button means what it says).
      await act(async () => {
        fireEvent.click(screen.getByText("Disconnect"));
      });
      expect(provided.at(-1)?.tools).toEqual([]);
      expect(screen.getByTestId("mcp-state-webmcp").textContent).toBe("Disconnected");
    } finally {
      Reflect.deleteProperty(globalThis.navigator, "modelContext");
    }
  });

  /**
   * T451/§V220: THE BRIDGE, THROUGH THE APP THE USER OPERATES.
   *
   * The shape §V220 keeps catching is a transport that is built, unit-tested and reachable
   * from nothing. So nothing here is handed to a panel: `App` builds its own surface, its own
   * registry and its own bridge client; this test types a pairing code into the field a user
   * types into, clicks the button in THAT row, and then plays the part of the bridge on the
   * other end of the socket the app itself opened. The node at the end is in the app's own
   * document, reached only through that path.
   *
   * §V339, stated not glossed: jsdom paints nothing, so this proves MOUNTED and CONNECTED,
   * not visible. §V382, stated too: the WebSocket here is a fake, so this asserts "the app
   * opened this URL and sent these frames" — the frames themselves, and the whole chain
   * through a real listener into a real store, are in `mcp/bridge.test.ts`, which stubs
   * nothing between the two halves.
   */
  it("T451: attaching the bridge from the panel lets the stdio agent edit THIS document", async () => {
    const opened: FakeBridgeSocket[] = [];
    const previous = (globalThis as Record<string, unknown>)["WebSocket"];
    (globalThis as Record<string, unknown>)["WebSocket"] = class {
      constructor(url: string) {
        const socket = new FakeBridgeSocket(url);
        opened.push(socket);
        return socket as unknown as WebSocket;
      }
    };

    try {
      const { runtime } = await mountApp({ status: READY });
      expect(await screen.findByTestId("mcp-state-bridge")).toBeDefined();
      // Idle, and nothing dialled: no auto-connect on load, ever.
      expect(screen.getByTestId("mcp-state-bridge").textContent).toBe("Disconnected");
      expect(opened).toHaveLength(0);

      await act(async () => {
        fireEvent.change(screen.getByTestId("mcp-token-bridge"), { target: { value: "abc-def" } });
        fireEvent.click(within(transportRow("bridge")).getByText("Connect"));
      });

      const socket = opened[0];
      // T398's finding, asserted rather than promised: the credential is NOT in the URL.
      expect(socket?.url).toBe("ws://127.0.0.1:43919");
      expect(socket?.url).not.toContain("?");
      await act(async () => {
        socket?.onopen?.();
      });
      // It is in the first MESSAGE, normalised the way a person retypes it.
      expect(JSON.parse(socket?.sent[0] ?? "{}")).toMatchObject({ type: "attach", code: "ABCDEF" });

      // Connecting is not connected: the row only says Connected once the bridge confirms.
      expect(screen.getByTestId("mcp-state-bridge").textContent).toBe("Connecting…");

      await act(async () => {
        socket?.emit({ type: "listTools", id: 1 });
      });
      const listing = JSON.parse(socket?.sent[1] ?? "{}") as {
        type: string;
        tools: Array<{ name: string }>;
      };
      expect(listing.type).toBe("listToolsResult");
      expect(listing.tools.map((tool) => tool.name)).toContain("add_node");

      await act(async () => {
        socket?.emit({ type: "attached", serverInfo: "loom-bridge" });
      });
      expect(screen.getByTestId("mcp-state-bridge").textContent).toBe("Connected");
      expect(screen.getByTestId("mcp-consent").textContent).toBe("Attached agents can edit this document.");

      // The payoff: a tool call off the bridge lands in the app's live document.
      expect(Object.values(runtime.bus.store.getGraph().nodes)).toHaveLength(0);
      await act(async () => {
        socket?.emit({ type: "callTool", id: 2, tool: "add_node", arguments: { type: "solid" } });
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(Object.values(runtime.bus.store.getGraph().nodes)).toHaveLength(1);
      });
      expect(Object.values(runtime.bus.store.getGraph().nodes)[0]?.type).toBe("solid");
      expect(screen.getByTestId("mcp-last-bridge").textContent).toContain("add_node");

      // And it is revocable from the same row, which is the consent half of §V338.
      await act(async () => {
        fireEvent.click(within(transportRow("bridge")).getByText("Disconnect"));
      });
      expect(socket?.closed).toBe(true);
      expect(screen.getByTestId("mcp-state-bridge").textContent).toBe("Disconnected");
    } finally {
      (globalThis as Record<string, unknown>)["WebSocket"] = previous;
    }
  });

  /**
   * T399/§V342: the setup snippet is REACHABLE. `ui.openHelp` taking a section proves
   * nothing about whether a surface supplies one — B60's exact lesson — so this clicks
   * the button a user would click and asserts the snippet is on screen.
   */
  it("T399: the connections panel opens the setup snippet, and it is paste-ready", async () => {
    await mountApp({ status: READY });
    await act(async () => {
      fireEvent.click(await screen.findByText("Set up…"));
    });
    const snippet = await screen.findByTestId("mcp-client-config");
    const config = JSON.parse(snippet.textContent ?? "{}") as {
      mcpServers?: Record<string, { command?: string; args?: string[] }>;
    };
    expect(config.mcpServers?.["loom"]?.command).toBe("node");
    expect(config.mcpServers?.["loom"]?.args?.join(" ")).toContain("src/mcp/serve.ts");
  });
});

describe("help, and the two libraries that had no host", () => {
  it("opens help from the top bar, not only from a shortcut nobody can see (T200)", async () => {
    await mountApp({ status: READY });

    // The owner asked for this twice, and asked for it in the TOP BAR: a keybinding is
    // not an affordance. Same command as mod+/ and the palette entry (§V29, §V52).
    const trigger = screen.getByTestId("open-help");
    await act(async () => {
      fireEvent.click(trigger);
    });

    const panel = await screen.findByRole("dialog", { name: /help/i });
    expect(panel).toBeDefined();
  });

  it("mounts the component library beside the node library, both additive (§V93)", async () => {
    await mountApp({ status: READY });
    const left = document.querySelector('[data-pane-leaf="leaf-left"]');
    if (left === null) throw new Error("no left dock");
    expect(left.querySelector('[data-pane-role="library"]')).not.toBeNull();
    expect(left.querySelector('[data-pane-role="components"]')).not.toBeNull();
  });

  it("keeps the example library out of that pair — OPEN is the destructive verb (§V93)", async () => {
    await mountApp({ status: READY });
    const left = document.querySelector('[data-pane-leaf="leaf-left"]');
    if (left === null) throw new Error("no left dock");
    // Mounted, and reachable…
    expect(document.querySelector('[data-pane-role="examples"]')).not.toBeNull();
    // …but never a third tab one click from two harmless ones.
    expect(left.querySelector('[data-pane-role="examples"]')).toBeNull();
  });
});

/**
 * §V97 — a floated pane shares ONE bus, store and runtime. The assertion is a MUTATION:
 * a second runtime in the child window would leave the two documents disagreeing, which
 * is exactly the failure that shows up later as "my edits sometimes don't stick".
 */
describe("a floated pane is on the same bus as the dock (§V97, T192)", () => {
  it("shows an edit made through the app's bus inside the child window", async () => {
    const doc = document.implementation.createHTMLDocument("floating pane");
    const child = {
      document: doc,
      addEventListener: () => {},
      removeEventListener: () => {},
      close: () => {},
    };

    const runtime = newRuntime();
    const nodeId = await seedRenderable(runtime);
    await mountApp({ status: READY, runtime, openPaneWindow: () => child });

    const element = document.querySelector(`.react-flow__node[data-id="${nodeId}"]`);
    if (element === null) throw new Error("expected the seeded node on the canvas");
    await select(element);
    // The inspector is showing that node, in the dock.
    const inspector = document.querySelector<HTMLElement>('[data-pane-host^="inspector-"]');
    if (inspector === null) throw new Error("no inspector pane");
    expect(inspector.textContent).toContain(nodeId);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Move inspector" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Float in its own window" }));
    });

    // The SAME element, now living in the child document.
    expect(doc.body.contains(inspector)).toBe(true);

    // ONE store: a mutation dispatched on the app's bus, in the main window, reaches the
    // pane that is now in a different document. A second runtime over there would leave
    // this node still sitting in the floated inspector — the quiet §V29 failure that
    // surfaces later as "my edits sometimes don't stick".
    await act(async () => {
      await runtime.bus.execute(
        "graph.applyPatch",
        {
          baseRevision: runtime.bus.store.getRevision(),
          label: "remove the selected node",
          operations: [{ op: "removeNodes", nodeIds: [nodeId] }],
        },
        runtime.invocation,
      );
    });

    await waitFor(() => {
      expect(inspector.textContent).toContain("No node selected");
    });
    expect(inspector.textContent).not.toContain(nodeId);
    expect(doc.body.contains(inspector)).toBe(true);
  });
});

/**
 * T705 — the pop-out viewer PAINTS, gated on the two seams that broke it.
 *
 * The owner's report was "an about:blank empty page with the title viewer", and the
 * window part was fine — the failure was per-DOCUMENT resources living on the moved
 * canvas: the dock window's ResizeObserver fired once mid-detach (writing a 1×1
 * backing store) and never again, and a WebGPU canvas that was CONFIGURED and then
 * adopted cross-document is permanently inert even at the right size (measured live:
 * full-size canvas, 0.0 mean luma, getContext still answering).
 *
 * So the gate asserts the ESCAPE, not the window: floating must re-present onto a
 * FRESH canvas element living in the child document — same on the way back. Asserting
 * "a window exists with the right title" is exactly the broken state (§V655's family:
 * the health check a collapse satisfies).
 */
describe("T705 — the floated viewer re-presents on a fresh canvas", () => {
  it("presents a NEW canvas in the child document, and again when docked back", async () => {
    const doc = document.implementation.createHTMLDocument("floating viewer");
    const pagehide: Array<() => void> = [];
    const child = {
      document: doc,
      addEventListener: (_type: "pagehide", listener: () => void) => {
        pagehide.push(listener);
      },
      removeEventListener: () => {},
      close: () => {},
    };

    const presented: HTMLCanvasElement[] = [];
    const backend = fixtureBackend();
    const spied: typeof backend = {
      ...backend,
      present: (canvas, options) => {
        presented.push(canvas as HTMLCanvasElement);
        return backend.present(canvas, options);
      },
    };
    const runtime = newRuntime();
    await seedRenderable(runtime);
    await mountApp({
      status: { kind: "ready", capabilities: CAPABILITIES, baseline: true, backend: spied },
      runtime,
      openPaneWindow: () => child,
    });

    // The docked viewer attached to a real canvas in the MAIN document.
    await waitFor(() => {
      expect(presented.length).toBeGreaterThan(0);
    });
    const docked = presented[presented.length - 1];
    if (docked === undefined) throw new Error("no presented canvas");
    expect(docked.ownerDocument).toBe(document);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Move viewer" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Float in its own window" }));
    });

    // A fresh element, in the child document — not the dock's canvas relocated. The
    // relocated one is the one that cannot paint.
    await waitFor(() => {
      const latest = presented[presented.length - 1];
      expect(latest).not.toBe(docked);
      expect(latest?.ownerDocument).toBe(doc);
    });
    const floated = presented[presented.length - 1];

    // Dock it back the way a user closing the popup does: the window's pagehide.
    await act(async () => {
      for (const listener of pagehide) listener();
    });
    await waitFor(() => {
      const latest = presented[presented.length - 1];
      expect(latest).not.toBe(floated);
      expect(latest?.ownerDocument).toBe(document);
    });
  });
});

// ---------------------------------------------------------------------------------
// 9. New, and the confirmation that protects unsaved work (T261, §V165, §V166)
// ---------------------------------------------------------------------------------

/**
 * §V165 puts New under §V93's rule: it is a destructive verb, so it asks when there is
 * unsaved work. §V166 is the part that is usually built wrong — a two-button "are you
 * sure?" makes the careful user do the most work and discarding one click. The assertions
 * below are therefore about the SHAPE of the dialog as much as its outcomes.
 */
describe("New replaces the project, and asks first when work is unsaved", () => {
  async function clickNew() {
    await act(async () => {
      fireEvent.click(screen.getByTestId("project-new"));
    });
  }

  it("starts an empty project without asking when nothing is unsaved", async () => {
    const runtime = newRuntime();
    await seedRenderable(runtime);
    // Mounting AFTER the seed is what makes this document clean: the dirty flag is
    // "the revision moved since it was last written", and nothing has moved since mount.
    let swapped: AppRuntime | null = null;
    await mountApp({ status: READY, runtime, onRuntimeChange: (next) => (swapped = next) });

    await clickNew();

    expect(screen.queryByTestId("unsaved-changes-dialog")).toBeNull();
    const next = swapped as AppRuntime | null;
    if (next === null) throw new Error("New did not replace the runtime");
    expect(Object.keys(next.bus.store.getGraph().nodes)).toEqual([]);
    // A NEW runtime, so nothing of the old project survives — not its undo history, not
    // its settings, not its store.
    expect(next.bus).not.toBe(runtime.bus);
  });

  it("asks before discarding unsaved work, and offers SAVE first (§V166)", async () => {
    const runtime = newRuntime();
    let swapped: AppRuntime | null = null;
    await mountApp({ status: READY, runtime, onRuntimeChange: (next) => (swapped = next) });
    // Edit AFTER mount: now there is unsaved work.
    await act(async () => {
      await seedRenderable(runtime);
    });

    await clickNew();

    const dialog = await screen.findByTestId("unsaved-changes-dialog");
    const buttons = [...dialog.querySelectorAll("button")].map((button) => button.textContent);
    // Three outcomes, in this order. Two of them — "are you sure?" — is the shape §V166
    // exists to rule out: it makes keeping your work the longest path through the dialog.
    expect(buttons).toEqual(["Save and continue", "Discard", "Cancel"]);

    // Nothing has happened yet: the command is suspended, not cancelled.
    expect(swapped).toBeNull();
    expect(Object.keys(runtime.bus.store.getGraph().nodes).length).toBe(2);
  });

  it("cancel leaves the document exactly as it was", async () => {
    const runtime = newRuntime();
    let swapped: AppRuntime | null = null;
    await mountApp({ status: READY, runtime, onRuntimeChange: (next) => (swapped = next) });
    await act(async () => {
      await seedRenderable(runtime);
    });
    const before = runtime.bus.store.getGraph();

    await clickNew();
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    });

    expect(swapped).toBeNull();
    expect(runtime.bus.store.getGraph()).toBe(before);
    expect(screen.queryByTestId("unsaved-changes-dialog")).toBeNull();
  });

  it("discard throws the work away and starts empty", async () => {
    const runtime = newRuntime();
    let swapped: AppRuntime | null = null;
    await mountApp({ status: READY, runtime, onRuntimeChange: (next) => (swapped = next) });
    await act(async () => {
      await seedRenderable(runtime);
    });

    await clickNew();
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    });

    const next = swapped as AppRuntime | null;
    if (next === null) throw new Error("Discard did not start a new project");
    expect(Object.keys(next.bus.store.getGraph().nodes)).toEqual([]);
  });

  it("save-and-continue writes the file FIRST, then starts the new project", async () => {
    const written: string[] = [];
    installSavePicker((text) => written.push(text));

    const runtime = newRuntime();
    let swapped: AppRuntime | null = null;
    await mountApp({ status: READY, runtime, onRuntimeChange: (next) => (swapped = next) });
    await act(async () => {
      await seedRenderable(runtime);
    });
    await clickNew();
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Save and continue" }));
    });

    // The file holds the document as it stood BEFORE the new project replaced it — the
    // whole point of the primary action. (`updatedAt` is stamped at write time, so the
    // assertion is on the graph rather than on the byte string.)
    expect(written).toHaveLength(1);
    const file = JSON.parse(written[0] ?? "null") as { graph?: { nodes?: object } };
    const nodes = file.graph?.nodes ?? {};
    expect(Object.keys(nodes)).toHaveLength(2);
    const next = swapped as AppRuntime | null;
    if (next === null) throw new Error("Save and continue did not start a new project");
    expect(Object.keys(next.bus.store.getGraph().nodes)).toEqual([]);
  });

  it("does not continue when the save the user asked for did not happen", async () => {
    // A cancelled picker: `project.save` reports `saved: false`.
    (globalThis as Record<string, unknown>)["showSaveFilePicker"] = async () => {
      throw Object.assign(new Error("cancelled"), { name: "AbortError" });
    };

    const runtime = newRuntime();
    let swapped: AppRuntime | null = null;
    await mountApp({ status: READY, runtime, onRuntimeChange: (next) => (swapped = next) });
    await act(async () => {
      await seedRenderable(runtime);
    });

    await clickNew();
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Save and continue" }));
    });

    // Continuing anyway would destroy exactly the work the user clicked Save to keep.
    expect(swapped).toBeNull();
    expect(Object.keys(runtime.bus.store.getGraph().nodes).length).toBe(2);
  });

  it("routes through the bus, so a hotkey or the palette asks the same question", async () => {
    const runtime = newRuntime();
    await mountApp({ status: READY, runtime });
    await act(async () => {
      await seedRenderable(runtime);
    });

    // Not the button: the command itself. §V52 — one action, one path.
    await act(async () => {
      void runtime.bus.execute("project.new", {}, runtime.invocation);
    });

    expect(await screen.findByTestId("unsaved-changes-dialog")).toBeDefined();
  });
});

/**
 * T246 — the parameter menu, at the seam.
 *
 * `ContextMenuHost` had no mount anywhere in `src/app` while the whole menus track was
 * green: every menu it could build was unreachable from the running product. That is the
 * fourth instance of the shape this file exists for (§V193), so the assertion is not
 * "the schema is right" — the menus suite covers that — but "a right-click on a real
 * parameter row in the real pane opens the real menu".
 */
describe("the parameter context menu is reachable (T246, §V78, §V193)", () => {
  it("opens on a right-click over a parameter row, naming registered commands", async () => {
    const { runtime, element } = await mountWithNode();
    await select(element);

    const row = document.querySelector("[data-parameter-key]");
    expect(row, "the inspector must mark its parameter rows for the menu to resolve").not.toBeNull();
    if (row === null) return;

    await act(async () => {
      fireEvent.contextMenu(row, { bubbles: true });
    });

    const menu = await screen.findByLabelText("parameter menu");
    expect(menu).toBeDefined();

    // Every command the menu names is LIVE — the point of §V78 is that the menu is a
    // view of the command set, not a list of intentions.
    for (const name of ["parameter.copyValue", "parameter.copyReference", "parameter.paste", "parameter.reset", "parameter.setMode"]) {
      expect(runtime.bus.hasCommand(name), name).toBe(true);
    }
  });

  it("opens nothing when the right-click lands on the pane rather than a parameter", async () => {
    const { element } = await mountWithNode();
    await select(element);

    const pane = screen.getByTestId("inspector-scroll");
    await act(async () => {
      fireEvent.contextMenu(pane, { bubbles: true });
    });

    // No `fallbackSurface`: a menu for a parameter nobody clicked would act on whatever
    // the previous target happened to be.
    expect(screen.queryByLabelText("parameter menu")).toBeNull();
  });
});

/**
 * B68/§V356 — the reference-lines toggle has a DOOR.
 *
 * §V153 calls the toggle a real control, and there was none: no binding, no menu row, no
 * button. The command was registered — `registerReferenceLinesCommand` is called by the
 * canvas — but called for its STORE, so §V318's "an exported function of the registrar
 * must be referenced" was satisfied while nothing could invoke what it registered. The
 * static half of this is the §V356 gate in `composition-seams.test.ts`; this is the half
 * that asks the composed app.
 *
 * The lines leaving the DOM is `graph-canvas/reference-lines.test.tsx`'s assertion and is
 * not repeated. What was missing, and is asserted here, is that a route to the command
 * exists at all and reaches a live command on the mounted app's bus.
 */
describe("B68 — the reference-lines toggle is reachable from the canvas menu (§V153)", () => {
  it("offers a row that names the command, and the command is live on the mounted bus", async () => {
    const { runtime } = await mountWithNode();

    const entries = menuSchemaFor("canvas", runtime.registry).entries;
    const row = entries.find(
      (entry) => "command" in entry && entry.command === TOGGLE_REFERENCE_LINES_COMMAND,
    );
    expect(
      row,
      "the canvas menu offers no row naming `ui.toggleReferenceLines` — §V153's control does not exist",
    ).toBeDefined();

    expect(
      runtime.bus.hasCommand(TOGGLE_REFERENCE_LINES_COMMAND),
      "the menu names a command the mounted app has not registered",
    ).toBe(true);

    // Executing exactly what the row names flips the state, and reports the new one — so
    // a menu click and an agent call cannot mean different things (§V78).
    const off = await act(async () =>
      runtime.bus.execute(TOGGLE_REFERENCE_LINES_COMMAND, {}, runtime.invocation),
    );
    expect(off.status).toBe("applied");
    expect(off.output.shown).toBe(false);

    const on = await act(async () =>
      runtime.bus.execute(TOGGLE_REFERENCE_LINES_COMMAND, { show: true }, runtime.invocation),
    );
    expect(on.output.shown).toBe(true);
  });
});

/**
 * T597 — §V39, ENFORCED: one tool surface, complete in EVERY environment.
 *
 * §V39 keeps the catalogue single (both transports derive {name, schema} from the same
 * zod), but a tool is only real where its `requires` are satisfied — and each
 * environment boots its own registrations. Nothing asserted that both environments boot
 * ALL of them, so an in-page agent and a desktop client could be told two different
 * stories about one product and each story would be locally true. These gates make the
 * property fail loudly: every catalogue tool must be AVAILABLE — commands registered,
 * queries attached, read sources mounted — on the composed PAGE surface (here) and on
 * the headless server (`server.test.ts`'s twin gate). A tool that genuinely cannot
 * exist in an environment must be waived BY NAME with the reason, not left to drift.
 */
describe("T619 — get_runtime_metrics tells the truth about a rendering document", () => {
  it("reports the compiled plan's counts and the frames the driver ran", async () => {
    const runtime = newRuntime();
    await seedRenderable(runtime);
    let surface: AgentToolSurface | null = null;
    await mountApp({ status: READY, runtime, onAgentSurface: (next) => (surface = next) });
    const built = surface as AgentToolSurface | null;
    if (built === null) throw new Error("no agent surface");

    await waitFor(() => {
      expect(runtime.telemetry.snapshot().plan).not.toBeNull();
    });

    const metrics = await built.callTool("get_runtime_metrics", {});
    expect(metrics.status).toBe("ok");
    const data = metrics.data as {
      nodeCount: number;
      passCount: number;
      framesRendered: number;
      lastFrameIndex: number | null;
    };
    // The plan half: an agent asking "what is compiled" must not be told zero on a
    // compiled five-node graph — the exact lie T619 measured in a live tab.
    expect(data.nodeCount).toBeGreaterThan(0);
    expect(data.passCount).toBeGreaterThan(0);
    // The frame half: the driver ticks in this mount; framesRendered must move with it.
    await waitFor(() => {
      expect(runtime.telemetry.snapshot().framesRendered).toBeGreaterThan(0);
    });
    const after = (await built.callTool("get_runtime_metrics", {})).data as {
      framesRendered: number;
      frameClock?: { kind: string };
    };
    expect(after.framesRendered).toBeGreaterThan(0);
    /* T304: the frame-clock verdict reaches the agent surface through the REAL app —
       the judgment is unit-gated in frame-clock.test.ts; this pins the WIRING (§V437's
       two-surfaces-one-derivation, agent half). */
    expect(["live", "paused", "browser-throttled", "running-behind"]).toContain(after.frameClock?.kind);
  });
});

describe("T597/§V39 — the page surface is complete: every tool available", () => {
  it("no tool on the composed page surface is unavailable", async () => {
    const runtime = newRuntime();
    let surface: AgentToolSurface | null = null;
    await mountApp({ status: READY, runtime, onAgentSurface: (next) => (surface = next) });
    const built = surface as AgentToolSurface | null;
    if (built === null) throw new Error("no agent surface");

    const listings = built.listTools();
    // Non-vacuous: the whole catalogue, not a subset that happens to pass.
    expect(listings.length).toBeGreaterThanOrEqual(29);
    /**
     * WAIVED BY NAME, with the reason — never by drift. `set_output` is a deliberate
     * stub on EVERY surface: there is no `graph.setOutput` command anywhere because the
     * document has no port-scoped output designation to write (§V59; mutate.ts states
     * it at the tool). Everything else must be available, here and on the headless
     * twin (`server.test.ts` holds the twin gate with its own waivers).
     */
    const waived = new Set(["set_output"]);
    const unavailable = listings
      .filter((tool) => !tool.available && !waived.has(tool.name))
      .map(
        (tool) =>
          `${tool.name} — commands:[${tool.missing.commands.join(",")}] queries:[${tool.missing.queries.join(",")}] ports:[${tool.missing.ports.join(",")}]`,
      );
    expect(
      unavailable,
      "a catalogue tool is dead on the page: its command/query/port never registered at app boot (§V39)",
    ).toEqual([]);
    // The waiver list cannot rot into a blanket: a waived tool that becomes available
    // must be un-waived, loudly.
    for (const name of waived) {
      expect(
        listings.find((tool) => tool.name === name)?.available,
        `"${name}" is waived as unavailable but the surface now offers it — delete the waiver`,
      ).toBe(false);
    }
  });
});
