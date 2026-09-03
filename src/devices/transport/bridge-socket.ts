/**
 * THE PAGE'S END OF THE LOCAL-HELPER SOCKET (T925/T942; extracted here by T1103).
 *
 * ## What this is
 *
 * The two things a browser tab needs before it can hold ANY role on the helper's loopback
 * socket: something that produces a `WebSocket` behind a seam a test can fake, and somewhere
 * to remember the pairing code across a reload. Both are role-agnostic — the agent client
 * (`@/mcp/bridge-client.ts`) and the device client (`../device-client.ts`) each open one of
 * these and speak their own messages over it.
 *
 * It lives beside the device code rather than inside `src/mcp/` for the reason T1103 named:
 * `src/app/use-osc-bridge.ts` imported `BridgeSocketFactory` out of the MCP folder to talk to
 * a laser. The socket is transport; the wire it speaks is `./bridge-wire.ts`; only the tool
 * traffic on top of it is MCP.
 *
 * ## The pairing code is shared, deliberately
 *
 * One process, one port, one code. A tab that paired for the agent role has already proved to
 * the helper that a human read the code off its banner, and `sessionPairingMemory` is how the
 * device role reuses that proof without a second field to type. That is why the memory is a
 * seam and not a private detail of either client.
 */

/**
 * WHERE THE PAIRING CODE IS REMEMBERED, AND FOR EXACTLY HOW LONG (T925).
 *
 * ## The pain, in the owner's words
 *
 * *"maybe we should try to reconnect to the last known mcp code on hot reload… its super
 * painful right now with any edit from an agent reloading the page and killing the link and
 * having me to repaste the code."* Note the shape of that: the agent's OWN edit triggers the
 * HMR reload that drops the attachment, so the tool stops working because of the work it
 * enables. Every such edit cost a hand-carried six-character secret between two windows.
 *
 * ## `sessionStorage`, and why not `localStorage`
 *
 * This code gates control of the user's open document. `sessionStorage` survives a reload
 * and dies with the tab — exactly the lifetime of the pain, and no longer. `localStorage`
 * would outlive the bridge PROCESS that minted the code and leave a stale control secret on
 * disk for days, buying nothing: the code is minted per process, so a value that outlives
 * the process is guaranteed worthless and merely dangerous.
 *
 * ## Why this key does not carry the legacy prefix (§V813)
 *
 * §V813 keeps the thirteen existing storage keys on the OLD prefix because MOVING a key
 * orphans data the user already has. A brand-new address has nothing to orphan, so it takes
 * the current name. Two prefixes is the honest state of a renamed product mid-flight; it is
 * a decision, not an oversight.
 */
const PAIRING_STORAGE_KEY = "loom.bridge.pairing.v1";

/** The three things this module does with a remembered code. Injectable for tests. */
export interface PairingMemory {
  read(): string | null;
  write(code: string): void;
  forget(): void;
}

/**
 * The real thing, and every call is wrapped.
 *
 * Reaching `sessionStorage` THROWS rather than returning null in a browser configured to
 * block site data, and `setItem` throws on quota. Remembering a code is a convenience; it
 * must never be able to stop a tab from attaching by hand.
 */
export function sessionPairingMemory(): PairingMemory {
  const store = (): Storage | null => {
    try {
      return globalThis.sessionStorage as Storage | undefined ?? null;
    } catch {
      return null;
    }
  };
  return {
    read() {
      try {
        return store()?.getItem(PAIRING_STORAGE_KEY) ?? null;
      } catch {
        return null;
      }
    },
    write(code) {
      try {
        store()?.setItem(PAIRING_STORAGE_KEY, code);
      } catch {
        // Nothing to say and nothing to do: the next reload asks the human, as before.
      }
    },
    forget() {
      try {
        store()?.removeItem(PAIRING_STORAGE_KEY);
      } catch {
        // Same.
      }
    },
  };
}

/**
 * The socket shape this module needs.
 *
 * Narrow on purpose: the browser adapter below is the only place a DOM `WebSocket` appears,
 * and a test can hand in a real client or a fake with equal ease. Note that a test which
 * fakes this proves the CALLBACKS, not the bytes (§V382) — `bridge-e2e.test.ts` runs both
 * halves over a real socket for the claim that matters.
 */
export interface BridgeSocket {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

export type BridgeSocketFactory = (url: string) => BridgeSocket;

/**
 * The real thing, adapted field by field so no cast is needed anywhere.
 *
 * Shared by both roles. `device-client.ts` once held a byte-identical copy while ALREADY
 * importing `BridgeSocket` from the agent client — the type crossed the seam and the one
 * adapter that produces it did not; T1103 put both in this file, which neither role owns.
 */
export function browserSocket(url: string): BridgeSocket {
  const socket = new WebSocket(url);
  const bridge: BridgeSocket = {
    send: (data) => {
      socket.send(data);
    },
    close: () => {
      socket.close();
    },
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  socket.onopen = () => bridge.onopen?.();
  socket.onmessage = (event: MessageEvent) => bridge.onmessage?.({ data: event.data });
  socket.onclose = () => bridge.onclose?.();
  socket.onerror = () => bridge.onerror?.();
  return bridge;
}
