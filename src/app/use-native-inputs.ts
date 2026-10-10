import { useEffect, useMemo, useRef, useState } from "react";
import type { FlatGraph } from "@domain/types/graph.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { InvocationContext } from "@domain/types/commands.ts";
import { isSilencedSource } from "@domain/graph/bypass.ts";
import { resolveStored } from "@domain/parameters/index.ts";
import { mediaSourceIdFor } from "@nodes/definitions/index.ts";
import { NATIVE_INPUT_TRANSPORTS, NATIVE_VIDEO_LABELS } from "@devices/native-video.ts";
import {
  createNativeInputSource, desktopInputBridge,
  type DesktopInputBridge, type NativeInputSourceInfo, type NativeInputTransport,
} from "@devices/native-input.ts";
import {
  duplicateSourceWarning, resolveNativeSource, waitingForSourceMessage, type StoredNativeSource,
} from "@devices/native-source-match.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";
import type { AppRuntime } from "./app-runtime.ts";
import type { ResolvedSizeSource } from "./use-media-sources.ts";

/**
 * VN113: how often discovery is re-read while a node is waiting for its server (unresolved,
 * not yet delivering frames, or an older document that has not learned its server's name).
 * The inspector's picker refreshes at the same rate. A node delivering frames costs nothing:
 * no discovery runs for it.
 */
export const NATIVE_DISCOVERY_INTERVAL_MS = 2000;

interface Request {
  nodeId: string; transport: NativeInputTransport;
  /** Stored identity: the UUID hint plus app + name (VN113). */
  uuid: string; app: string; name: string;
  /** The definition carries `sourceApp`/`sourceName`, so the hook may write them back. */
  nameable: boolean;
}
interface Entry {
  request: Request;
  /** The server this entry's session is open on, if any. */
  bound?: NativeInputSourceInfo;
  /** The session last said frames are flowing (it reported `null`). */
  healthy: boolean;
  /** An older document's name has been looked up and written back; never twice. */
  learned: boolean;
  sourceMessage: string | null;
  waiting: boolean;
  close(): void;
  releaseForNavigation?(): void;
}

const keyed = (request: Request) => request.app !== "" || request.name !== "";
const storedOf = (request: Request): StoredNativeSource => ({ id: request.uuid, app: request.app, name: request.name });

/** A session survives a change of request when it is still what the new request means:
 * same transport, bound to the stored UUID, and (for a named request) the same app + name.
 * This is what keeps the hook's own write-back from reopening the session it describes. */
function stillMeant(entry: Entry, request: Request): boolean {
  if (JSON.stringify(entry.request) === JSON.stringify(request)) return true;
  const bound = entry.bound;
  if (!bound || entry.request.transport !== request.transport || bound.id !== request.uuid) return false;
  return !keyed(request) || (bound.app === request.app && bound.name === request.name);
}

