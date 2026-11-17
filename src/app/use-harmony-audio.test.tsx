// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flatDocument } from "@compiler/test-support.ts";
import type { GraphNode } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import { NO_FLATTENING } from "@domain/parameters/node-references.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { harmonyNode } from "@nodes/definitions/harmony.ts";
import { appAudioContext } from "./app-audio-context.ts";
import { createHarmonyAudio } from "./harmony-audio.ts";
import { createHarmonyAudioSession, useHarmonyAudio } from "./use-harmony-audio.ts";
import { liveClock } from "@domain/transport/live-clock.ts";

vi.mock("./app-audio-context.ts", () => ({ appAudioContext: vi.fn() }));
vi.mock("./harmony-audio.ts", () => ({ createHarmonyAudio: vi.fn() }));

const registry = createNodeRegistry([harmonyNode]).view();
const frame: FrameEvaluationInput = { timeSeconds: 1, absTimeSeconds: 100, deltaSeconds: 1 / 60,
  frameIndex: 60, randomSeed: 1, mode: "realtime" };
function node(id = "harmony_music", extra: Partial<GraphNode> = {}): GraphNode {
  return { id: id as NodeId, label: id, type: "harmony", definitionVersion: 1,
    position: { x: 0, y: 0 }, parameters: {}, ...extra };
}
function graphOf(...nodes: GraphNode[]) {
  return flatDocument({ revision: 1, nodes: Object.fromEntries(nodes.map(value => [value.id, value])), edges: {}, groups: {} });
}
const instruments: Array<{ readiness: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; timeSeconds: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }> = [];
let context: { state: AudioContextState; currentTime: number };
beforeEach(() => {
  vi.clearAllMocks();
  instruments.length = 0;
  context = { state: "running", currentTime: 10 };
  vi.mocked(appAudioContext).mockImplementation(() => context as AudioContext);
  vi.mocked(createHarmonyAudio).mockImplementation(() => {
    const instrument = { readiness: vi.fn(() => ({ kind: "ready" as const })), update: vi.fn(), timeSeconds: vi.fn(() => 100), dispose: vi.fn() };
    instruments.push(instrument);
    return instrument;
  });
});
afterEach(cleanup);

