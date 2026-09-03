import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";

/**
 * A WEBSOCKET SERVER, LOOPBACK, NO DEPENDENCY (T451).
 *
 * ## Why this exists at all
 *
 * The bridge needs the browser to connect OUT to the node process the MCP client already
 * spawns. WebSocket is the only transport a page can open to another port without a
 * preflight or a CORS grant, and Node has a WebSocket CLIENT but no server. The choices
 * were a dependency (`ws`) or the handshake and the frame codec, which is this file.
 *
 * The codec won on a narrow argument: adding a runtime dependency to the process an MCP
 * client spawns widens what runs on the user's machine on their behalf, for about a hundred
 * and thirty lines of RFC 6455 that this repo can read. There is no framework here and no
 * extension negotiation — the bridge speaks one subprotocol, text frames, both directions.
 *
 * ## What it deliberately does NOT implement
 *
 *  - `permessage-deflate`. Not negotiated, so never used; the browser falls back cleanly.
 *  - Binary frames. Refused rather than ignored — everything on this wire is JSON text, and
 *    a binary frame is a sender we do not understand.
 *  - Backpressure beyond node's own socket buffering. One page, one process, loopback.
 *
 * ## Loopback is enforced twice
 *
 * `listen()` is given `BRIDGE_HOST` by the caller, so the listener is not reachable off this
 * machine at all — that is the fence that matters, and it is the one T458 measured the
 * third-party relay getting wrong (`*:4797`). The remote-address check below is belt and
 * braces for a caller that passes a different host: this module refuses to serve a
 * non-loopback peer whatever it was told to bind.
 */

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/**
 * The largest single message accepted, in bytes.
 *
 * Generous because a `render_preview` result carries a base64 PNG of the user's output at
 * whatever resolution their project uses, and truncating that would look like a broken tool
 * rather than a limit. Anything past it is a sender that is not our page, and the socket is
 * closed rather than allowed to grow the process's heap.
 */
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

const OPCODE_CONTINUATION = 0x0;
const OPCODE_TEXT = 0x1;
const OPCODE_BINARY = 0x2;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xa;

/** One live page socket, reduced to what the bridge actually uses. */
export interface LoopbackConnection {
  /** The `Origin` header the browser sent, verbatim. Vetted by the caller, not here. */
  readonly origin: string | undefined;
  send(text: string): void;
  close(): void;
  /** Set by the caller immediately after `onConnection`. */
  onMessage: ((text: string) => void) | null;
  onClose: (() => void) | null;
}

export interface LoopbackWebSocketServer {
  /** The port actually bound, or null before `listening` / after a bind failure. */
  boundPort(): number | null;
  close(): void;
}

export interface LoopbackWebSocketServerOptions {
  /** Port to bind. `0` asks the OS for a free one, which is what tests use. */
  readonly port: number;
  /** Interface to bind. The bridge passes loopback; nothing else should. */
  readonly host: string;
  readonly onConnection: (connection: LoopbackConnection) => void;
  /** Bind failed — EADDRINUSE above all. The caller decides what to say (§V288). */
  readonly onListenError: (error: Error) => void;
  readonly onListening: (port: number) => void;
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false;
  const bare = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  return bare === "127.0.0.1" || bare === "::1" || bare.startsWith("127.");
}

export function createLoopbackWebSocketServer(
  options: LoopbackWebSocketServerOptions,
): LoopbackWebSocketServer {
  const server = createServer((_request, response) => {
    // A human who opens the port in a browser gets a sentence, not a hang. This is not a
    // web server and never serves the app.
    response.writeHead(426, { "content-type": "text/plain" });
    response.end("Loom bridge: WebSocket only.\n");
  });

  server.on("upgrade", (request: IncomingMessage, socket: Socket) => {
    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string" || !isLoopbackAddress(request.socket.remoteAddress)) {
      socket.destroy();
      return;
    }
    const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.setNoDelay(true);

    let closed = false;
    const connection: LoopbackConnection = {
      origin: typeof request.headers.origin === "string" ? request.headers.origin : undefined,
      send(text) {
        if (closed) return;
        socket.write(encodeFrame(OPCODE_TEXT, Buffer.from(text, "utf8")));
      },
      close() {
        if (closed) return;
        closed = true;
        socket.write(encodeFrame(OPCODE_CLOSE, Buffer.alloc(0)));
        socket.end();
      },
      onMessage: null,
      onClose: null,
    };

    /** Fires `onClose` exactly once, however the socket ended. */
    const finish = (): void => {
      closed = true;
      const handler = connection.onClose;
      connection.onClose = null;
      handler?.();
    };

    let buffer = Buffer.alloc(0);
    let fragments: Buffer[] = [];
    let fragmentedOpcode = 0;

    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (buffer.length < 2) return;
        const first = buffer[0] ?? 0;
        const second = buffer[1] ?? 0;
        const fin = (first & 0x80) !== 0;
        const opcode = first & 0x0f;
        const masked = (second & 0x80) !== 0;
        let length = second & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          const wide = buffer.readBigUInt64BE(2);
          if (wide > BigInt(MAX_MESSAGE_BYTES)) {
            socket.destroy();
            finish();
            return;
          }
          length = Number(wide);
          offset = 10;
        }
        // RFC 6455: every client→server frame is masked. An unmasked one is not a browser.
        if (!masked) {
          socket.destroy();
          finish();
          return;
        }
        if (buffer.length < offset + 4 + length) return;
        const mask = buffer.subarray(offset, offset + 4);
        const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
        }
        buffer = buffer.subarray(offset + 4 + length);

        if (opcode === OPCODE_CLOSE) {
          connection.close();
          finish();
          return;
        }
        if (opcode === OPCODE_PING) {
          socket.write(encodeFrame(OPCODE_PONG, payload));
          continue;
        }
        if (opcode === OPCODE_PONG) continue;
        if (opcode === OPCODE_BINARY) {
          // Everything on this wire is JSON text. A binary frame is a peer we do not know.
          connection.close();
          finish();
          return;
        }
        if (opcode === OPCODE_TEXT || opcode === OPCODE_CONTINUATION) {
          if (opcode === OPCODE_TEXT) {
            fragments = [];
            fragmentedOpcode = OPCODE_TEXT;
          }
          fragments.push(payload);
          const total = fragments.reduce((sum, part) => sum + part.length, 0);
          if (total > MAX_MESSAGE_BYTES) {
            socket.destroy();
            finish();
            return;
          }
          if (!fin) continue;
          const text = Buffer.concat(fragments).toString("utf8");
          fragments = [];
          if (fragmentedOpcode === OPCODE_TEXT) connection.onMessage?.(text);
          continue;
        }
        // Reserved opcode: an extension nobody negotiated.
        connection.close();
        finish();
        return;
      }
    });

    socket.on("error", () => {
      socket.destroy();
      finish();
    });
    socket.on("close", finish);

    options.onConnection(connection);
  });

  server.on("error", (error: Error) => {
    options.onListenError(error);
  });
  server.listen(options.port, options.host, () => {
    const address = server.address();
    if (address !== null && typeof address === "object") options.onListening(address.port);
  });

  return {
    boundPort() {
      const address = server.address();
      return address !== null && typeof address === "object" ? address.port : null;
    },
    close() {
      server.close();
      server.closeAllConnections();
    },
  };
}
