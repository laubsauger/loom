import { afterEach, describe, expect, it, vi } from "vitest";

import { createValueGraphSession } from "@domain/channels/value-graph.ts";
import { evaluateExpression, scopeFromFrame } from "@domain/expressions/evaluate.ts";
import { decodeMidiMessage, midiChannelName, type MidiSource } from "@domain/midi/midi-mapping.ts";
import { createPulseWatcher } from "@domain/parameters/pulse.ts";
import { RENDER_BLOCKED_PULSE_COMMANDS } from "@domain/presets/commands.ts";
import { projectBpm } from "@domain/tempo/project-tempo.ts";
import { liveClock } from "@domain/transport/live-clock.ts";
import type { EvaluationFrame } from "@domain/types/frame.ts";
import type { GraphNode } from "@domain/types/graph.ts";
import type { StoredParameter } from "@domain/types/parameters.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { createAppRuntime, type AppRuntime } from "./app-runtime.ts";

/**
 * T1787b — the Tempo node, read the way a project reads it.
 *
 * Everything here runs on the app's own runtime (`createAppRuntime`: the real bus, the
 * real `tempo.*` commands, the runtime's own `ProjectTempo`), the live clock stamped by
 * that tempo, the value graph and the pulse watcher, on a wall clock the test owns. One
 * frame of this file is what `use-frame-loop` and `pulse-firing.ts` do for one frame:
 * evaluate the value graph, step the watcher with the graph's resolver, dispatch
 * `parameter.pulse` for each fire. (`tempo-app.test.tsx` proves the mounted app does it.)
 *
 * What is asserted is what a consumer reads back: the node's channels, the `bpm` an
 * unrelated expression gets on the next frame, the BPM the document stores.
 */
const expression = (source: string, retained: number | boolean): StoredParameter => ({
  mode: "expression",
  bindings: { static: { kind: "static", value: retained }, expression: { kind: "expression", source } },
});
const add = (type: string, label: string, parameters: Record<string, StoredParameter> = {}): GraphPatchOperation => ({
  op: "addNode",
  ref: `$${label}`,
  type,
  label,
  position: { x: 0, y: 0 },
  parameters,
});

const runtimes: AppRuntime[] = [];
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose();
  vi.restoreAllMocks();
});

async function rig(operations: GraphPatchOperation[]) {
  let seconds = 100;
  // The clock the app's tempo reads (`app-runtime.ts`): taps are timed on it.
  vi.spyOn(performance, "now").mockImplementation(() => seconds * 1000);
  const runtime = createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "tempo-node-test" } });
  runtimes.push(runtime);
  const patch = async (ops: GraphPatchOperation[]): Promise<void> => {
    const result = await runtime.bus.execute("graph.applyPatch", { baseRevision: runtime.bus.store.getRevision(), label: "test patch", operations: ops }, runtime.invocation);
    expect(result.output.status, JSON.stringify(result.output.diagnostics)).toBe("applied");
  };
  await patch(operations);
  const named = (label: string): GraphNode => {
    const node = Object.values(runtime.bus.store.getGraph().nodes).find((each) => each.label === label);
    if (node === undefined) throw new Error(`Missing node "${label}".`);
    return node;
  };
  const clock = liveClock({ now: () => seconds * 1000, presenting: () => true, tempo: runtime.tempo.read, fps: 60 });
  const values = createValueGraphSession(runtime.registry);
  const watcher = createPulseWatcher(runtime.bus.registry);
  /** One frame of the app: the value graph, then the pulses its channels arm. `midi` is the hardware's readings. */
  const frame = async (midi: (name: string) => number | undefined = () => undefined) => {
    const produced = clock.next();
    const flattened = runtime.flattened.current();
    const result = values.evaluate(flattened.graph, produced, { flattening: flattened, channels: midi });
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    for (const fire of watcher.step(flattened.graph, produced, result.resolver, flattened)) {
      const fired = await runtime.bus.execute("parameter.pulse", { nodeId: fire.nodeId, parameterKey: fire.key }, runtime.invocation);
      expect(fired.status, JSON.stringify(fired.diagnostics)).toBe("applied");
    }
    return { frame: produced, channels: (label: string) => result.byName.get(label) ?? {} };
  };
  return {
    runtime,
    patch,
    named,
    frame,
    at: (next: number): void => void (seconds = 100 + next),
    set: (label: string, parameters: Record<string, StoredParameter>) => patch([{ op: "setParameters", nodeId: named(label).id, parameters }]),
  };
}

function bare(frame: EvaluationFrame, source: string): number {
  const result = evaluateExpression(source, scopeFromFrame(frame));
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}

