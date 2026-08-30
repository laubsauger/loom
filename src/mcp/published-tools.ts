import type { AgentToolSurface } from "../agent/surface.ts";
import { toolInputSchema } from "../agent/surface.ts";
import { zodToJsonSchema } from "./json-schema.ts";
import type { McpToolListing } from "./server.ts";

/**
 * WHAT A TRANSPORT PUBLISHES, IN ONE PLACE (T453, §V39).
 *
 * Two in-page transports hand the same tool surface to an outside model —
 * `navigator.modelContext` (`webmcp.ts`) and our own loopback bridge (`bridge-client.ts`) —
 * and a third describes it for the panel. Each of them needs {name, description, JSON
 * Schema} derived from the SAME pair, `toolInputSchema` + `zodToJsonSchema`.
 *
 * Deriving that twice is how two pipes end up publishing two different pictures of one
 * surface, which is the exact class of drift §V39 exists to prevent. This module is the
 * derivation; the transports attach their own `execute` and their own envelope.
 *
 * It is derivation, never declaration: nothing here decides what a tool is or does. A
 * schema the walker does not recognise degrades to accept-anything, and zod still
 * validates the real call at `surface.callTool`.
 */

export interface PublishedTool {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the tool's arguments, derived from its zod schema. */
  readonly inputSchema: Record<string, unknown>;
}

/**
 * The same surface as an MCP tool LISTING — name, title, description, availability.
 *
 * T451's bridge sends this from the page so the node process's `tools/list` describes the
 * tools that will ACTUALLY execute. The schema is deliberately absent: both processes run
 * the same catalogue and each derives JSON Schema from the same zod, so putting a copy on
 * the wire would create a second description that can disagree with the validator (§V39).
 *
 * `available` and `missing` are the half the other process genuinely cannot know — the tab
 * has GPU ports and a preview the headless twin may not, and vice versa.
 */
export function toolListings(surface: AgentToolSurface): readonly McpToolListing[] {
  return surface.listTools().map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    available: tool.available,
    missing: {
      commands: [...tool.missing.commands],
      queries: [...tool.missing.queries],
      ports: [...tool.missing.ports],
    },
  }));
}

export function publishedTools(surface: AgentToolSurface): readonly PublishedTool[] {
  return surface.listTools().map((tool) => {
    const schema = toolInputSchema(tool.name);
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: schema === null ? { type: "object" } : zodToJsonSchema(schema),
    };
  });
}
