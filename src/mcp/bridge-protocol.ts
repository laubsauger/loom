/**
 * THE BRIDGE WIRE, DEFINED ONCE (T451, §V39).
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
 * the wire. It lives here: the port, the message shapes, the pairing rules, and the vetting
 * both halves apply. Neither half declares a message type of its own.
 *
 * ## The security posture, and why each part is here rather than assumed
 *
 * These tools ADD, DELETE, REWIRE and UNDO in the user's open document, and with
 * `--grant-export` they read pixels — which, with a webcam node in the catalogue, can mean
 * a camera. So the listener is the most dangerous thing in this repo and every rule below
 * is load-bearing:
 *
 *  - **Loopback only.** `BRIDGE_HOST` is `127.0.0.1`, never `0.0.0.0`. T458 MEASURED the
 *    third-party relay binding `*:4797` and called it a local relay; we do not repeat it.
 *  - **The page initiates, by hand, every time.** Nothing dials on load and nothing is
 *    persisted, so a reload does not silently restore an attachment.
 *  - **A pairing code the page cannot guess.** Loopback is not an authorisation boundary:
 *    any page in any tab can open a WebSocket to `127.0.0.1`, and a same-origin policy does
 *    not apply to WebSockets. The code is minted by the HOST, reaches the user through the
 *    host's own channels (its stderr banner, its MCP `instructions`, and the note on every
 *    headless tool result), and is typed into the panel by the human. A page the user did
 *    not open never sees it. This is the whole gate; the origin check below is a second
 *    fence, not the first.
 *  - **The code is never in a URL or a query string.** T398's finding about the deprecated
 *    relay, whose session token rides the socket URL: URLs land in logs, in referrers and in
 *    process listings. It travels as the first MESSAGE on an opened socket instead.
 *  - **One attachment at a time.** A second page is refused BY NAME (§V288) rather than
 *    silently multiplexed — T458(b) is exactly that bug in the relay, where any connected
 *    channel could invoke another channel's tools.
 *
 * ## Nothing here interprets a message
 *
 * The types below describe bytes. `callTool` arguments stay `unknown` all the way to
 * `surface.callTool`, which validates them against the tool's zod schema and returns a
 * refusal as DATA (§V66). A message off this socket is never an instruction.
 */

import type { McpToolListing } from "./server.ts";

/**
 * The loopback address the bridge binds. Not configurable, and that is the point: an
 * option here is an option somebody sets to `0.0.0.0` to "make it work from my phone".
 */
export const BRIDGE_HOST = "127.0.0.1";

/**
 * The port both halves agree on without being told.
 *
 * The page has no way to be handed a port — the whole design is that the owner's MCP
 * client config does not change and there is no configuration surface between the two
 * processes — so the port is a constant read from one module by both. A host that cannot
 * bind it says so loudly and keeps serving headless rather than dying (§V288).
 */
export const BRIDGE_PORT = 43919;

/** Where the page dials. No credential in it — see the module docblock. */
export function bridgeUrl(port: number = BRIDGE_PORT): string {
  return `ws://${BRIDGE_HOST}:${port}`;
}

/**
 * Origins the host will accept a socket from.
 *
 * SECOND fence, not the first — the pairing code is the gate, and this is the cheap check
 * that stops the realistic attack earlier. The realistic attack is a page: any site the user
 * merely visits can open `ws://127.0.0.1:43919`, because a WebSocket handshake is not
 * subject to the same-origin policy and needs no preflight. What a page CANNOT do is lie
 * about `Origin` — the browser sets it and script cannot override it — so a loopback-only
 * rule reduces the pages that can even reach the pairing step to pages served from this
 * machine.
 *
 * An ABSENT `Origin` is accepted, and the reasoning matters because it looks like a hole:
 * browsers always send one, so absent means the peer is not a page. A local process opening
 * this socket already runs as the user, could read the pairing code out of the same log the
 * user does, and does not need a browser bug to do anything it wants — refusing it would buy
 * no security and would make the transport untestable outside a browser. The literal string
 * `"null"` is a different thing (a `file://` page, a sandboxed iframe: an origin that
 * identifies nothing) and IS refused.
 */
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

export function isPermittedOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  return LOOPBACK_ORIGIN.test(origin);
}

/**
 * The pairing alphabet: no `0`/`O`, no `1`/`I`/`L`, because this code is READ OFF one
 * surface and TYPED INTO another by a person, and a code that cannot be transcribed is a
 * code that gets pasted from somewhere less careful.
 */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_LENGTH = 6;

/**
 * A fresh pairing code, from the platform CSPRNG in either runtime.
 *
 * 31^6 ≈ 8.9e8. That is not a password, and it does not need to be: the host accepts ONE
 * socket at a time, refuses on the first wrong code and closes, so there is no online
 * guessing loop to run. It is minted per PROCESS, so it dies with the server.
 */
export function mintPairingCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  globalThis.crypto.getRandomValues(bytes);
  let code = "";
  for (const byte of bytes) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return code;
}

/** Case- and dash-insensitive, because the user retypes this. `ab-c d` ≡ `ABCD`. */
export function normalisePairingCode(entered: string): string {
  return entered.trim().toUpperCase().replace(/[\s-]/g, "");
}

/**
 * Constant-time-ish comparison. The code is short-lived, single-attempt and loopback-only,
 * so a timing oracle is not a realistic attack here — this costs one line and removes the
 * question.
 */
export function pairingCodeMatches(expected: string, entered: string): boolean {
  const given = normalisePairingCode(entered);
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let index = 0; index < expected.length; index += 1) {
    diff |= expected.charCodeAt(index) ^ given.charCodeAt(index);
  }
  return diff === 0;
}

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
  | { readonly type: "refused"; readonly reason: string }
  | { readonly type: "listTools"; readonly id: number }
  | { readonly type: "callTool"; readonly id: number; readonly tool: string; readonly arguments: unknown }
  | { readonly type: "ping"; readonly id: number };

/** Page → host. */
export type BridgePageMessage =
  | { readonly type: "attach"; readonly code: string; readonly client: string }
  | { readonly type: "listToolsResult"; readonly id: number; readonly tools: readonly BridgeToolListing[] }
  | { readonly type: "callToolResult"; readonly id: number; readonly result: unknown }
  | { readonly type: "callToolError"; readonly id: number; readonly message: string }
  | { readonly type: "toolsChanged" }
  | { readonly type: "pong"; readonly id: number };

/**
 * Parses one frame's text into an object, or null.
 *
 * Deliberately returns the loosest possible shape: callers switch on `type` and read the
 * fields that type promises, checking each. Nothing downstream may assume a field is present
 * because the union above says it should be — the sender is on the other side of a socket.
 */
export function parseBridgeMessage(data: unknown): Record<string, unknown> | null {
  if (typeof data !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(data);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * How long a freshly opened socket may stay silent before it is closed.
 *
 * An unattached socket costs the host a slot, and the host holds exactly one, so a page that
 * opens and never pairs would lock the bridge out. Five seconds is longer than a human takes
 * to click Connect (the code is already typed at that point) and short enough that a stuck
 * tab does not hold the bridge hostage.
 */
export const BRIDGE_ATTACH_TIMEOUT_MS = 5_000;

/** What a headless tool result and the panel both say. One sentence, one place (§V39). */
export function headlessNote(pairingCode: string): string {
  return (
    "No Loom tab is attached to this bridge, so this ran against a HEADLESS in-memory " +
    "document the user cannot see. To drive the tab they are looking at: open Loom, " +
    `go to the agent panel's Connections section, and enter the pairing code ${pairingCode}.`
  );
}
