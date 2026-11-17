import { act, cleanup, render, renderHook, screen, fireEvent } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import type { BackendCapabilities, CompiledExecutionPlan, FrameInputs } from "@domain/types/backend.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { scopeFromFrame } from "@domain/expressions/evaluate.ts";
import { MIDI_CLOCK, MIDI_START } from "@domain/tempo/midi-clock.ts";
import { createProjectTempo, projectBpm, projectTempoSource } from "@domain/tempo/project-tempo.ts";
import { registerTempoCommands } from "@domain/tempo/tempo-commands.ts";
import { alice, contextFor, createHarness } from "@domain/commands/test-support.ts";
import { TooltipProvider } from "@ui/primitives/tooltip.tsx";
import type { LoomBackend } from "@runtime/backend/index.ts";
import { App } from "./app.tsx";
import { createAppRuntime } from "./app-runtime.ts";
import type { AppRuntime } from "./app-runtime.ts";
import type { GpuStatus } from "./gpu-status.ts";
import { TempoControl } from "./tempo-control.tsx";
import { useMidiInput } from "./use-midi-input.ts";

/**
 * T1785b / T1786b — the project tempo in the COMPOSED app.
 *
 * `project-tempo.test.ts` proves the clock through the bus, the transport and the
 * expression scope. What it cannot see is whether the app built one and wired it: a beat
 * clock nothing stamps on a frame leaves every expression at the default 120 with all of
 * that suite green ("built, tested, never wired"). So this file reads the frame the app's
 * own loop RENDERED, after MIDI clock bytes went into the app's own MIDI input.
 */
beforeAll(() => {
  installDomStubs();
  installFlowStubs();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const CAPABILITIES: BackendCapabilities = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
};

function newRuntime(): AppRuntime {
  return createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "tester", label: "Tester" } });
}

/** The same stand-in backend `value-graph-loop.test.tsx` uses, keeping every frame it was asked to render. */
function fixtureBackend(): { backend: LoomBackend; tick: () => void; rendered: FrameInputs[] } {
  let onFrame: (() => void) | null = null;
  const rendered: FrameInputs[] = [];
  const backend = {
    status: { initialized: true, disposed: false, halted: false, deviceGeneration: 1, temporalResets: 0, resourceBuilds: 0, framesSubmitted: 0, readbacks: 0, stale: false, estimatedResourceBytes: 0 },
    initialize: () => Promise.resolve(CAPABILITIES),
    compile: (plan: unknown) => Promise.resolve({ id: "fixture", logical: plan } as CompiledExecutionPlan),
    render(_plan: unknown, inputs: FrameInputs) {
      rendered.push(inputs);
    },
    resize() {},
    readOutput: () => Promise.reject(new Error("no GPU")),
    onDiagnostic: () => () => {},
    dispose() {},
    loop: (callback: () => void) => {
      onFrame = callback;
      return { stop() {} };
    },
    updateUniforms() {},
    resetTemporalHistory() {},
    recover: () => Promise.resolve(),
    present: (_canvas: unknown, options: { outputId: string }) => ({ id: "p", outputId: options.outputId, setOutput() {}, dispose() {} }),
    previewHost: () => ({ setPreviewProgram() {}, presentPreviews() {}, dispose() {} }),
    onGpuTimings: () => () => {},
    onCpuTimings: () => () => {},
    compileShader: () => Promise.resolve({ ok: false, validated: false, diagnostics: [] }),
    readBuffer: () => Promise.reject(new Error("no GPU")),
    registerMediaSource: () => () => {},
    setCookPolicy() {},
  } as unknown as LoomBackend;
  return {
    backend,
    tick: () => {
      if (onFrame === null) throw new Error("the app registered no frame loop");
      onFrame();
    },
    rendered,
  };
}

