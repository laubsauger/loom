/**
 * THE BRIDGE'S *MCP* MESSAGES, DEFINED ONCE (T451, §V39; narrowed by T1103).
 *
 * ## What the bridge is
 *
 * `serve.ts` is a complete headless Loom on stdio: its own store, its own GPU, its
 * own document. That is useful for tests and useless for the owner, because the graph an
 * agent builds there is one nobody can see. The bridge is the fix, and its shape is fixed
 * by a constraint: **the MCP client's config must not change.** The same process Claude
 * Desktop already spawns ALSO listens on loopback, the PAGE connects out on an explicit
 * click, and a `tools/call` arriving over stdio is then executed against the LIVE store
 * behind the visible canvas.
 *
 * Two halves speak this protocol — `bridge-host.ts` in the node process, `bridge-client.ts`
 * in the tab — and they are in different runtimes, so the one thing that must not drift is
 * the wire.
 *
 * ## What this file holds, and what T1103 moved out
 *
 * Only the MCP-shaped half: the `listTools`/`callTool` message union for the `page` and
 * `proxy` roles, the proxy token check, and the sentences a model reads when no tab is
 * attached. Nothing here is needed to speak to a laser.
 *
 * The SHARED half — address, port, `bridgeUrl`, the pairing code rules, the origin fence,
 * the frame parse, the attach timeout — is `@devices/transport/bridge-wire.ts`, because the
 * DEVICE role on this same socket needs exactly those and needs none of the below. It used
 * to live here, and `src/app/use-osc-bridge.ts` reaching into `src/mcp/` for it is what said
 * that plugging in a laser needs an agent protocol. The device-shaped message union is
 * `@devices/device-protocol.ts`. Neither of those imports this file.
 *
 * ## The security posture
 *
 * The rules and the reasoning are in `bridge-wire.ts`'s docblock, where the constants they
 * govern live — one copy, not two that drift. The one part specific to this file: T921
 * widened "one page at a time" along one axis and no other, by having a connection declare a
 * ROLE in its first message. The `page` role is unchanged in every respect, one at a time,
 * gated by the pairing code. The `proxy` role is a SIBLING SERVER that lost the race for the
 * port and forwards its stdio traffic here; several may connect, none of them occupies the
 * page slot, and the credential is a separate secret that exists only in a `0600` file
 * (`bridge-handoff.ts`). The rule the original bullet was protecting — an agent's edits
 * always land somewhere identifiable — is untouched, because every proxied call still
 * executes against the one attached page and still carries that page's name in its result.
 *
 * ## Nothing here interprets a message
 *
 * The types below describe bytes. `callTool` arguments stay `unknown` all the way to
 * `surface.callTool`, which validates them against the tool's zod schema and returns a
 * refusal as DATA (§V66). A message off this socket is never an instruction.
 */

import type { McpToolListing } from "./server.ts";

/**
 * One tool as the bridge announces it.
 *
 * The zod schema is NOT on the wire: both processes run the same catalogue, so each derives
 * the JSON Schema locally from `toolInputSchema` (§V39 — one derivation, not a serialised
 * copy that can disagree with the code that validates the call). What crosses is what the
 * host cannot know: which tools the PAGE finds available, and why not.
 */
export type BridgeToolListing = McpToolListing;

/** Host → page. Requests carry an `id`; the page answers with the matching reply. */
export type BridgeHostMessage =
  | { readonly type: "attached"; readonly serverInfo: string }
  /**
   * `devicesOnly` marks the ONE refusal that is not a rejection of the credential (T1111).
   *
   * A helper started with `--devices-only` has no agent door, so it refuses `attach` — but
   * it checks the pairing code FIRST and only sets this flag when the code MATCHED. The page
   * therefore learns two separate facts from one message: your code is right, and there are
   * no tools here. That distinction is load-bearing: `bridge-client.ts` REMEMBERS a code
   * refused this way (T925's rule is "never remember an unconfirmed code", and this one is
   * confirmed), which is what lets the device client pair with a helper that has no MCP
   * door open. Without it, the only pairing surface in the product would strand the very
   * mode it is pairing with.
   */
  | { readonly type: "refused"; readonly reason: string; readonly devicesOnly?: true }
  | { readonly type: "listTools"; readonly id: number }
  | { readonly type: "callTool"; readonly id: number; readonly tool: string; readonly arguments: unknown }
  | { readonly type: "ping"; readonly id: number };

/** Page → host. Role `page`, opened by `attach`. */
export type BridgePageMessage =
  | { readonly type: "attach"; readonly code: string; readonly client: string }
  | { readonly type: "listToolsResult"; readonly id: number; readonly tools: readonly BridgeToolListing[] }
  | { readonly type: "callToolResult"; readonly id: number; readonly result: unknown }
  | { readonly type: "callToolError"; readonly id: number; readonly message: string }
  | { readonly type: "toolsChanged" }
  | { readonly type: "pong"; readonly id: number };

