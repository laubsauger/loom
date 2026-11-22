import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CompiledGraph } from "@compiler/index.ts";
import { isSilencedSource } from "@domain/graph/bypass.ts";
import { depthRecipeFromParameters, depthRecipeKey } from "@domain/media/photo-depth-recipe.ts";
import { storedStaticValue } from "@domain/parameters/slots.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { FlatGraph, GraphDocument } from "@domain/types/graph.ts";
import type { StoredParameter } from "@domain/types/parameters.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";
import { decodeNumericalMap } from "@runtime/media/depth-image.ts";
import { depthRecipeOf, preparedMetadata, rasterizeFloatMap } from "@runtime/media/prepared-map.ts";
import { floatMapSourceIdFor } from "@nodes/definitions/float-map-in.ts";

interface Request {
  readonly nodeId: string;
  readonly file: string;
  readonly photo: string;
  readonly interpretation: string;
  readonly inputSide: number | null;
  readonly emptySource: string;
  readonly recipeParameters?: Readonly<Record<string, StoredParameter>>;
  readonly width: number;
  readonly height: number;
}

interface LoadingSource {
  readonly signature: string;
  readonly abort: AbortController;
  release?: () => void;
  diagnostic?: RuntimeDiagnostic;
  pending?: Promise<void>;
}

class MapLoadError extends Error {
  readonly code: string;
  constructor(diagnostic: Pick<RuntimeDiagnostic, "code" | "message">) { super(diagnostic.message); this.code = diagnostic.code; }
}

async function fetchBytes(url: string, signal: AbortSignal): Promise<ArrayBuffer> {
  try {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new MapLoadError({ code: "floatMap.unavailable", message: `Could not read ${url}: HTTP ${response.status}.` });
    return await response.arrayBuffer();
  } catch (error) {
    if (error instanceof MapLoadError) throw error;
    throw new MapLoadError({ code: "floatMap.unavailable", message: `Could not read ${url}: ${error instanceof Error ? error.message : String(error)}.` });
  }
}

/** A wired photo is authoritative; the explicit reference applies to standalone maps. */
export function floatMapPhotoUrlFor(graph: GraphDocument, nodeId: string): string {
  const edge = Object.values(graph.edges).find(candidate => candidate.target.nodeId === nodeId && candidate.target.portId === "picture");
  const node = edge === undefined ? graph.nodes[nodeId] : graph.nodes[edge.source.nodeId];
  const value = node === undefined || (edge !== undefined && node.type !== "movieFileIn")
    ? undefined : storedStaticValue(node.parameters[edge === undefined ? "photo" : "file"]);
  return typeof value === "string" ? value : "";
}

function requestsFor(graph: FlatGraph, compiled: CompiledGraph | null): readonly Request[] {
  if (compiled === null) return [];
  const outputs = new Map(compiled.outputs.filter(output => output.portId === "out").map(output => [output.nodeId, output]));
  const requests: Request[] = [];
  for (const nodeId of Object.keys(graph.nodes).sort()) {
    const node = graph.nodes[nodeId]!;
    const output = outputs.get(nodeId);
    if (node.type !== "floatMapIn" || isSilencedSource(node) || output === undefined) continue;
    const file = storedStaticValue(node.parameters["file"]);
    const interpretation = storedStaticValue(node.parameters["interpretation"]);
    // An old Float Map In may carry only inputSide. Its existing depth validation
    // remains independent of the selectors introduced with persisted recipes.
    const recipeKeys = ["depthModel", "depthBackend", "depthSeed", "depthBundle", "depthFieldOfView", "refinementTarget", "refineRadius", "refineSpatialSigma", "refineColorSigma"] as const;
    const hasRecipe = recipeKeys.some(key => node.parameters[key] !== undefined);
    requests.push({
      nodeId,
      file: typeof file === "string" ? file : "",
      photo: floatMapPhotoUrlFor(graph, nodeId),
      emptySource: String(storedStaticValue(node.parameters["emptySource"]) ?? "error"),
      interpretation: interpretation === undefined ? "raw" : String(interpretation),
      inputSide: node.parameters["inputSide"] === undefined ? null : Number(storedStaticValue(node.parameters["inputSide"])),
      ...(hasRecipe ? { recipeParameters: Object.fromEntries([...recipeKeys, "inputSide"].flatMap(key =>
        node.parameters[key] === undefined ? [] : [[key, node.parameters[key]!]])) } : {}),
      width: output.size[0], height: output.size[1],
    });
  }
  return requests;
}

