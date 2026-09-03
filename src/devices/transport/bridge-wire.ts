/**
 * THE LOCAL-HELPER WIRE, DEFINED ONCE (T451, §V39; extracted here by T1103).
 *
 * ## What this is, and why it is not in `src/mcp/`
 *
 * Loom ships ONE local helper process. It listens on loopback and a browser tab dials it,
 * because there are things a page cannot do: open a UDP socket, open TCP to a laser DAC,
 * spawn an Apple Vision worker — and, separately, answer a desktop agent's `tools/call`
 * against the document the user is actually looking at.
 *
 * Those are two consumers of ONE socket, and only the second is MCP. Everything in this
 * file — the address, the port, the pairing rules, the frame parse — is what both halves
 * need in order to be the same wire, so it lives beside the DEVICE code that has no other
 * reason to know about an agent protocol, and `src/mcp/` imports it. Before T1103 it lived
 * in `src/mcp/bridge-protocol.ts` and `src/app/use-osc-bridge.ts` imported it from there,
 * which said, falsely, that plugging in a laser needs an agent protocol.
 *
 * The MCP-shaped half of the old file — the `listTools`/`callTool` message union, the
 * headless annotation — stayed behind in `src/mcp/bridge-protocol.ts`, which is where it
 * belongs. The device-shaped half is in `../device-protocol.ts`. Neither imports the other.
 *
 * ## The security posture, and why each part is here rather than assumed
 *
 * Over this socket an agent can ADD, DELETE, REWIRE and UNDO in the user's open document,
 * and with `--grant-export` read pixels — which, with a webcam node in the catalogue, can
 * mean a camera. A device client can open UDP and drive a laser. So the listener is the most
 * dangerous thing in this repo and every rule below is load-bearing:
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
 *  - **One connection per ROLE.** A second page is refused BY NAME (§V288) rather than
 *    silently multiplexed — T458(b) is exactly that bug in the relay, where any connected
 *    channel could invoke another channel's tools. A connection declares a ROLE in its first
 *    message (`page`, `proxy`, `device`) and never reads another role's traffic.
 *
 * ## Nothing here interprets a message
 *
 * `parseBridgeMessage` returns the loosest possible shape and every caller checks the fields
 * it reads. A message off this socket is never an instruction.
 */

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
 * Parses one frame's text into an object, or null.
 *
 * Deliberately returns the loosest possible shape: callers switch on `type` and read the
 * fields that type promises, checking each. Nothing downstream may assume a field is present
 * because a union says it should be — the sender is on the other side of a socket.
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
 * An unattached socket costs the host a slot, and the host holds exactly one per role, so a
 * page that opens and never pairs would lock the bridge out. Five seconds is longer than a
 * human takes to click Connect (the code is already typed at that point) and short enough
 * that a stuck tab does not hold the bridge hostage.
 */
export const BRIDGE_ATTACH_TIMEOUT_MS = 5_000;
