import { useEffect, useMemo, useRef, useState } from "react";
import type { CompiledGraph } from "@compiler/index.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import { isSilencedSource } from "@domain/graph/bypass.ts";
import { resolveParameters } from "@domain/parameters/index.ts";
import { EMISSION_PUMPS } from "@domain/render/emission-pumps.ts";
import { emissionRefusal } from "@domain/render/side-effects.ts";
import { desktopOutputBridge } from "@devices/native-output.ts";
import { NATIVE_OUTPUT_TRANSPORTS, NATIVE_VIDEO_LABELS } from "@devices/native-video.ts";
import { createNativeOutputSession } from "@devices/native-output-session.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";
import type { AppRuntime } from "./app-runtime.ts";
import { renderRangeHolderFor } from "./render-range.ts";

const TYPES = new Set(Object.entries(EMISSION_PUMPS)
  .filter(([, path]) => path === "src/app/use-native-outputs.ts").map(([type]) => type));
type Session = ReturnType<typeof createNativeOutputSession>;
type Entry = { key: string; selectionKey?: string; session?: Session; polling: boolean };

export function useNativeOutputs(runtime: AppRuntime, backend: LoomBackend | null,
  graph: GraphDocument, compiled: CompiledGraph | null) {
  const [diagnostics, setDiagnostics] = useState<readonly RuntimeDiagnostic[]>([]);
  const requests = useMemo(() => {
    const demanded = new Set(compiled?.order);
    return Object.values(graph.nodes).filter(node => TYPES.has(node.type) && !isSilencedSource(node))
      .map(node => {
        const definition = runtime.registry.get(node.type)!;
        const values = resolveParameters(node, definition).values;
        const edge = Object.values(graph.edges).find(edge => edge.target.nodeId === node.id && edge.target.portId === "input");
        const source = compiled?.outputs.find(output => output.nodeId === edge?.source.nodeId && output.portId === edge.source.portId);
        const selection = source && demanded.has(node.id) ? { resourceId: source.resourceId, size: source.size } : null;
        const transport = NATIVE_OUTPUT_TRANSPORTS[node.type];
        if (!transport) throw new Error(`No native output transport for ${node.type}`);
        return { id: node.id, definition, transport, name: String(values["name"]), enabled: values["enabled"] === true,
          selection, selectionKey: JSON.stringify(selection), key: JSON.stringify([transport, values]) };
      });
  }, [graph, compiled, runtime.registry]);
  const latest = useRef(requests); latest.current = requests;
  const controller = useRef<{ suspend(): Promise<void> } | null>(null);
  // A replacement document/backend cannot reuse publisher names while the prior
  // effect still owns GPU work. Keep drainage outside that effect's lifetime.
  const pendingDrains = useRef(new Set<Promise<void>>());
  const drainFailure = useRef<string | null>(null);
  useEffect(() => {
    if (!backend) return;
    const entries = new Map<string, Entry>();
    const draining = pendingDrains.current;
    const messages = new Map<string, RuntimeDiagnostic>();
    let disposed = false;
    let frame = 0;
    const report = (id: string, message: string | null) => {
      if (disposed || (message === null ? !messages.has(id) : messages.get(id)?.message === message)) return;
      if (message === null) messages.delete(id);
      else messages.set(id, { nodeId: id, severity: "warning", code: "native.output", message });
      setDiagnostics([...messages.values()]);
    };
    const close = (id: string, entry: Entry) => {
      entries.delete(id);
      if (!entry.session) return;
      const pending = entry.session.close();
      draining.add(pending);
      // Rejection is shown, and remains in the drain set: a take cannot proceed
      // after unproven shutdown. No auto-retry or speculative slot reuse.
      void pending.then(() => draining.delete(pending), error => {
        drainFailure.current = `Native output shutdown failed: ${String(error)}`;
        report(id, drainFailure.current);
      });
    };
    const suspend = async () => {
      for (const [id, entry] of entries) close(id, entry);
      await Promise.all(draining);
    };
    const owned = { suspend }; controller.current = owned;
    setDiagnostics([]);
    const tick = () => {
      if (disposed) return;
      const wanted = latest.current;
      const policy = renderRangeHolderFor(runtime.bus).current?.busy() === true ? "blocked" : "live-session";
      for (const [id, entry] of entries) {
        const request = wanted.find(request => request.id === id);
        if (!request || request.key !== entry.key || policy === "blocked" || !request.enabled || !request.selection) close(id, entry);
      }
      for (const id of messages.keys()) if (!wanted.some(request => request.id === id)) report(id, null);
      for (const request of wanted) {
        const bridge = desktopOutputBridge(request.transport);
        const label = NATIVE_VIDEO_LABELS[request.transport];
        if (drainFailure.current) { report(request.id, drainFailure.current); continue; }
        const refusal = emissionRefusal(request.definition, policy);
        if (refusal) { report(request.id, refusal); continue; }
        if (!request.enabled) { report(request.id, null); continue; }
        if (!request.selection) { report(request.id, `Connect a compiled texture to ${label} Out`); continue; }
        // T1340b: the node's own requirement warning says this, once, in the one
        // vocabulary — see the note in `use-native-inputs.ts`. Nothing is published either
        // way, so the entry is simply not opened.
        if (!bridge) { report(request.id, null); continue; }
        if (draining.size) continue;
        let entry = entries.get(request.id);
        if (!entry) {
          entry = { key: request.key, selectionKey: request.selectionKey, polling: false };
          entries.set(request.id, entry);
          const current = entry;
          try {
            const session = createNativeOutputSession(backend, bridge, request.selection, request.name);
            current.session = session;
            void session.ready.then(() => { if (entries.get(request.id) === current) report(request.id, null); }, error => {
              if (entries.get(request.id) !== current) return;
              close(request.id, current);
              entries.set(request.id, { key: request.key, polling: false });
              report(request.id, String(error));
            });
          } catch (error) { report(request.id, String(error)); }
        }
        if (entry.session && entry.selectionKey !== request.selectionKey) {
          const current = entry;
          current.selectionKey = request.selectionKey;
          void entry.session.update(request.selection).catch(error => {
            if (entries.get(request.id) !== current) return;
            close(request.id, current);
            entries.set(request.id, { key: request.key, polling: false });
            report(request.id, String(error));
          });
        }
        try { entry.session?.pump(); }
        catch (error) {
          close(request.id, entry);
          entries.set(request.id, { key: request.key, polling: false });
          report(request.id, String(error));
        }
      }
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    const timer = window.setInterval(() => {
      for (const [id, entry] of entries) {
        if (!entry.session || entry.polling) continue;
        entry.polling = true;
        void entry.session.status().then(status => {
          if (status.error) throw new Error(status.error);
        }).catch(error => {
          if (entries.get(id) !== entry) return;
          close(id, entry); entries.set(id, { key: entry.key, polling: false }); report(id, String(error));
        }).finally(() => { entry.polling = false; });
      }
    }, 1000);
    return () => {
      disposed = true; window.cancelAnimationFrame(frame); window.clearInterval(timer);
      if (controller.current === owned) controller.current = null;
      for (const [id, entry] of entries) close(id, entry);
    };
  }, [backend, runtime.bus, runtime.documentIdentity]);
  return { diagnostics, suspend: () => controller.current?.suspend() ?? Promise.resolve() };
}
