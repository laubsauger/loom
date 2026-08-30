import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { AgentToolSurface } from "@agent/index.ts";
import { toolInputSchema } from "@agent/surface.ts";
import type { McpToolDetail } from "@editor/agent/index.ts";
import { createMcpTransportRegistry } from "../mcp/connections.ts";
import type { McpTransportStatus } from "../mcp/connections.ts";
import { registerWebMcp } from "../mcp/webmcp.ts";
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

  // Publication is a side effect with a report, not a render value: it must happen once
  // per surface, and the row it writes is what the panel subscribes to.
  useEffect(() => {
    registerWebMcp(surface, { registry });
  }, [surface, registry]);

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