async function mountApp(runtime: AppRuntime) {
  const fixture = fixtureBackend();
  const status: GpuStatus = { kind: "ready", capabilities: CAPABILITIES, baseline: true, backend: fixture.backend };
  await act(async () => {
    const operations: GraphPatchOperation[] = [
      { op: "addNode", ref: "$noise", type: "noise", position: { x: 0, y: 0 } },
      { op: "addNode", ref: "$out", type: "output", position: { x: 480, y: 0 } },
      { op: "connect", source: { nodeId: "$noise", portId: "out" }, target: { nodeId: "$out", portId: "input" } },
    ];
    const seeded = await runtime.bus.execute("graph.applyPatch", { baseRevision: runtime.bus.store.getRevision(), operations, label: "seed" }, runtime.invocation);
    expect(seeded.status).toBe("applied");
  });
  await act(async () => {
    render(<App runtime={runtime} storage={createMemoryStorage()} gpuProbe={() => Promise.resolve(status)} />);
  });
  return fixture;
}

/** What an expression reads on the last frame the app rendered. */
const lastScope = (fixture: { rendered: FrameInputs[] }) => {
  const inputs = fixture.rendered[fixture.rendered.length - 1];
  if (inputs === undefined) throw new Error("the app rendered no frame");
  return scopeFromFrame(inputs.frame);
};

describe("the composed app stamps the project tempo on the frames it renders (T1785b)", () => {
  it("MIDI clock into the app's tempo reaches the rendered frame's `bpm`; a manual project does not follow it", async () => {
    const runtime = newRuntime();
    const fixture = await mountApp(runtime);
    await act(async () => {
      await runtime.bus.execute("tempo.setSource", { source: "midiClock" }, runtime.invocation);
    });
    // 49 pulses at 150 bpm, the last one landing now, on the clock the app's tempo reads.
    const step = 60 / (150 * 24);
    const end = performance.now() / 1000;
    runtime.tempo.midiRealtime(MIDI_START, end - 49 * step);
    for (let pulse = 48; pulse >= 0; pulse -= 1) runtime.tempo.midiRealtime(MIDI_CLOCK, end - pulse * step);
    await act(async () => {
      fixture.tick();
    });
    const following = lastScope(fixture);
    // The document still says 120: only a frame stamped by the app's beat clock reads 150.
    expect(projectBpm(runtime.settings)).toBe(120);
    expect(following["bpm"]).toBeCloseTo(150, 6);
    expect(following["tempolocked"]).toBe(1);

    await act(async () => {
      await runtime.bus.execute("tempo.setSource", { source: "manual" }, runtime.invocation);
      await runtime.bus.execute("tempo.set", { bpm: 96 }, runtime.invocation);
    });
    await act(async () => {
      fixture.tick();
    });
    expect(lastScope(fixture)["bpm"]).toBe(96);
    runtime.dispose();
  });

  it("the transport bar's controls run the tempo commands: BPM field, source, Tap", async () => {
    const runtime = newRuntime();
    await mountApp(runtime);
    const field = screen.getByLabelText("Tempo (BPM)") as HTMLInputElement;
    expect(field.value).toBe("120.0");
    await act(async () => {
      fireEvent.change(field, { target: { value: "133.5" } });
      fireEvent.keyDown(field, { key: "Enter" });
    });
    expect(projectBpm(runtime.settings)).toBe(133.5);
    expect((screen.getByLabelText("Tempo (BPM)") as HTMLInputElement).value).toBe("133.5");

    await act(async () => {
      fireEvent.change(screen.getByLabelText("Tempo source"), { target: { value: "audio" } });
    });
    expect(projectTempoSource(runtime.settings)).toBe("audio");
    runtime.dispose();
  });
});

