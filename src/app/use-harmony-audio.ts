import { useEffect, useRef } from "react";
import type { FlatGraph } from "@domain/types/graph.ts";
import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { isSilencedSource } from "@domain/graph/bypass.ts";
import { parameterReadOptions, resolveParameterSchema, type ChannelResolver } from "@domain/parameters/index.ts";
import { effectiveParameterSchema } from "@domain/parameters/resolve.ts";
import { NO_FLATTENING, type FlatteningReads } from "@domain/parameters/node-references.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";
import { harmonyConfig } from "@nodes/definitions/harmony.ts";
import { appAudioContext } from "./app-audio-context.ts";
import { createHarmonyAudio, type HarmonyAudio } from "./harmony-audio.ts";

export interface HarmonyAudioOptions {
  readonly graph: () => FlatGraph;
  readonly registry: NodeRegistryView;
  readonly flattening?: () => FlatteningReads | undefined;
  readonly playing?: boolean | undefined;
  /** Stable project/session identity; change on document open even when node ids are reused. */
  readonly documentKey?: string | object | undefined;
  /** App-level transport clock, in milliseconds, used by documents without Harmony. */
  readonly performanceNow?: () => number;
}

export type HarmonyAudioStatus =
  | { readonly kind: "idle" | "running" | "suspended" | "loading" }
  | { readonly kind: "unavailable"; readonly message: string };

export interface HarmonyAudioSession {
  sync(frame: FrameEvaluationInput, resolver: ChannelResolver | undefined, playing: boolean, blocked: boolean): void;
  pause(): void;
  dispose(): void;
  /** Continuous milliseconds for the transport; a suspended audio context freezes it. */
  now(): number;
  ownsClock(): boolean;
  status(): HarmonyAudioStatus;
}

