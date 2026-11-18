import { useEffect, useMemo, useRef, useState } from "react";
import { SINK_TARGET_PORT } from "@compiler/index.ts";
import type { CompiledGraph } from "@compiler/index.ts";
import type { FlatGraph } from "@domain/types/graph.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import { isSilencedSource } from "@domain/graph/bypass.ts";
import { parameterReadOptions, resolveParameters, resolveStored } from "@domain/parameters/index.ts";
import { EMISSION_PUMPS } from "@domain/render/emission-pumps.ts";
import { emissionRefusal } from "@domain/render/side-effects.ts";
import type { WhipSectionSurface, WhipSectionView } from "@editor/inspector/whip-section.tsx";
import { WHIP_DEFAULT_PROFILE, WHIP_PROFILES } from "@nodes/definitions/whip-out.ts";
import type { LoomBackend, PresentationHandle } from "@runtime/backend/index.ts";
import { appProgramStream } from "./app-audio-context.ts";
import type { AppRuntime } from "./app-runtime.ts";
import type { DisplaySinkStore } from "./display-sinks.ts";
import { renderRangeHolderFor } from "./render-range.ts";
import { createWhipPublisher, sendsTokenInClear, whipEndpoint } from "./whip-publisher.ts";
import type { WhipPublisher, WhipPublisherDeps } from "./whip-publisher.ts";

/**
 * §T1809b — THE WHIP PUMP (design `docs/whip-out-design-2026-11-17.md`): every WHIP Out
 * that should be publishing gets a canvas of its own at the node's Width × Height, the
 * node's `$target` presented into it, the canvas captured at Frame rate, and one WHIP
 * session. Registered in `EMISSION_PUMPS`; `emissionRefusal` is asked per node per tick,
 * so a take ends the stream and says why.
 *
 * The nodes that should publish are written to `sinks` (a display-sink store of this
 * pump's own): a WHIP Out renders only while it is named there, as a Window Out renders
 * only while its window is open.
 *
 * SESSION STATE, never the document: the open sessions, their status, and the bearer
 * tokens (`setToken`), which live in this hook's memory per node and go with the document.
 *
 * The tick runs on the backend's frames AND on a one-second timer: with the editor hidden
 * and no perform window its frames are parked, and a Publish switched off must still end
 * the session.
 */

const TYPES = new Set(Object.entries(EMISSION_PUMPS)
  .filter(([, path]) => path === "src/app/use-whip-outputs.ts").map(([type]) => type));

const SERVICE_MS = 1000;
const OFF: WhipSectionView = { state: "off", message: "Off. Turn Publish on to send.", measured: null, hasToken: false, tokenInClear: false };

interface Entry {
  readonly key: string;
  readonly canvas: HTMLCanvasElement;
  readonly presentation: PresentationHandle;
  readonly tracks: readonly MediaStreamTrack[];
  readonly publisher: WhipPublisher;
  outputId: string;
  /** The canvas track, asked for one frame at a time (see `pace`). */
  readonly video: CanvasCaptureMediaStreamTrack;
  /** Milliseconds between captured frames. */
  readonly interval: number;
  /** The frame-clock time the next capture is due at. */
  due: number;
}

export interface WhipOutputsOptions {
  readonly runtime: AppRuntime;
  readonly backend: LoomBackend | null;
  readonly graph: FlatGraph;
  /** The INSTALLED plan: where each publishing node's `$target` lives. */
  readonly compiled: CompiledGraph | null;
  /** This pump's display sinks, merged into the compile's sink list by the caller. */
  readonly sinks: DisplaySinkStore;
  /** The browser pieces of a session, for a test; the real ones by default. */
  readonly publisherDeps?: WhipPublisherDeps;
}

export interface WhipOutputs {
  readonly diagnostics: readonly RuntimeDiagnostic[];
  readonly surface: WhipSectionSurface;
}

const num = (value: unknown, fallback: number): number => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