describe("a Tempo node's Tap, driven by a control, taps the app's tempo (T1787b)", () => {
  it("a Panel button pressed twice 0.4 s apart: the app's own pulse watcher fires the tap, and the rendered frame reads 150", async () => {
    // The clock the app's tempo times a tap on (`app-runtime.ts`).
    let now = performance.now();
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const runtime = newRuntime();
    const fixture = await mountApp(runtime);
    const patch = async (operations: GraphPatchOperation[]) => {
      await act(async () => {
        const applied = await runtime.bus.execute("graph.applyPatch", { baseRevision: runtime.bus.store.getRevision(), operations, label: "test" }, runtime.invocation);
        expect(applied.status, JSON.stringify(applied.diagnostics)).toBe("applied");
      });
    };
    await patch([
      { op: "addNode", ref: "$button", type: "button", label: "button_tap", position: { x: 0, y: 300 } },
      {
        op: "addNode",
        ref: "$tempo",
        type: "tempo",
        label: "tempo_main",
        position: { x: 300, y: 300 },
        parameters: { tap: { mode: "expression", bindings: { static: { kind: "static", value: false }, expression: { kind: "expression", source: "op('button_tap').chan.value" } } } },
      },
    ]);
    const button = Object.values(runtime.bus.store.getGraph().nodes).find((node) => node.label === "button_tap");
    if (button === undefined) throw new Error("no button");
    /** What a press on the Panel or the phone writes, then one frame of the app's loop. */
    const press = async (held: boolean) => {
      await patch([{ op: "setParameters", nodeId: button.id, parameters: { held } }]);
      await act(async () => {
        fixture.tick();
      });
    };
    await act(async () => {
      fixture.tick();
    });
    await press(true);
    await press(false);
    expect(projectBpm(runtime.settings)).toBe(120);
    now += 400;
    await press(true);
    expect(projectBpm(runtime.settings)).toBe(150);
    await act(async () => {
      fixture.tick();
    });
    expect(lastScope(fixture)["bpm"]).toBe(150);
    runtime.dispose();
  });
});

describe("the Tap button taps (T1785b)", () => {
  it("two clicks 0.4 s apart store 150 bpm in the project", async () => {
    let seconds = 50;
    const { bus, store } = createHarness();
    const tempo = createProjectTempo({ now: () => seconds, settings: () => store.view.getSettings() });
    registerTempoCommands(bus, tempo);
    render(
      <TooltipProvider>
        <TempoControl bus={bus} invocation={contextFor(alice)} tempo={tempo} bpm={120} source="manual" />
      </TooltipProvider>,
    );
    const tap = screen.getByLabelText("Tap tempo");
    await act(async () => {
      fireEvent.click(tap);
    });
    seconds = 50.4;
    await act(async () => {
      fireEvent.click(tap);
    });
    expect(store.view.getSettings().bpm).toBe(150);
    // The lamp is a button too: it resyncs the downbeat.
    seconds = 51.1;
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Resync downbeat"));
    });
    expect(tempo.snapshot().beats).toBe(0);
  });
});

describe("MIDI realtime reaches the tempo from the MIDI input (T1786b)", () => {
  it("0xF8 / 0xFA / 0xFB / 0xFC are handed on with the message's own time, and are not controls", async () => {
    const port = { id: "port-clock", name: "Clock", onmidimessage: null as ((event: { data: Uint8Array; timeStamp: number }) => void) | null };
    const access = { onstatechange: null, inputs: { forEach: (callback: (input: typeof port) => void) => callback(port) } };
    const seen: Array<[number, number]> = [];
    const hook = renderHook(() =>
      useMidiInput({
        requestAccess: () => Promise.resolve(access as unknown as MIDIAccess),
        onRealtime: (status, atSeconds) => seen.push([status, atSeconds]),
      }),
    );
    await act(async () => {
      hook.result.current.request();
    });
    let learned = 0;
    hook.result.current.arm(() => (learned += 1));
    act(() => {
      port.onmidimessage?.({ data: new Uint8Array([0xfa]), timeStamp: 1000 });
      port.onmidimessage?.({ data: new Uint8Array([0xf8]), timeStamp: 1020.5 });
      port.onmidimessage?.({ data: new Uint8Array([0xfc]), timeStamp: 1030 });
      port.onmidimessage?.({ data: new Uint8Array([0xfb]), timeStamp: 1040 });
      // Active sensing is realtime too, and is nobody's clock.
      port.onmidimessage?.({ data: new Uint8Array([0xfe]), timeStamp: 1050 });
    });
    expect(seen).toEqual([
      [0xfa, 1],
      [0xf8, 1.0205],
      [0xfc, 1.03],
      [0xfb, 1.04],
    ]);
    expect(learned).toBe(0);
  });
});