describe("the Tempo node publishes the project clock (T1787b)", () => {
  it("its channels are the bare expression names on the same frame, and a wire away from them", async () => {
    const r = await rig([
      add("tempo", "tempo_main"),
      add("constant", "constant_reader", { value: expression("op('tempo_main').chan.beat + op('tempo_main').chan.beatPhase", 0) }),
    ]);
    await r.runtime.bus.execute("tempo.set", { bpm: 90 }, r.runtime.invocation);
    await r.frame();
    for (const seconds of [0.37, 1.9, 2, 5.01, 8]) {
      r.at(seconds);
      const { frame, channels } = await r.frame();
      const published = channels("tempo_main");
      expect({
        bpm: published["bpm"],
        beat: published["beat"],
        beatphase: published["beatPhase"],
        beatpulse: published["beatCount"],
        bar: published["bar"],
        barphase: published["barPhase"],
        tempolocked: published["locked"],
      }).toEqual({
        bpm: bare(frame, "bpm"),
        beat: bare(frame, "beat"),
        beatphase: bare(frame, "beatphase"),
        beatpulse: bare(frame, "beatpulse"),
        bar: bare(frame, "bar"),
        barphase: bare(frame, "barphase"),
        tempolocked: bare(frame, "tempolocked"),
      });
      // And what a node reading the channels by name gets: 90 bpm is 1.5 beats a second.
      expect(channels("constant_reader")["value"]).toBeCloseTo(seconds * 1.5, 9);
    }
    // The numbers themselves, so "equal" cannot mean "both wrong": 8 s at 90 bpm is beat 12
    // = bar 3 exactly.
    const last = await r.frame();
    expect(last.channels("tempo_main")).toMatchObject({ bpm: 90, beat: 12, bar: 3, locked: 1 });
    expect(last.channels("tempo_main")["barPhase"]).toBeCloseTo(0, 9);
  });

  it("Every puts ramp, pulse and count on a half-beat or a four-beat grid and leaves the beat channels alone", async () => {
    const r = await rig([add("tempo", "tempo_main", { every: "0.5" })]);
    await r.runtime.bus.execute("tempo.set", { bpm: 60 }, r.runtime.invocation);
    await r.frame();
    r.at(0.25);
    expect((await r.frame()).channels("tempo_main")).toMatchObject({ ramp: 0.5, pulse: 0, count: 0, beat: 0, beatCount: 0 });
    // 0.625 beats: the half-beat landed in this frame, and no beat did.
    r.at(0.625);
    expect((await r.frame()).channels("tempo_main")).toMatchObject({ ramp: 0.25, pulse: 1, count: 1, beat: 0, beatCount: 0 });
    // 1.125 beats: one more half, and it is the beat too.
    r.at(1.125);
    expect((await r.frame()).channels("tempo_main")).toMatchObject({ ramp: 0.25, pulse: 1, count: 2, beat: 1, beatCount: 1 });

    await r.set("tempo_main", { every: "4" });
    // 3.5 beats: beats 2 and 3 landed since the last frame, and no four-beat period did.
    r.at(3.5);
    expect((await r.frame()).channels("tempo_main")).toMatchObject({ ramp: 0.875, pulse: 0, count: 0, beat: 3, beatCount: 2 });
    // 4.5 beats: beat 4 opens the second four, so the period and the beat both land.
    r.at(4.5);
    const second = (await r.frame()).channels("tempo_main");
    expect(second).toMatchObject({ ramp: 0.125, pulse: 1, count: 1, beat: 4, beatCount: 1 });
    expect(second["ramp"]).toBe(second["barPhase"]);
    // 5.5 beats: a beat lands and the four-beat period does not.
    r.at(5.5);
    expect((await r.frame()).channels("tempo_main")).toMatchObject({ pulse: 0, count: 1, beat: 5, beatCount: 1 });
  });

  it("a session's first frame is the downbeat and nothing has landed on it", async () => {
    const r = await rig([add("tempo", "tempo_main")]);
    const first = await r.frame();
    expect(first.channels("tempo_main")).toMatchObject({ beat: 0, beatPhase: 0, beatCount: 0, pulse: 0 });
    expect(bare(first.frame, "beatpulse")).toBe(0);
  });
});

