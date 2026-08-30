import type { AgentToolSurface } from "../agent/surface.ts";
import { toolInputSchema } from "../agent/surface.ts";
import { TRANSPORT_LABEL, type McpTransportRegistry } from "./connections.ts";
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

export interface RegisterWebMcpOptions {
  /** Where to look for `navigator.modelContext`. Defaults to `globalThis`. */
  readonly host?: unknown;
  /**
   * T397/§V338: where the DETECTION RESULT goes so a human can read it. Optional only
   * because the headless server has no panel; the app always passes one, and a
   * composition test asserts the app's own row reflects this call.
   */
  readonly registry?: McpTransportRegistry;
}

export function registerWebMcp(
  surface: AgentToolSurface,
  options: RegisterWebMcpOptions = {},
): WebMcpRegistration {
  const { registry } = options;
  const context = detectModelContext(options.host ?? globalThis);
  if (context === null) {
    // §V338: the negative result is REPORTED, not merely returned. "This browser has no
    // WebMCP" and "our registration is broken" are different sentences, and before this
    // the app could say neither.
    registry?.publish({
      kind: "webmcp",
      label: TRANSPORT_LABEL.webmcp,
      state: "unavailable",
      detail:
        "This browser exposes no navigator.modelContext, so there is no in-page model to publish tools to.",
      toolNames: [],
      lastInvocation: null,
      disconnect: null,
    });
    return { registered: false, toolCount: 0 };
  }

  const tools: WebMcpToolDescriptor[] = surface.listTools().map((tool) => {
    const schema = toolInputSchema(tool.name);
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: schema === null ? { type: "object" } : zodToJsonSchema(schema),
      execute: async (args) => {
        // Noted BEFORE the call, so a tool that hangs still shows as the last thing the
        // agent reached for — §V42's visibility is about what is happening, not only
        // about what finished.
        registry?.noteInvocation("webmcp", tool.name);
        const result = await surface.callTool(tool.name, args ?? {});
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      },
    };
  });

  const provide = context.provideContext;
  if (typeof provide === "function") {
    provide({ tools });
  } else {
    for (const tool of tools) context.registerTool?.(tool);
  }

  registry?.publish({
    kind: "webmcp",
    label: TRANSPORT_LABEL.webmcp,
    state: "connected",
    detail: "An in-page model can call these tools, which edit this document.",
    toolNames: tools.map((tool) => tool.name),
    lastInvocation: null,
    // Revocable ONLY through `provideContext`, which replaces the published set: handing
    // it an empty list genuinely takes the tools away. The `registerTool` fallback has no
    // inverse in the proposal, and a Disconnect button that left the tools published
    // would be a lie about who can still write to the user's graph (§V288).
    disconnect:
      typeof provide === "function"
        ? () => {
            provide({ tools: [] });
            registry?.publish({
              kind: "webmcp",
              label: TRANSPORT_LABEL.webmcp,
              state: "disconnected",
              detail: "Tools withdrawn. Reload the page to publish them again.",
              toolNames: [],
              lastInvocation: null,
              disconnect: null,
            });
          }
        : null,
  });
  return { registered: true, toolCount: tools.length };
}
