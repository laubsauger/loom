import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { AgentToolSurface } from "@agent/index.ts";
import { toolInputSchema } from "@agent/surface.ts";
import type { McpToolDetail } from "@editor/agent/index.ts";
import { createMcpTransportRegistry } from "../mcp/connections.ts";
import type { McpTransportStatus } from "../mcp/connections.ts";
import { registerWebMcp } from "../mcp/webmcp.ts";
import { createBridgeClient, type BridgeClient } from "../mcp/bridge-client.ts";
import { zodToJsonSchema } from "../mcp/json-schema.ts";

/**
 * Publishing the tool surface, and SAYING SO (T397, T290, §V338).
 *
 * ## Why this moved out of `use-agent-surface`
 *
 * `registerWebMcp(surface)` used to be an effect in the hook that builds the surface, and
 * its `{ registered, toolCount }` went straight in the bin. That is §V338 exactly: the
 * app performed a feature detection and then had no way to tell anyone what it found, so
 * "this browser has no WebMCP" and "our registration is broken" produced identical
 * silence. Registration and the report of it belong in one place, and this is it.
 *
 * The surface hook keeps doing the one thing it is for — constructing the surface and
 * attaching its state sources — and stays free of transports (§V192).
 *
 * ## Schema on demand
 *
 * `describeTool` derives the JSON Schema at drill-in time from the SAME pair the adapters
 * use, `toolInputSchema` + `zodToJsonSchema`, so what the panel shows is what an attached
 * client was handed. Deriving it for all twenty-eight tools up front would convert every
 * zod schema on every mount to fill a list nobody has opened.
 */

export interface McpTransportsView {
  readonly transports: readonly McpTransportStatus[];
  readonly describeTool: (name: string) => McpToolDetail | null;
}

export function useMcpTransports(surface: AgentToolSurface): McpTransportsView {
  const registry = useMemo(() => createMcpTransportRegistry(), []);

  /**
   * The surface is read through a REF, never a dependency.
   *
   * MEASURED against a real transport and a real tab (B76): the app mints a new surface
   * whenever the runtime identity changes, so an effect keyed on `surface` re-ran
   * mid-session, disconnected the attached agent and rebuilt an idle client — about every
   * thirty seconds, with no error anywhere, because an accidental teardown looks exactly
   * like a deliberate one. The transport asks for the CURRENT surface instead, so the
   * socket outlives any one surface object.
   */
  const surfaceRef = useRef(surface);
  surfaceRef.current = surface;

  // Publication is a side effect with a report, not a render value — registered ONCE per
  // registry, against the ref. B93 measured what keying this on `surface` did: the first
  // run captured a surface whose ports were still `{}` (the backend had not arrived), and
  // every re-run threw `InvalidStateError: Duplicate tool name` out of the host's
  // `registerTool`, so the in-page agent kept the portless tools forever — able to draw,
  // never to see. Same disease as B76, same cure: the transport outlives any one surface
  // object and asks for the current one at call time.
  useEffect(() => {
    registerWebMcp(() => surfaceRef.current, { registry });
  }, [registry]);

  /**
   * THE BRIDGE (T451) — the transport we ship, with no third party in it.
   *
   * Constructed on mount and dialling nothing: it publishes its idle row with the `connect`
   * the panel renders a field for, and no socket exists until a human types the pairing code
   * the MCP server printed. Attaching hands an outside model write access to the open
   * document, so it is an explicit act with a visible result, never a side effect of
   * opening a tab.
   *
   * Keyed on `registry` alone, for the reason recorded above the ref (B76).
   */
  const bridgeRef = useRef<BridgeClient | null>(null);
  useEffect(() => {
    const bridge = createBridgeClient({
      surface: () => surfaceRef.current,
      registry,
      client: globalThis.location?.host ?? "a Loom tab",
    });
    bridgeRef.current = bridge;
    return () => {
      bridgeRef.current = null;
      bridge.disconnect();
    };
  }, [registry]);

  // A new surface means ports may have mounted or gone, so the agent's `tools/list` is
  // stale. Telling the bridge turns that into a `tools/list_changed` on the MCP client —
  // the difference between a tool list that describes the tab and one that describes the
  // tab as it was when somebody attached (§V338's shape, applied to the roster).
  useEffect(() => {
    bridgeRef.current?.toolsChanged();
  }, [surface]);

  const subscribe = useCallback((listener: () => void) => registry.subscribe(listener), [registry]);
  const snapshot = useCallback(() => registry.snapshot(), [registry]);
  const transports = useSyncExternalStore(subscribe, snapshot, snapshot);

  const describeTool = useCallback(
    (name: string): McpToolDetail | null => {
      const info = surface.describeTool(name);
      if (info === null) return null;
      const schema = toolInputSchema(name);
      return {
        name: info.name,
        title: info.title,
        description: info.description,
        available: info.available,
        schema: JSON.stringify(schema === null ? { type: "object" } : zodToJsonSchema(schema), null, 2),
      };
    },
    [surface],
  );

  return useMemo(() => ({ transports, describeTool }), [transports, describeTool]);
}