describe("Harmony live session", () => {
  it("freezes the shared clock while the recorded instrument loads, then resumes", () => {
    const session = createHarmonyAudioSession({ graph: () => graphOf(node()), registry });
    session.now();session.sync(frame, undefined, true, false);
    const instrument = instruments[0]!;
    instrument.readiness.mockReturnValue({ kind: "loading" });
    context.currentTime += 3;
    expect(session.now()).toBe(0);expect(session.status().kind).toBe("loading");
    instrument.readiness.mockReturnValue({ kind: "ready" });
    context.currentTime += 0.1;expect(session.now()).toBeCloseTo(100);
    instrument.readiness.mockReturnValue({ kind: "error", message: "missing piano" });
    expect(session.status()).toEqual({ kind: "unavailable", message: "missing piano" });
    session.dispose();
  });

  it("holds musical time across a long transport pause and resumes without skipping", () => {
    const session = createHarmonyAudioSession({ graph: () => graphOf(node()), registry });
    const clock = liveClock({ fps: 30, now: session.now, authoritativeClock: session.ownsClock, presenting: () => true });
    session.sync(clock.next(), undefined, true, false);
    context.currentTime += 0.1;
    const before = clock.next();
    expect(before.absTimeSeconds).toBeCloseTo(0.1);
    session.pause();
    context.currentTime += 5;
    const resumed = clock.next();
    expect(resumed.absTimeSeconds).toBeCloseTo(0.1);
    session.sync(resumed, undefined, true, false);
    context.currentTime += 0.1;
    expect(clock.next().absTimeSeconds).toBeCloseTo(0.2);
    session.dispose();
  });

  it("retains the final audio-clock delta observed after context suspension", () => {
    const session = createHarmonyAudioSession({ graph: () => graphOf(node()), registry });
    expect(session.now()).toBe(0);
    context.currentTime += 0.125;
    context.state = "suspended";
    expect(session.now()).toBe(125);
    expect(session.now()).toBe(125);
    context.state = "running";
    context.currentTime += 0.125;
    expect(session.now()).toBe(250);
    session.dispose();
  });

  it("owns the clock while Harmony is present, including suspension, and reconciles removal", () => {
    let graph = graphOf();
    const session = createHarmonyAudioSession({ graph: () => graph, registry });
    expect(session.ownsClock()).toBe(false);
    graph = graphOf(node());
    session.sync(frame, undefined, true, false);
    expect(session.ownsClock()).toBe(true);
    context.state = "suspended";
    expect(session.ownsClock()).toBe(true);
    graph = graphOf();
    expect(session.ownsClock()).toBe(false);
    expect(instruments[0]!.dispose).toHaveBeenCalledOnce();
  });

  it("resolves schema defaults and uses absolute time across timeline laps", () => {
    const session = createHarmonyAudioSession({ graph: () => graphOf(node()), registry });
    session.sync(frame, undefined, true, false);
    expect(createHarmonyAudio).toHaveBeenCalledWith(context);
    expect(instruments[0]!.update).toHaveBeenCalledWith(100, {
      seed: 31415, tempo: 68, initialKey: 2, initialMode: "minor",
      harmonicComplexity: 0.58, evolutionRate: 0.35, musicalEnergy: 0.45,
    }, true, 0.55);
    session.sync({ ...frame, timeSeconds: 0, absTimeSeconds: 101 }, undefined, true, false);
    expect(instruments[0]!.update.mock.lastCall?.[0]).toBe(101);
    session.dispose();
  });

  it("reads frame expressions and current channel references through parameterReadOptions", () => {
    const expression = (source: string) => ({ mode: "expression" as const,
      bindings: { expression: { kind: "expression" as const, source } } });
    const graph = graphOf(node("harmony_source"), node("harmony_music", { parameters: {
      tempo: expression("60 + time"), volume: expression("op('harmony_source').chan.level"),
    } }));
    const flattening = vi.fn(() => NO_FLATTENING);
    const session = createHarmonyAudioSession({ graph: () => graph, registry, flattening });
    session.sync(frame, () => 0.25, true, false);
    expect(flattening).toHaveBeenCalledOnce();
    expect(instruments[0]!.update).toHaveBeenCalledWith(100, expect.objectContaining({ tempo: 61 }), true, 0.25);
    session.dispose();
  });

  it("mixes all nodes in stable id order and reconciles edits, mute, bypass and replacement", () => {
    let graph = graphOf(node("harmony_z", { parameters: { seed: 2 } }), node("harmony_a", { parameters: { seed: 1 } }));
    const session = createHarmonyAudioSession({ graph: () => graph, registry });
    session.sync(frame, undefined, true, false);
    expect(instruments.map(instrument => instrument.update.mock.lastCall?.[1].seed)).toEqual([1, 2]);
    expect(instruments.map(instrument => instrument.update.mock.lastCall?.[0])).toEqual([100, 100]);
    graph = graphOf(node("harmony_a", { parameters: { seed: 3 }, ui: { muted: true } }), node("harmony_z", { ui: { bypassed: true } }));
    session.sync(frame, undefined, true, false);
    expect(instruments).toHaveLength(2);
    expect(instruments[0]!.dispose).toHaveBeenCalledOnce();
    expect(instruments[1]!.dispose).toHaveBeenCalledOnce();
    graph = graphOf(node("harmony_replacement"));
    session.sync(frame, undefined, true, false);
    expect(instruments[0]!.dispose).toHaveBeenCalledOnce();
    expect(instruments[1]!.dispose).toHaveBeenCalledOnce();
    graph = graphOf();
    session.sync(frame, undefined, true, false);
    expect(instruments[2]!.dispose).toHaveBeenCalledOnce();
  });

  it("stops live instruments during pause and blocked/offline sync; never constructs for export", () => {
    const graph = graphOf(node());
    const session = createHarmonyAudioSession({ graph: () => graph, registry });
    session.sync(frame, undefined, true, true);
    session.sync({ ...frame, mode: "offline" }, undefined, true, false);
    expect(createHarmonyAudio).not.toHaveBeenCalled();
    session.sync(frame, undefined, true, false);
    session.pause();
    expect(instruments[0]!.update).toHaveBeenLastCalledWith(100, expect.any(Object), false, 0);
    session.sync(frame, undefined, true, true);
    expect(instruments[0]!.update.mock.lastCall?.[2]).toBe(false);
    session.sync(frame, undefined, false, false);
    expect(instruments[0]!.update.mock.lastCall?.[2]).toBe(false);
    session.dispose();
  });

  it("uses performance without Harmony, then switches continuously to the audio master and back", () => {
    let graph = graphOf();
    let wall = 5000;
    const session = createHarmonyAudioSession({ graph: () => graph, registry, performanceNow: () => wall });
    expect(session.now()).toBe(5000);
    wall += 100;
    expect(session.now()).toBe(5100);
    expect(appAudioContext).not.toHaveBeenCalled();
    graph = graphOf(node());
    expect(session.now()).toBe(5100);
    context.currentTime += 0.25;
    wall += 10000;
    expect(session.now()).toBe(5350);
    context.state = "suspended";
    expect(session.status()).toEqual({ kind: "suspended" });
    expect(session.now()).toBe(5350);
    wall += 10000;
    expect(session.now()).toBe(5350);
    context.state = "running";
    context.currentTime += 0.125;
    expect(session.now()).toBe(5475);
    graph = graphOf();
    expect(session.now()).toBe(5475);
    wall += 50;
    expect(session.now()).toBe(5525);
    expect(session.status()).toEqual({ kind: "idle" });
  });

  it("reports unavailable Web Audio explicitly and freezes the Harmony clock", () => {
    vi.mocked(appAudioContext).mockReturnValue(null);
    const session = createHarmonyAudioSession({ graph: () => graphOf(node()), registry });
    expect(session.status()).toEqual({ kind: "unavailable", message: "Harmony audio requires Web Audio." });
    expect(session.now()).toBe(0);
    session.sync(frame, undefined, true, false);
    expect(createHarmonyAudio).not.toHaveBeenCalled();
  });

  it("releases instruments when the shared context is replaced, even if now discovers it first", () => {
    const session = createHarmonyAudioSession({ graph: () => graphOf(node()), registry });
    session.sync(frame, undefined, true, false);
    session.now();
    context.state = "closed";
    context = { state: "running", currentTime: 0 };
    expect(session.now()).toBe(0);
    session.sync(frame, undefined, true, false);
    expect(instruments[0]!.dispose).toHaveBeenCalledOnce();
    expect(instruments).toHaveLength(2);
    session.dispose();
  });

  it("keeps hook methods stable, propagates pause, and releases resources on unmount", () => {
    const graph = graphOf(node());
    const { result, rerender, unmount } = renderHook(({ playing }) => useHarmonyAudio({ graph: () => graph, registry, playing }),
      { initialProps: { playing: true } });
    const session = result.current;
    session.sync(frame, undefined, true, false);
    rerender({ playing: false });
    expect(result.current).toBe(session);
    expect(instruments[0]!.update.mock.lastCall?.[2]).toBe(false);
    unmount();
    expect(instruments[0]!.dispose).toHaveBeenCalledOnce();
  });

  it("prunes removal and mute through now without a rendered frame", () => {
    let graph = graphOf(node("harmony_a"), node("harmony_b"));
    const session = createHarmonyAudioSession({ graph: () => graph, registry });
    session.sync(frame, undefined, true, false);
    graph = graphOf(node("harmony_b", { ui: { muted: true } }));
    session.now();
    expect(instruments[0]!.dispose).toHaveBeenCalledOnce();
    expect(instruments[1]!.dispose).toHaveBeenCalledOnce();
    expect(instruments).toHaveLength(2);
  });

  it("disposes a same-id document replacement while paused through the hook render effect", () => {
    let graph = graphOf(node());
    const { result, rerender } = renderHook(({ playing }) => useHarmonyAudio({ graph: () => graph, registry, playing }),
      { initialProps: { playing: true } });
    result.current.sync(frame, undefined, true, false);
    rerender({ playing: false });
    graph = graphOf(node());
    rerender({ playing: false });
    expect(instruments[0]!.dispose).toHaveBeenCalledOnce();
    expect(instruments).toHaveLength(1);
  });

  it("retains instruments on live value edits and disposes on an explicit document boundary", () => {
    let graph = graphOf(node());
    const { result, rerender } = renderHook(({ documentKey }) => useHarmonyAudio({ graph: () => graph, registry,
      playing: true, documentKey }), { initialProps: { documentKey: {} } });
    result.current.sync(frame, undefined, true, false);
    graph = graphOf(node("harmony_music", { parameters: { seed: 7 } }));
    rerender({ documentKey: result.current as object });
    expect(instruments[0]!.dispose).toHaveBeenCalledOnce();
    result.current.sync(frame, undefined, true, false);
    const documentKey = result.current;
    graph = graphOf(node("harmony_music", { parameters: { seed: 8 } }));
    rerender({ documentKey });
    result.current.sync(frame, undefined, true, false);
    expect(instruments).toHaveLength(2);
    expect(instruments[1]!.dispose).not.toHaveBeenCalled();
    expect(instruments[1]!.update.mock.lastCall?.[1].seed).toBe(8);
  });
});