export function useWhipOutputs({ runtime, backend, graph, compiled, sinks, publisherDeps }: WhipOutputsOptions): WhipOutputs {
  const [diagnostics, setDiagnostics] = useState<readonly RuntimeDiagnostic[]>([]);
  const requests = useMemo(() =>
    Object.values(graph.nodes).filter(node => TYPES.has(node.type) && !isSilencedSource(node)).map(node => {
      const definition = runtime.registry.get(node.type)!;
      // The document (`resolveStored`): a session is keyed on these, per revision.
      const values = resolveStored(node, definition).values;
      // As Syphon/NDI Out (§T1559b): Publish follows a driven value, read per tick.
      const enabled = () =>
        resolveParameters(node, definition, parameterReadOptions({ ...runtime.bus.readScope(), graph })).values["enabled"] === true;
      const width = Math.floor(num(values["width"], 1920));
      const height = Math.floor(num(values["height"], 1080));
      const frameRate = Math.min(60, Math.max(1, Math.round(num(values["frameRate"], 30))));
      const kbps = Math.max(100, Math.round(num(values["bitrate"], 16000)));
      const audio = values["audio"] === true;
      const profile = WHIP_PROFILES.find(entry => entry.value === values["profile"]) ?? WHIP_PROFILES.find(entry => entry.value === WHIP_DEFAULT_PROFILE)!;
      const keyFrameSeconds = Math.max(0, num(values["keyInterval"], 0));
      const endpoint = whipEndpoint(String(values["server"] ?? ""), String(values["path"] ?? ""));
      const wired = Object.values(graph.edges).some(edge => edge.target.nodeId === node.id && edge.target.portId === "input");
      const refusal = "refusal" in endpoint ? endpoint.refusal
        : width % 2 !== 0 || height % 2 !== 0 ? "Width and Height must both be even: H.264 cannot carry an odd size."
        : !wired ? "Connect an image to Input."
        : null;
      return { id: node.id, definition, enabled, width, height, frameRate, kbps, audio, refusal, profile: profile.id, keyFrameSeconds,
        url: "url" in endpoint ? endpoint.url : "", key: JSON.stringify([endpoint, width, height, frameRate, kbps, audio, profile.id, keyFrameSeconds]) };
    }), [graph, runtime.registry, runtime.bus]);
  const latest = useRef(requests); latest.current = requests;
  const compiledRef = useRef(compiled); compiledRef.current = compiled;
  const depsRef = useRef(publisherDeps); depsRef.current = publisherDeps;
  const sinksRef = useRef(sinks); sinksRef.current = sinks;

  const tokens = useRef(new Map<string, string>());
  const views = useRef(new Map<string, WhipSectionView>());
  const listeners = useRef(new Set<() => void>());
  /** Runs the pump now; set by the effect below, a no-op without a backend. */
  const service = useRef<() => void>(() => {});

  // A token belongs to the document it was typed for: a new document starts with none.
  useEffect(() => {
    const held = tokens.current;
    return () => held.clear();
  }, [runtime.documentIdentity]);

  useEffect(() => {
    if (!backend || typeof document === "undefined") return;
    const entries = new Map<string, Entry>();
    let disposed = false;
    let gone = false;
    let frame = 0;
    let sinkKey = "";
    let shown = "";
    const frames = backend.frames ?? window;
    /** The nodes that should be publishing as of the last tick, and their Publish read. */
    let wanted = new Set<string>();
    const lastEnabled = new Map<string, boolean>();

    const close = (id: string): void => {
      const entry = entries.get(id);
      if (entry === undefined) return;
      entries.delete(id);
      entry.publisher.stop();
      entry.presentation.dispose();
      for (const track of entry.tracks) track.stop();
    };
    const closeAll = (): void => {
      for (const id of [...entries.keys()]) close(id);
    };

    const open = (request: (typeof requests)[number], key: string, outputId: string, token: string | undefined): Entry => {
      const canvas = document.createElement("canvas");
      canvas.width = request.width;
      canvas.height = request.height;
      const presentation = backend.present(canvas, { outputId, label: `whip:${request.id}`, sizing: "source" });
      // Rate 0: a frame is captured only when `pace` asks for one.
      const video = canvas.captureStream(0).getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
      const tracks: MediaStreamTrack[] = [video];
      // A clone of the program track: stopping it must not end the shared tap.
      if (request.audio) for (const track of appProgramStream()?.getAudioTracks() ?? []) tracks.push(track.clone());
      const publisher = createWhipPublisher(
        { url: request.url, stream: new MediaStream(tracks), kbps: request.kbps, profile: request.profile,
          keyFrameSeconds: request.keyFrameSeconds, token, onChange: () => publish() },
        depsRef.current,
      );
      return { key, canvas, presentation, tracks, publisher, outputId, video, interval: 1000 / request.frameRate, due: 0 };
    };

    /** What each node's section and diagnostic say, from the sessions as they stand. */
    const publish = (): void => {
      if (disposed) return;
      const policy = renderRangeHolderFor(runtime.bus).current?.busy() === true ? "blocked" : "live-session";
      const frozen = document.visibilityState === "hidden" && backend.frames?.foreign !== true;
      const next = new Map<string, WhipSectionView>();
      const problems: RuntimeDiagnostic[] = [];
      for (const request of latest.current) {
        const hasToken = tokens.current.has(request.id);
        const tokenInClear = hasToken && request.url !== "" && sendsTokenInClear(request.url);
        const entry = entries.get(request.id);
        const paused = emissionRefusal(request.definition, policy);
        let view: WhipSectionView;
        if (paused !== null) view = { state: "paused", message: paused, measured: null, hasToken, tokenInClear };
        else if (!wanted.has(request.id) && request.refusal !== null && lastEnabled.get(request.id) === true) {
          view = { state: "refused", message: request.refusal, measured: null, hasToken, tokenInClear };
        } else if (!wanted.has(request.id)) view = { ...OFF, hasToken, tokenInClear };
        else if (entry === undefined) view = { state: "waiting", message: "Waiting for the first frame.", measured: null, hasToken, tokenInClear };
        else if (entry.publisher.state === "retrying") {
          view = { state: "retrying", message: `${entry.publisher.error} Trying again every 2 s.`, measured: null, hasToken, tokenInClear };
        } else if (entry.publisher.state === "live") {
          const sent = entry.publisher.measured;
          view = {
            state: frozen ? "frozen" : "live",
            message: frozen
              ? "Frozen: this tab is hidden and nothing is rendering, so viewers hold the last picture. Keep Loom in a window of its own, or show a perform window."
              : `Live at ${request.url}`,
            measured: sent === null ? null
              : `${String(sent.width)}×${String(sent.height)}, ${String(Math.round(sent.fps))} fps, ${String(sent.kbps)} kbit/s sent, H.264 ${
                  WHIP_PROFILES.find(entry => sent.profile.startsWith(entry.id))?.label ?? sent.profile}`,
            hasToken, tokenInClear,
          };
        } else view = { state: "connecting", message: `Connecting to ${request.url}`, measured: null, hasToken, tokenInClear };
        next.set(request.id, view);
        if (view.state === "refused" || view.state === "retrying" || view.state === "paused" || view.state === "frozen") {
          problems.push({ nodeId: request.id, severity: "warning", code: "whip.output", message: view.message });
        }
      }
      const text = JSON.stringify([...next]);
      if (text === shown) return;
      shown = text;
      views.current = next;
      setDiagnostics(problems);
      for (const listener of listeners.current) listener();
    };

    const tick = (): void => {
      if (disposed || gone) return;
      const all = latest.current;
      if (all.length === 0 && entries.size === 0 && sinkKey === "" && shown === "[]") return;
      const policy = renderRangeHolderFor(runtime.bus).current?.busy() === true ? "blocked" : "live-session";
      const next = new Set<string>();
      lastEnabled.clear();
      for (const request of all) {
        const enabled = request.enabled();
        lastEnabled.set(request.id, enabled);
        if (enabled && request.refusal === null && emissionRefusal(request.definition, policy) === null) next.add(request.id);
      }
      wanted = next;
      const ids = [...next].sort();
      if (ids.join("\u0000") !== sinkKey) {
        sinkKey = ids.join("\u0000");
        sinksRef.current.set(ids);
      }
      for (const id of [...entries.keys()]) if (!next.has(id)) close(id);
      for (const request of all) {
        if (!next.has(request.id)) continue;
        const outputId = compiledRef.current?.outputs.find(output => output.nodeId === request.id && output.portId === SINK_TARGET_PORT)?.resourceId;
        const token = tokens.current.get(request.id);
        // The token is part of what a session IS, compared here and written nowhere.
        const key = `${request.key}\u0000${token ?? ""}`;
        const entry = entries.get(request.id);
        if (entry !== undefined && (entry.key !== key || outputId === undefined)) close(request.id);
        if (outputId === undefined) continue;
        const current = entries.get(request.id);
        if (current === undefined) entries.set(request.id, open(request, key, outputId, token));
        else if (current.outputId !== outputId) {
          current.outputId = outputId;
          current.presentation.setOutput(outputId);
        }
      }
      publish();
    };
    service.current = tick;

    /*
     * THE CAPTURE CADENCE. `captureStream(fps)` is a ceiling the browser enforces by
     * dropping frames that arrive early: on a 120 Hz loop it handed the encoder 28.4 to
     * 29.9 frames a second of 30, unevenly spaced (measured, §T1809b). So the track is
     * opened at rate 0 and asked for a frame here, on the loop's own frames: one whenever
     * a frame interval has passed, the remainder carried, so the average rate is the Frame
     * rate while the loop keeps up (every 4th frame of 120 for 30: measured 29.96 to 30.2).
     */
    const pace = (time: number): void => {
      for (const entry of entries.values()) {
        // A new frame source has a clock of its own: start again from its time.
        if (Math.abs(time - entry.due) > 1000) entry.due = time;
        // Half a millisecond early is on time: frame times are not exact multiples.
        if (time < entry.due - 0.5) continue;
        entry.video.requestFrame();
        entry.due = Math.max(entry.due + entry.interval, time - entry.interval);
      }
    };
    const onFrame = (time: number): void => {
      tick();
      pace(time);
      frame = frames.requestAnimationFrame(onFrame);
    };
    frame = frames.requestAnimationFrame(onFrame);
    const timer = window.setInterval(() => {
      tick();
      for (const entry of entries.values()) void entry.publisher.sample().catch(() => undefined);
    }, SERVICE_MS);
    // The page is going away (reload, close, navigation): end every session now, with
    // keepalive DELETEs. Back from the page cache, the next tick opens them again.
    const onPageHide = (): void => {
      gone = true;
      closeAll();
    };
    const onPageShow = (): void => {
      gone = false;
    };
    const onVisibility = (): void => publish();
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    document.addEventListener("visibilitychange", onVisibility);
    const sinkStore = sinksRef.current;
    const subscribers = listeners.current;
    return () => {
      disposed = true;
      service.current = () => {};
      frames.cancelAnimationFrame(frame);
      window.clearInterval(timer);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      document.removeEventListener("visibilitychange", onVisibility);
      closeAll();
      sinkStore.set([]);
      views.current = new Map();
      setDiagnostics([]);
      for (const listener of subscribers) listener();
    };
  }, [backend, runtime.bus, runtime.documentIdentity]);

  // A document edit (Server, Publish, a wire) is served now, not a frame or a second later.
  useEffect(() => service.current(), [requests, compiled]);

  const surface = useMemo<WhipSectionSurface>(() => ({
    view: (nodeId) => views.current.get(nodeId) ?? { ...OFF, hasToken: tokens.current.has(nodeId) },
    setToken(nodeId, token) {
      const value = token.trim();
      if (value === "") tokens.current.delete(nodeId);
      else tokens.current.set(nodeId, value);
      service.current();
      for (const listener of listeners.current) listener();
    },
    subscribe(listener) {
      listeners.current.add(listener);
      return () => listeners.current.delete(listener);
    },
  }), []);

  return { diagnostics, surface };
}