/** Loads the resolved IO graph, preserving unchanged sources across unrelated graph edits. */
export function useFloatMapSources(
  backend: LoomBackend | null | undefined, graph: FlatGraph, compiled: CompiledGraph | null,
): { readonly diagnostics: readonly RuntimeDiagnostic[]; readonly settle: () => Promise<void> } {
  const signature = useMemo(() => JSON.stringify(requestsFor(graph, compiled)), [graph, compiled]);
  const requests = useMemo(() => JSON.parse(signature) as Request[], [signature]);
  const sources = useRef(new Map<string, LoadingSource>());
  const [diagnostics, setDiagnostics] = useState<readonly RuntimeDiagnostic[]>([]);
  const publish = useCallback(() => {
    setDiagnostics([...sources.current.values()].flatMap(source => source.diagnostic ? [source.diagnostic] : []));
  }, []);

  // Backend replacement and unmount end every owned source and every pending fetch.
  useEffect(() => {
    const owned = sources.current;
    return () => {
      for (const source of owned.values()) {
        source.abort.abort();
        source.release?.();
      }
      owned.clear();
    };
  }, [backend]);

  useEffect(() => {
    const wanted = new Map(requests.map(request => [request.nodeId, JSON.stringify(request)]));
    for (const [nodeId, source] of sources.current) {
      if (backend && wanted.get(nodeId) === source.signature) continue;
      source.abort.abort();
      source.release?.();
      sources.current.delete(nodeId);
    }
    if (!backend) { publish(); return; }
    for (const request of requests) {
      if (sources.current.has(request.nodeId)) continue;
      const source: LoadingSource = { signature: wanted.get(request.nodeId)!, abort: new AbortController() };
      sources.current.set(request.nodeId, source);
      const diagnostic = (severity: RuntimeDiagnostic["severity"], code: string, message: string): RuntimeDiagnostic => ({ severity, code, message, nodeId: request.nodeId });
      if (request.file === "") {
        if (request.emptySource === "constant") continue;
        source.diagnostic = diagnostic("warning", "floatMap.missing", "Choose a saved float map or run photo preparation.");
        continue;
      }
      if (!["raw", "depth", "mask"].includes(request.interpretation)) {
        source.diagnostic = diagnostic("error", "floatMap.interpretation", `Unknown float map interpretation: ${request.interpretation}.`);
        continue;
      }
      if (request.interpretation !== "raw" && request.photo === "") {
        source.diagnostic = diagnostic("error", "floatMap.sourceMissing", "Choose the reference photo to verify this prepared map.");
        continue;
      }
      source.diagnostic = diagnostic("info", "floatMap.loading", "Loading and verifying the saved float map.");
      const current = (): boolean => !source.abort.signal.aborted && sources.current.get(request.nodeId) === source;
      source.pending = (async () => {
        try {
          const bytes = await fetchBytes(request.file, source.abort.signal);
          if (!current()) return;
          const map = await decodeNumericalMap(bytes);
          if (request.interpretation !== "raw") {
            const metadata = preparedMetadata(map);
            if (metadata.kind !== request.interpretation) throw new MapLoadError({ code: "floatMap.interpretation", message: `Saved ${metadata.kind} map cannot be interpreted as ${request.interpretation}.` });
            if (metadata.kind === "depth" && request.inputSide !== null && metadata.inputSide !== request.inputSide) {
              throw new MapLoadError({ code: "floatMap.settingsMismatch", message: "Depth detail differs from the saved preparation. Run depth again." });
            }
            if (metadata.kind === "depth") {
              if (request.recipeParameters !== undefined) {
                let selected: ReturnType<typeof depthRecipeFromParameters>;
                try { selected = depthRecipeFromParameters(request.recipeParameters); }
                catch (error) {
                  throw new MapLoadError({ code: "floatMap.settingsMismatch", message: `Depth preparation settings are invalid: ${error instanceof Error ? error.message : String(error)}.` });
                }
                if (depthRecipeKey(selected) !== depthRecipeKey(depthRecipeOf(map))) {
                  throw new MapLoadError({ code: "floatMap.settingsMismatch", message: "Depth preparation settings differ from the saved map. Run depth again or restore its settings." });
                }
              }
            }
            const photoBytes = await fetchBytes(request.photo, source.abort.signal);
            if (!current()) return;
            const digest = await crypto.subtle.digest("SHA-256", photoBytes);
            if (!current()) return;
            const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
            if (hash !== metadata.source.sha256) throw new MapLoadError({ code: "floatMap.sourceMismatch", message: "The reference photo differs from this map's preparation source. Run preparation again." });
          }
          const values = rasterizeFloatMap(map, request.interpretation as "raw" | "depth" | "mask", request.width, request.height);
          if (!current()) return;
          const frame = { frameId: 1, bytes: new Uint8Array(values.buffer, values.byteOffset, values.byteLength) };
          source.release = backend.registerMediaSource(floatMapSourceIdFor(request.nodeId), { currentFrame: () => frame, ended: true });
          delete source.diagnostic;
          publish();
        } catch (error) {
          if (!current()) return;
          source.diagnostic = diagnostic("error", error instanceof MapLoadError ? error.code : "floatMap.corrupt", error instanceof Error ? error.message : String(error));
          publish();
        }
      })();
    }
    publish();
  }, [backend, requests, publish]);

  const settle = useCallback(async () => {
    const tracked = [...sources.current.values()];
    await Promise.all(tracked.map(source => source.pending));
    for (const source of sources.current.values()) {
      if (source.diagnostic !== undefined) throw new Error(source.diagnostic.message);
    }
  }, []);
  return { diagnostics, settle };
}