describe("Tap and Resync are pulses on the project tempo (T1787b)", () => {
  /** A Panel Button whose channel drives Tap, and a node that only reads `bpm`. */
  const tapRig = () =>
    rig([
      add("button", "button_tap"),
      add("tempo", "tempo_main", { tap: expression("op('button_tap').chan.value", false) }),
      add("constant", "constant_reader", { value: expression("bpm", 0) }),
    ]);

  it("the Tap pulse turned on twice, 0.4 s apart, makes the tempo an unrelated expression reads 150", async () => {
    const r = await tapRig();
    expect((await r.frame()).channels("constant_reader")).toEqual({ value: 120 });
    // What a press on the Panel or the phone writes (`control-widget.tsx`): held, then not.
    await r.set("button_tap", { held: true });
    await r.frame();
    // One tap is no tempo yet.
    expect(projectBpm(r.runtime.settings)).toBe(120);
    await r.set("button_tap", { held: false });
    r.at(0.1);
    await r.frame();
    r.at(0.4);
    await r.set("button_tap", { held: true });
    await r.frame();
    expect(projectBpm(r.runtime.settings)).toBe(150);
    r.at(0.41);
    const after = await r.frame();
    expect(after.channels("constant_reader")).toEqual({ value: 150 });
    expect(after.channels("tempo_main")["bpm"]).toBe(150);
    // Held is a level, not a stream of taps: the frames it stays on tap nothing more.
    r.at(0.9);
    await r.frame();
    r.at(1.4);
    await r.frame();
    expect(projectBpm(r.runtime.settings)).toBe(150);
  });

  it("the tap is a beat: the frame after it reads phase 0 and a pulse on every grid", async () => {
    const r = await tapRig();
    await r.set("tempo_main", { every: "2" });
    await r.frame();
    // 1.2 s at 120 is beat 2.4; the tap pulls it to beat 2, which opens a two-beat period.
    r.at(1.2);
    await r.frame();
    await r.set("button_tap", { held: true });
    await r.frame();
    const landed = (await r.frame()).channels("tempo_main");
    expect(landed).toMatchObject({ beat: 2, beatPhase: 0, beatCount: 1, pulse: 1, count: 1, ramp: 0 });
  });

  it("a MIDI key learned onto the button taps the tempo, however softly it is played", async () => {
    const r = await tapRig();
    const key: MidiSource = { kind: "note", channel: 1, number: 36 };
    // The real learn: the command the Panel's Learn runs, writing the MIDI In row and the button's read.
    const learned = await r.runtime.bus.execute("control.learnMidi", { nodeId: r.named("button_tap").id, parameterKey: "held", source: key, portId: "nord" }, r.runtime.invocation);
    expect(learned.output.status, JSON.stringify(learned.output.diagnostics)).toBe("applied");

    /** The session's reading for the bytes a keyboard sent last (`use-midi-input.ts`). */
    const hardware = (bytes: readonly number[]) => {
      const reading = decodeMidiMessage(Uint8Array.from(bytes));
      if (reading === null) throw new Error("not a learnable message");
      return (name: string) => (name === midiChannelName("nord", reading.source) ? reading.raw : undefined);
    };
    const down = hardware([0x90, 36, 9]); // note on, velocity 9 of 127
    const up = hardware([0x80, 36, 0]);
    await r.frame(up);
    await r.frame(down);
    r.at(0.1);
    await r.frame(up);
    r.at(0.5);
    await r.frame(down);
    expect(projectBpm(r.runtime.settings)).toBe(120);
    r.at(0.6);
    // Note on with velocity 0 is the release.
    await r.frame(hardware([0x90, 36, 0]));
    r.at(0.9);
    await r.frame(down);
    // Three taps at 0, 0.5 and 0.9 s: the median interval is 0.45 s.
    expect(projectBpm(r.runtime.settings)).toBe(133.3);
    r.at(0.91);
    expect((await r.frame(down)).channels("constant_reader")).toEqual({ value: 133.3 });
    // Another key of the same keyboard is not this control.
    r.at(1.3);
    await r.frame(hardware([0x90, 37, 100]));
    expect(projectBpm(r.runtime.settings)).toBe(133.3);
  });

  it("Resync puts beat zero of bar zero at now, from the node's own button", async () => {
    const r = await rig([add("tempo", "tempo_main")]);
    await r.frame();
    r.at(2.75);
    expect((await r.frame()).channels("tempo_main")).toMatchObject({ beat: 5, bar: 1 });
    // The inspector's pulse button (`parameter-editor.ts`).
    const fired = await r.runtime.bus.execute("parameter.pulse", { nodeId: r.named("tempo_main").id, parameterKey: "resync" }, r.runtime.invocation);
    expect(fired.output).toEqual({ fired: "tempo.resync" });
    expect((await r.frame()).channels("tempo_main")).toMatchObject({ beat: 0, bar: 0, beatPhase: 0, beatCount: 1, pulse: 1 });
    expect(projectBpm(r.runtime.settings)).toBe(120);
  });

  it("neither pulse fires during a take: a render leaves the document's tempo as it found it", () => {
    // `pulse-firing.ts` withholds exactly this set while a take runs (T1497b).
    expect(RENDER_BLOCKED_PULSE_COMMANDS.has("tempo.tap")).toBe(true);
    expect(RENDER_BLOCKED_PULSE_COMMANDS.has("tempo.resync")).toBe(true);
  });
});
