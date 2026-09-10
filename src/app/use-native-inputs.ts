import { useEffect, useMemo, useRef, useState } from "react";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import { isSilencedSource } from "@domain/graph/bypass.ts";
import { resolveParameters } from "@domain/parameters/index.ts";
import { SYPHON_IN_TYPE, mediaSourceIdFor } from "@nodes/definitions/index.ts";
import { createNativeInputSource, desktopInputBridge } from "@devices/native-input.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";
import type { AppRuntime } from "./app-runtime.ts";
import type { ResolvedSizeSource } from "./use-media-sources.ts";

export function useNativeInputs(runtime: AppRuntime, backend: LoomBackend | null, graph: GraphDocument,
  resolved: (ResolvedSizeSource & { readonly order: readonly string[] }) | null) {
  const [diagnostics, setDiagnostics] = useState<readonly RuntimeDiagnostic[]>([]);
  const sizes = new Map(resolved?.outputs.map(output => [output.nodeId, output.size]));
  const latest = useRef({ sizes, documentIdentity: runtime.documentIdentity });
  latest.current = { sizes, documentIdentity: runtime.documentIdentity };
  const requests = useMemo(() => Object.values(graph.nodes)
    .filter(node => node.type === SYPHON_IN_TYPE && !isSilencedSource(node))
    .map(node => {
      const definition = runtime.registry.get(node.type)!;
      const values = resolveParameters(node, definition).values;
      return { nodeId: node.id, uuid: String(values["source"] ?? "") };
    }), [graph, runtime.registry]);
  const demanded = new Set(resolved?.order);
  const requested = requests.filter(request => demanded.has(request.nodeId) && sizes.has(request.nodeId));
  const key = JSON.stringify(requested);
  const entries = useRef(new Map<string, { uuid: string; dispose(): void }>());
  const reports = useRef(new Map<string, RuntimeDiagnostic>());
  useEffect(() => {
    const owned = entries.current;
    const messages = reports.current;
    setDiagnostics([]);
    return () => { for (const entry of owned.values()) entry.dispose(); owned.clear(); messages.clear(); };
  }, [backend, runtime.documentIdentity]);
  useEffect(() => {
    if (!backend) return;
    const wanted: typeof requested = JSON.parse(key);
    const report = (nodeId: string, message: string | null) => {
      if (message === null ? !reports.current.has(nodeId) : reports.current.get(nodeId)?.message === message) return;
      if (message === null) reports.current.delete(nodeId);
      else reports.current.set(nodeId, { nodeId, code: "native.input", severity: "warning", message });
      setDiagnostics([...reports.current.values()]);
    };
    for (const [id, entry] of entries.current) {
      if (!wanted.some(request => request.nodeId === id && request.uuid === entry.uuid)) {
        entry.dispose(); entries.current.delete(id); report(id, null);
      }
    }
    const bridge = desktopInputBridge();
    for (const { nodeId, uuid } of wanted) {
      if (entries.current.has(nodeId)) continue;
      if (!bridge || !uuid) {
        report(nodeId, bridge ? "Select a Syphon source in the inspector" : "Syphon In requires the macOS desktop app");
        entries.current.set(nodeId, { uuid, dispose() {} });
        continue;
      }
      let live = true;
      const input = createNativeInputSource(bridge, uuid, {
        size: () => latest.current.documentIdentity === runtime.documentIdentity ? latest.current.sizes.get(nodeId) : undefined,
        resize: async (width, height) => {
          if (!live || latest.current.documentIdentity !== runtime.documentIdentity) return;
          const current = runtime;
          const result = await current.bus.execute("node.setResolution", {
            nodeId, resolution: { mode: "fixed", width, height },
          }, current.invocation);
          if (result.status !== "applied") throw new Error(result.diagnostics.map(d => d.message).join("; "));
        },
        report: message => { if (live) report(nodeId, message); },
      });
      const unregister = backend.registerMediaSource(mediaSourceIdFor(nodeId), input.source);
      entries.current.set(nodeId, { uuid, dispose() { live = false; unregister(); input.dispose(); } });
    }
  }, [backend, runtime, key]);
  return { diagnostics };
}