export function useNativeInputs(runtime: AppRuntime, backend: LoomBackend | null, graph: FlatGraph,
  resolved: (ResolvedSizeSource & { readonly order: readonly string[] }) | null) {
  const [diagnostics, setDiagnostics] = useState<readonly RuntimeDiagnostic[]>([]);
  const sizes = new Map(resolved?.outputs.map(output => [output.nodeId, output.size]));
  const latest = useRef({ sizes, documentIdentity: runtime.documentIdentity });
  latest.current = { sizes, documentIdentity: runtime.documentIdentity };
  const requests = useMemo(() => Object.values(graph.nodes)
    .filter(node => NATIVE_INPUT_TRANSPORTS[node.type] !== undefined && !isSilencedSource(node))
    .map((node): Request => {
      const definition = runtime.registry.get(node.type)!;
      // §T1557b: the document (`resolveStored`) — which device a node names is structural,
      // memoized per document revision; no frame exists here.
      const values = resolveStored(node, definition).values;
      const transport = NATIVE_INPUT_TRANSPORTS[node.type]!;
      // The resolved values carry every key the node's schema declares (read through the funnel).
      const nameable = "sourceName" in values && "sourceApp" in values;
      return { nodeId: node.id, transport, uuid: String(values["source"] ?? ""),
        app: nameable ? String(values["sourceApp"] ?? "") : "", name: nameable ? String(values["sourceName"] ?? "") : "", nameable };
    }), [graph, runtime.registry]);
  const demanded = new Set(resolved?.order);
  const requested = requests.filter(request => demanded.has(request.nodeId) && sizes.has(request.nodeId));
  const key = JSON.stringify(requested);
  const entries = useRef(new Map<string, Entry>());
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
      for (const entry of owned.values()) entry.close();
      owned.clear(); messages.clear();
    };
  }, [backend, runtime.documentIdentity]);
  useEffect(() => {
    if (!backend) return;
    const wanted: Request[] = JSON.parse(key);
    let active = true;
    const report = (reportKey: string, nodeId: string, message: string | null) => {
      if (message === null ? !reports.current.has(reportKey) : reports.current.get(reportKey)?.message === message) return;
      if (message === null) reports.current.delete(reportKey);
      // One code for both of a node's rows (its session, and an ambiguous name): the class
      // tables (`src/domain/diagnostics/classes.ts`) already place `native.input`.
      else reports.current.set(reportKey, { nodeId, code: "native.input", severity: "warning", message });
      setDiagnostics([...reports.current.values()]);
    };
    const matchKey = (nodeId: string) => `${nodeId}:match`;
    const show = (entry: Entry) => report(entry.request.nodeId, entry.request.nodeId,
      entry.waiting ? waitingForSourceMessage(storedOf(entry.request)) : entry.sourceMessage);
    const forget = (nodeId: string) => { report(nodeId, nodeId, null); report(matchKey(nodeId), nodeId, null); };

    /** VN113: a system-actor patch, so the document records what the node is bound to. */
    const writeBack = (nodeId: string, parameters: Record<string, string>) => {
      if (latest.current.documentIdentity !== runtime.documentIdentity) return;
      // A node inside a component has a flattened id with no root node to patch: the bus
      // refuses the patch and nothing is written. It still resolves by name at runtime; it
      // just does not persist what it learned.
      const system: InvocationContext = { actor: { kind: "system", id: "native-input", label: "Native input" },
        projectId: runtime.invocation.projectId, capabilities: [] };
      void runtime.bus.execute("graph.applyPatch", {
        baseRevision: runtime.bus.store.getRevision(), label: "Bind native source",
        operations: [{ op: "setParameters", nodeId, parameters }],
      }, system).catch(() => undefined);
    };

    const open = (entry: Entry, bridge: DesktopInputBridge, target: NativeInputSourceInfo) => {
      const { nodeId, transport } = entry.request;
      entry.close();
      let live = true;
      entry.bound = target; entry.healthy = false; entry.sourceMessage = null;
      const input = createNativeInputSource(bridge, target.id, {
        size: () => latest.current.documentIdentity === runtime.documentIdentity ? latest.current.sizes.get(nodeId) : undefined,
        resize: async (width, height) => {
          if (!live || latest.current.documentIdentity !== runtime.documentIdentity) return;
          const current = runtime;
          const result = await current.bus.execute("node.setResolution", {
            nodeId, resolution: { mode: "fixed", width, height },
          }, current.invocation);
          if (result.status !== "applied") throw new Error(result.diagnostics.map(d => d.message).join("; "));
        },
        report: message => {
          if (!live) return;
          entry.healthy = message === null; entry.sourceMessage = message;
          show(entry);
        },
        transport,
      });
      const unregister = backend.registerMediaSource(mediaSourceIdFor(nodeId), input.source);
      entry.close = () => { live = false; unregister(); input.dispose(); };
      entry.releaseForNavigation = () => { live = false; unregister(); input.releaseForNavigation(); };
    };

    /** Whether this entry still wants discovery read. */
    const needsDiscovery = (entry: Entry) => keyed(entry.request)
      ? !entry.bound || !entry.healthy || entry.waiting
      : entry.request.nameable && !entry.learned && entry.request.uuid !== "";

    const settle = (entry: Entry, bridge: DesktopInputBridge, discovered: readonly NativeInputSourceInfo[]) => {
      const { request } = entry;
      const match = resolveNativeSource(storedOf(request), discovered);
      if (match.kind === "unselected") return;
      if (match.kind === "unresolved") {
        // Keep whatever session exists (it holds the last image) and say what we wait for.
        if (keyed(request)) { entry.waiting = true; show(entry); }
        report(matchKey(request.nodeId), request.nodeId, null);
        return;
      }
      report(matchKey(request.nodeId), request.nodeId,
        match.candidates > 1 ? duplicateSourceWarning(match.source, match.candidates) : null);
      if (match.by === "id") {
        // An older document opened by UUID already; learn the name that UUID has now.
        entry.learned = true;
        entry.bound = match.source;
        writeBack(request.nodeId, { sourceApp: match.source.app, sourceName: match.source.name });
        return;
      }
      entry.waiting = false;
      if (entry.bound?.id !== match.source.id) {
        open(entry, bridge, match.source);
        // The document shows the id actually bound; the UUID stays a tie-breaker only.
        if (request.uuid !== match.source.id) writeBack(request.nodeId, { source: match.source.id });
      }
      show(entry);
    };

    const busy = new Set<NativeInputTransport>();
    const discover = async () => {
      const byTransport = new Map<NativeInputTransport, Entry[]>();
      for (const entry of entries.current.values())
        if (needsDiscovery(entry)) byTransport.set(entry.request.transport, [...byTransport.get(entry.request.transport) ?? [], entry]);
      await Promise.all([...byTransport].map(async ([transport, list]) => {
        const bridge = desktopInputBridge(transport);
        if (!bridge || typeof bridge.list !== "function" || busy.has(transport)) return;
        busy.add(transport);
        try {
          const discovered = await bridge.list();
          if (!active) return;
          // Settle only entries that are still the ones looked at.
          for (const entry of list) if (entries.current.get(entry.request.nodeId) === entry) settle(entry, bridge, discovered);
        } catch { /* Discovery failing is the picker's to report; the next tick tries again. */ }
        finally { busy.delete(transport); }
      }));
    };

    for (const [id, entry] of entries.current) {
      const request = wanted.find(candidate => candidate.nodeId === id);
      if (request && stillMeant(entry, request)) { entry.request = request; continue; }
      entry.close(); entries.current.delete(id); forget(id);
    }
    for (const request of wanted) {
      const { nodeId, transport, uuid } = request;
      const bridge = desktopInputBridge(transport);
      const label = NATIVE_VIDEO_LABELS[transport];
      if (entries.current.has(nodeId)) continue;
      const entry: Entry = { request, healthy: false, learned: false, sourceMessage: null, waiting: false, close() {} };
      entries.current.set(nodeId, entry);
      if (!bridge || (!uuid && !keyed(request))) {
        /* T1340b: NO BRIDGE is a HOST fact and the node already carries exactly one warning
           for it, from its own `requires` declaration (`use-requirement-diagnostics.ts`),
           in the words the library tags and the inspector section share. The three
           sentences that used to live here were a fourth wording of the same fact, written
           where nobody could see the other three — and they fired only for a node the
           render was already demanding, so the Syphon node you had just dropped said
           nothing at all. What stays is the part this hook alone knows: a bridge exists and
           no source has been picked. */
        report(nodeId, nodeId, bridge ? `Select a ${label} source in the inspector` : null);
        continue;
      }
      if (keyed(request)) {
        // VN113: a named source opens once discovery says which live server answers.
        entry.waiting = true; show(entry);
      } else {
        // No stored name (an older document, or NDI whose id IS its name): open by id now.
        open(entry, bridge, { id: uuid, app: "", name: "" });
      }
    }
    void discover();
    const timer = setInterval(() => void discover(), NATIVE_DISCOVERY_INTERVAL_MS);
    return () => { active = false; clearInterval(timer); };
  }, [backend, runtime, key]);
  return { diagnostics };
}
