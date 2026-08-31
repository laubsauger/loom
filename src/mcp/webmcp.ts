import type { AgentToolSurface } from "../agent/surface.ts";
import { TRANSPORT_LABEL, type McpTransportRegistry } from "./connections.ts";
import { publishedTools } from "./published-tools.ts";

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

/**
 * The host's model-context surface, if this browser has one.
 *
 * BOTH namespaces, `document` FIRST. The W3C group moved the API from
 * `navigator.modelContext` to `document.modelContext` — tools belong to a PAGE, not to
 * the whole browser — and Chrome/Edge removed the navigator spelling around v150. We
 * detected only `navigator`, so on a browser where the API is present and working we
 * reported "Unavailable" and published nothing. `navigator` is kept as the fallback
 * because Chrome 146-149 and the polyfills still answer there.
 */
export function detectModelContext(host: unknown = globalThis): ModelContextLike | null {
  const scope = host as {
    document?: { modelContext?: unknown };
    navigator?: { modelContext?: unknown };
  };
  const context = scope.document?.modelContext ?? scope.navigator?.modelContext;
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

/**
 * B93: the surface may arrive as a PROVIDER, and in the app it must.
 *
 * Measured live (the reproduction the B93 report handed us): the app publishes its
 * tools while the backend is still initialising, so a registration that CAPTURES the
 * surface captures one whose ports are `{}` — and every re-registration after the real
 * surface exists throws `InvalidStateError: Duplicate tool name` from the host's
 * `registerTool` (140 of them in one session's console). The result was an in-page
 * agent that could mutate the graph but never see what it drew: `render_preview`
 * refused with "needs a read source that is not attached: preview" forever.
 *
 * So the execute path reads the surface AT CALL TIME through the provider — the same
 * cure B76 applied to the bridge — and a duplicate registration is tolerated, because
 * the first registration's tools are already live against the current surface.
 */
/**
 * T525/T550: has this page already published via `registerTool`? A re-run (StrictMode's
 * probe, a surface re-mint) would reject one "Duplicate tool name" per tool — 28
 * unhandled rejections flooding the console on every load, harmless but
 * indistinguishable from a real failure at a glance. The guard is a `Symbol.for` marker
 * on the host's DOCUMENT, not a module-level WeakSet, because a long-lived HMR session
 * can run two copies of this module (§V442) and two WeakSets absorb nothing; the
 * symbol registry is global to the page, so both copies see one marker. Measured
 * before choosing: `document.modelContext` IS identity-stable here, so the weak set
 * was sound against StrictMode alone — the marker also survives the dual-module case.
 */
const REGISTERED_MARKER = Symbol.for("shaderloom.webmcp.registered");

function alreadyRegistered(host: unknown): boolean {
  const doc = (host as { document?: object }).document;
  if (doc === undefined) return false;
  return (doc as Record<symbol, unknown>)[REGISTERED_MARKER] === true;
}

function markRegistered(host: unknown): void {
  const doc = (host as { document?: object }).document;
  if (doc !== undefined) (doc as Record<symbol, unknown>)[REGISTERED_MARKER] = true;
}

export function registerWebMcp(
  surface: AgentToolSurface | (() => AgentToolSurface),
  options: RegisterWebMcpOptions = {},
): WebMcpRegistration {
  const { registry } = options;
  const current = typeof surface === "function" ? surface : () => surface;
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
        "No document.modelContext or navigator.modelContext here. Chrome 146+ and Edge 147+ have it behind chrome://flags/#enable-webmcp-testing.",
      toolNames: [],
      lastInvocation: null,
      connect: null,
      disconnect: null,
    });
    return { registered: false, toolCount: 0 };
  }

  const tools: WebMcpToolDescriptor[] = publishedTools(current()).map((tool) => {
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      execute: async (args) => {
        // Noted BEFORE the call, so a tool that hangs still shows as the last thing the
        // agent reached for — §V42's visibility is about what is happening, not only
        // about what finished.
        registry?.noteInvocation("webmcp", tool.name);
        // B93: the CURRENT surface, not the one registration captured — the ports the
        // backend mounted after publication are the whole point of asking again.
        const result = await current().callTool(tool.name, args ?? {});
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      },
    };
  });

  const provide = context.provideContext;
  if (typeof provide === "function") {
    provide({ tools });
  } else if (!alreadyRegistered(options.host ?? globalThis)) {
    markRegistered(options.host ?? globalThis);
    for (const tool of tools) {
      // T550, and the owner diagnosed it from the stack trace before either agent did:
      // `registerTool` returns a PROMISE, so its duplicate-name rejection sailed past
      // the old synchronous try/catch as "Uncaught (in promise)" — the catch that
      // "handled" it never ran. The filter below is the same reasoning, attached to a
      // catch that actually runs: a duplicate is harmless BECAUSE execute goes through
      // the provider (B93) — the standing registration already answers from the
      // current surface. Anything else stays loud: a swallowed schema rejection would
      // be a tool that silently never existed.
      try {
        void Promise.resolve(context.registerTool?.(tool)).catch((error: unknown) => {
          if (!String(error).toLowerCase().includes("duplicate")) throw error;
        });
      } catch (error) {
        if (!String(error).toLowerCase().includes("duplicate")) throw error;
      }
    }
  }

  registry?.publish({
    kind: "webmcp",
    label: TRANSPORT_LABEL.webmcp,
    state: "connected",
    detail:
      "In-page agents (a browser's built-in model, an extension) connect here automatically and edit this document. Desktop clients use the bridge below instead.",
    toolNames: tools.map((tool) => tool.name),
    lastInvocation: null,
    connect: null,
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
              connect: null,
              disconnect: null,
            });
          }
        : null,
  });
  return { registered: true, toolCount: tools.length };
}