/**
 * PROXY → INCUMBENT (T921). The other role this socket carries.
 *
 * A sibling `serve.ts` that lost the race for the port opens a connection, presents the
 * proxy token from the handoff file, and then asks the SAME two questions a bridge host
 * asks a page: what tools do you have, and please run this one. The message names are
 * deliberately the same as the host→page requests, because the shape is the same request in
 * the same direction of causation — what differs is who is answering, and that is settled
 * once, by the role declared in the first message.
 *
 * The proxy never sends `attach`, so it can never take the page slot; a page never knows
 * the token, so it can never take the proxy role. One socket type, two disjoint roles.
 */
export type BridgeProxyMessage =
  | { readonly type: "proxyAttach"; readonly token: string; readonly client: string }
  | { readonly type: "listTools"; readonly id: number }
  | { readonly type: "callTool"; readonly id: number; readonly tool: string; readonly arguments: unknown };

/**
 * INCUMBENT → PROXY.
 *
 * `proxyAttached` carries the three facts the loser cannot otherwise state truthfully: which
 * port is really bound, which PID owns it, and — the one that unblocked the owner — the
 * pairing code that ACTUALLY WORKS. Before T921 the loser printed its own freshly minted
 * code for a listener that never bound, which is exactly the "I entered it and nothing
 * happened" report. Handing the incumbent's code to the proxy means both of Claude
 * Desktop's processes name the same live bridge.
 */
export type BridgeProxyReply =
  | {
      readonly type: "proxyAttached";
      readonly serverInfo: string;
      readonly port: number;
      readonly pid: number;
      readonly pairingCode: string;
    }
  | { readonly type: "refused"; readonly reason: string }
  | { readonly type: "listToolsResult"; readonly id: number; readonly tools: readonly BridgeToolListing[] }
  | { readonly type: "callToolResult"; readonly id: number; readonly result: unknown }
  | { readonly type: "callToolError"; readonly id: number; readonly message: string }
  | { readonly type: "toolsChanged" };

/**
 * Constant-time-ish comparison for the proxy token. Same reasoning as `pairingCodeMatches`
 * in `@devices/transport/bridge-wire.ts`, and deliberately NOT that function — nor moved
 * beside it, because the proxy token is an MCP-only credential and the device role never
 * sees one. The token is neither normalised nor case-folded, because
 * nothing retypes it — folding it would only shrink the space for no human benefit.
 */
export function proxyTokenMatches(expected: string, given: unknown): boolean {
  if (typeof given !== "string" || expected.length === 0 || given.length !== expected.length) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < expected.length; index += 1) {
    diff |= expected.charCodeAt(index) ^ given.charCodeAt(index);
  }
  return diff === 0;
}

/**
 * A tool result shaped like the surface's own, for failures the BRIDGE itself must report.
 *
 * Never an exception and never a JSON-RPC error: "the tab went away", "another server owns
 * the port" and "that call timed out" are all things the calling model should read and act
 * on, so they travel as DATA in the same envelope a refusal does (§V66). One definition,
 * because the host and the proxy both need it and two copies would drift (§V39).
 */
export function bridgeFailureResult(
  tool: string,
  code: string,
  message: string,
): Record<string, unknown> {
  return {
    tool,
    status: "error",
    data: null,
    diagnostics: [{ severity: "error", code, message }],
    revision: null,
  };
}

/**
 * What a headless tool result and the panel both say. One sentence, one place (§V39).
 *
 * The middle clause is T921's third finding, and it is the owner's own confusion quoted back
 * as a fix: *"somehow the get node definition stuff still works. so i'm confused… is that
 * again headless then? this is so weird."* The catalogue tools answer PERFECTLY while
 * unattached, because node types are the same in both processes — so the surface looks
 * half-alive, and a half-alive surface reads as a working one. That is §V469's shape: a
 * partial success hiding a total failure. Naming the split is what stops a correct answer
 * from `get_node_definition` being read as evidence that the bridge is attached.
 */
export function headlessNote(pairingCode: string): string {
  return (
    "No Loom tab is attached to this bridge, so this ran against a HEADLESS in-memory " +
    "document the user cannot see. NOTE that catalogue tools (list_node_definitions, " +
    "get_node_definition) answer CORRECTLY either way, because node types are the same in " +
    "both processes — a working answer from one of those is NOT evidence that a tab is " +
    "attached, and every DOCUMENT tool here is reading or editing an empty copy. To drive " +
    "the tab the user is looking at: open Loom, go to the agent panel's Connections " +
    `section, and enter the pairing code ${pairingCode}. Call bridge_status for the current ` +
    "code and port rather than repeating one from earlier in this conversation."
  );
}