/** The browser instrument owns audio resources; graph evaluation remains pure and silent. */
export function createHarmonyAudioSession(options: HarmonyAudioOptions): HarmonyAudioSession {
  const instruments = new Map<NodeId, { audio: HarmonyAudio; config: ReturnType<typeof harmonyConfig>; time: number }>();
  let context: AudioContext | null = null;
  let instrumentContext: AudioContext | null = null;
  let previousGraph: FlatGraph | undefined;
  let previousRegistry = options.registry;
  let previousDocumentKey = options.documentKey;
  let running = options.playing ?? true;
  let clockSource: AudioContext | "performance" | "unavailable" | undefined;
  let lastRaw = 0;
  let milliseconds = 0;
  const performanceNow = () => options.performanceNow?.() ?? performance.now();
  const nodes = (graph: FlatGraph) => Object.values(graph.nodes).filter(node => node.type === "harmony")
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const audioContext = () => {
    if (context === null || context.state === "closed") context = appAudioContext();
    return context;
  };
  const dispose = () => {
    for (const instrument of instruments.values()) instrument.audio.dispose();
    instruments.clear();
    instrumentContext = null;
  };
  const pause = () => {
    running = false;
    for (const instrument of instruments.values()) {
      instrument.audio.update(instrument.time, instrument.config, false, 0);
    }
  };
  const reconcile = (graph: FlatGraph) => {
    // A paused replacement cannot wait for another rendered frame. Value-only edits
    // during playback retain instruments; document identity is supplied by the app.
    if (options.registry !== previousRegistry || options.documentKey !== previousDocumentKey ||
      (!(options.playing ?? running) && previousGraph !== undefined && graph !== previousGraph)) dispose();
    previousGraph = graph;
    previousRegistry = options.registry;
    previousDocumentKey = options.documentKey;
    for (const [id, instrument] of instruments) {
      const node = graph.nodes[id];
      if (node?.type !== "harmony" || isSilencedSource(node)) {
        instrument.audio.dispose();
        instruments.delete(id);
      }
    }
    return nodes(graph);
  };

  return {
    sync(frame, resolver, playing, blocked) {
      const graph = options.graph();
      running = playing && !blocked && frame.mode !== "offline";
      const harmony = reconcile(graph);
      if (harmony.length === 0) return;
      const currentContext = audioContext();
      if (instrumentContext !== null && instrumentContext !== currentContext) dispose();
      if (currentContext === null) { dispose(); return; }
      const read = parameterReadOptions({ graph, registry: options.registry, frame, channels: resolver,
        flattening: options.flattening?.() ?? NO_FLATTENING });
      for (const node of harmony) {
        const definition = options.registry.get(node.type);
        if (definition === undefined) throw new Error("Harmony audio requires a registered Harmony definition.");
        const resolved = resolveParameterSchema(node, effectiveParameterSchema(definition, node.parameters), read);
        if (resolved.diagnostics.some(diagnostic => diagnostic.severity === "error")) {
          pause();
          throw new Error(`Harmony audio parameter resolution failed: ${resolved.diagnostics.map(diagnostic => diagnostic.message).join("; ")}`);
        }
        const config = harmonyConfig(resolved.values);
        const time = frame.absTimeSeconds ?? frame.timeSeconds;
        const enabled = playing && !blocked && frame.mode !== "offline" && !isSilencedSource(node);
        let instrument = instruments.get(node.id);
        // A blocked export never needs to construct a live instrument.
        if (instrument === undefined && !enabled) continue;
        if (instrument === undefined) {
          instrument = { audio: createHarmonyAudio(currentContext), config, time };
          instruments.set(node.id, instrument);
          instrumentContext = currentContext;
        }
        instrument.config = config;
        instrument.time = time;
        instrument.audio.update(time, config, enabled, Number(resolved.values["volume"]));
      }
    },
    pause,
    dispose,
    now() {
      const hasHarmony = reconcile(options.graph()).length > 0;
      const currentContext = hasHarmony ? audioContext() : null;
      const source = hasHarmony ? currentContext ?? "unavailable" : "performance";
      const raw = source === "performance" ? performanceNow() : currentContext === null ? 0 : currentContext.currentTime * 1000;
      if (clockSource === undefined) milliseconds = source === "performance" ? raw : 0;
      // A paused performance holds its position even while the shared context serves
      // other sounds. A suspended context already stops currentTime; retain its final delta.
      else if (clockSource === source && (source === "performance" || (running && [...instruments.values()].every(instrument => instrument.audio.readiness().kind === "ready")))) {
        milliseconds += Math.max(0, raw - lastRaw);
      }
      clockSource = source;
      lastRaw = raw;
      return milliseconds;
    },
    ownsClock() {
      return reconcile(options.graph()).length > 0;
    },
    status() {
      if (reconcile(options.graph()).length === 0) return { kind: "idle" };
      const currentContext = audioContext();
      if (currentContext === null) return { kind: "unavailable", message: "Harmony audio requires Web Audio." };
      for (const instrument of instruments.values()) {
        const ready = instrument.audio.readiness();
        if (ready.kind === "error") return { kind: "unavailable", message: ready.message };
        if (ready.kind === "loading") return { kind: "loading" };
      }
      return { kind: currentContext.state === "running" ? "running" : "suspended" };
    },
  };
}

export function useHarmonyAudio(options: HarmonyAudioOptions): HarmonyAudioSession {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const sessionRef = useRef<HarmonyAudioSession | null>(null);
  if (sessionRef.current === null) {
    sessionRef.current = createHarmonyAudioSession({
      graph: () => optionsRef.current.graph(),
      get registry() { return optionsRef.current.registry; },
      get documentKey() { return optionsRef.current.documentKey; },
      get playing() { return optionsRef.current.playing; },
      flattening: () => optionsRef.current.flattening?.(),
      performanceNow: () => optionsRef.current.performanceNow?.() ?? performance.now(),
    });
  }
  const session = sessionRef.current;
  useEffect(() => () => session.dispose(), [session]);
  // Structural edits and document opens also render while the transport is paused.
  useEffect(() => { session.now(); });
  useEffect(() => { if (options.playing === false) session.pause(); }, [options.playing, session]);
  return session;
}
