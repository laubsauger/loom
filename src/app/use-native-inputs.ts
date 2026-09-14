import { useEffect, useMemo, useRef, useState } from "react";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import { isSilencedSource } from "@domain/graph/bypass.ts";
import { resolveParameters } from "@domain/parameters/index.ts";
import { mediaSourceIdFor } from "@nodes/definitions/index.ts";
import { NATIVE_INPUT_TRANSPORTS, NATIVE_VIDEO_LABELS } from "@devices/native-video.ts";
import { createNativeInputSource, desktopInputBridge, type NativeInputTransport } from "@devices/native-input.ts";
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
    .filter(node => NATIVE_INPUT_TRANSPORTS[node.type] !== undefined && !isSilencedSource(node))
    .map(node => {
      const definition = runtime.registry.get(node.type)!;
      const values = resolveParameters(node, definition).values;
      const transport = NATIVE_INPUT_TRANSPORTS[node.type]!;
      return { nodeId: node.id, uuid: String(values["source"] ?? ""), transport };
    }), [graph, runtime.registry]);
  const demanded = new Set(resolved?.order);
  const requested = requests.filter(request => demanded.has(request.nodeId) && sizes.has(request.nodeId));
  const key = JSON.stringify(requested);
  const entries = useRef(new Map<string, { uuid: string; transport: NativeInputTransport; dispose(): void; releaseForNavigation?(): void }>());
  const reports = useRef(new Map<string, RuntimeDiagnostic>());
  useEffect(() => {
    const owned = entries.current;
    const messages = reports.current;
    setDiagnostics([]);
    const leaving = () => { for (const entry of owned.values()) entry.releaseForNavigation?.(); };
    window.addEventListener("pagehide", leaving);
    window.addEventListener("loom-native-input-retire", leaving);
    return () => {
      window.removeEventListener("pagehide", leaving);
      window.removeEventListener("loom-native-input-retire", leaving);
      for (const entry of owned.values()) entry.dispose();
      owned.clear(); messages.clear();
    };
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
      if (!wanted.some(request => request.nodeId === id && request.uuid === entry.uuid && request.transport === entry.transport)) {
        entry.dispose(); entries.current.delete(id); report(id, null);
      }
    }
    for (const { nodeId, uuid, transport } of wanted) {
      const bridge = desktopInputBridge(transport);
      const label = NATIVE_VIDEO_LABELS[transport];
      if (entries.current.has(nodeId)) continue;
      if (!bridge || !uuid) {
        /* T1340b: NO BRIDGE is a HOST fact and the node already carries exactly one warning
           for it, from its own `requires` declaration (`use-requirement-diagnostics.ts`),
           in the words the library tags and the inspector section share. The three
           sentences that used to live here were a fourth wording of the same fact, written
           where nobody could see the other three — and they fired only for a node the
           render was already demanding, so the Syphon node you had just dropped said
           nothing at all. What stays is the part this hook alone knows: a bridge exists and
           no source has been picked. */
        report(nodeId, bridge ? `Select a ${label} source in the inspector` : null);
        entries.current.set(nodeId, { uuid, transport, dispose() {} });
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
      entries.current.set(nodeId, { uuid, transport,
        dispose() { live = false; unregister(); input.dispose(); },
        releaseForNavigation() { live = false; unregister(); input.releaseForNavigation(); },
      });
    }
  }, [backend, runtime, key]);
  return { diagnostics };
}
