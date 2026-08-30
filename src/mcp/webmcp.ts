import type { AgentToolSurface } from "../agent/surface.ts";
import { toolInputSchema } from "../agent/surface.ts";
import { zodToJsonSchema } from "./json-schema.ts";

/**
 * The WebMCP adapter (T290, §V39, §V192): the SAME agent surface, published to the
 * browser's model-context API so an in-tab agent (a browser-integrated model, an
 * extension) drives the live app the user is looking at — graphs growing on the
 * visible canvas in quasi-realtime, which is the owner's demo.
 *
 * The API is feature-detected structurally: WebMCP is an emerging proposal
 * (`navigator.modelContext`), so this file types the fragment it uses and registers
 * only when the host provides it. No capability, no effect — the app never depends on
 * it existing. Transport + schema only; `execute` is a straight `callTool`, and a tool
 * refusal travels as DATA in the result, never as a thrown error (§V66).
 */

interface WebMcpToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly execute: (args: unknown) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
}

interface ModelContextLike {
  readonly provideContext?: (context: { tools: WebMcpToolDescriptor[] }) => void;
  readonly registerTool?: (tool: WebMcpToolDescriptor) => void;
}

/** The host's model-context surface, if this browser has one. */
export function detectModelContext(host: unknown = globalThis): ModelContextLike | null {
  const navigatorLike = (host as { navigator?: { modelContext?: unknown } }).navigator;
  const context = navigatorLike?.modelContext;
  if (typeof context !== "object" || context === null) return null;
  const shaped = context as ModelContextLike;
  return typeof shaped.provideContext === "function" || typeof shaped.registerTool === "function"
    ? shaped
    : null;
}

export interface WebMcpRegistration {
  /** True when a model context existed and the tools were published. */
  readonly registered: boolean;
  readonly toolCount: number;
}

export function registerWebMcp(
  surface: AgentToolSurface,
  host: unknown = globalThis,
): WebMcpRegistration {
  const context = detectModelContext(host);
  if (context === null) return { registered: false, toolCount: 0 };

  const tools: WebMcpToolDescriptor[] = surface.listTools().map((tool) => {
    const schema = toolInputSchema(tool.name);
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: schema === null ? { type: "object" } : zodToJsonSchema(schema),
      execute: async (args) => {
        const result = await surface.callTool(tool.name, args ?? {});
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      },
    };
  });

  if (typeof context.provideContext === "function") {
    context.provideContext({ tools });
  } else {
    for (const tool of tools) context.registerTool?.(tool);
  }
  return { registered: true, toolCount: tools.length };
}
