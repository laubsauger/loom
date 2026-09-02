#!/usr/bin/env node
/**
 * LISTEN FOR WHAT LOOM SENDS (T942 tier 3) — the other half of `osc-send.mjs`.
 *
 * `oscOut` can only ever report that a datagram LEFT this machine (§T950 gap 3). This is
 * how a person checks the other end of that claim by hand: run it, point an OSC Out node
 * at `localhost` and this port, and watch the addresses and values arrive.
 *
 * ## Use
 *
 *   node tools/osc-listen.mjs 9001
 *
 * In Loom: drop an OSC Out node, wire something into it, set Host to `localhost` and Port
 * to 9001. Until BOTH are set it transmits nothing — there is no default destination, and
 * the inspector says so rather than quietly doing nothing.
 *
 * It binds 127.0.0.1, not the wildcard, for §T458's reason: a tool that says "local" and
 * listens on every interface is the thing that finding measured.
 */

import { createSocket } from "node:dgram";

const HOST = "127.0.0.1";
const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port <= 0) {
  console.error("usage: node tools/osc-listen.mjs <port>");
  process.exit(2);
}

const padded = (length) => (length + 3) & ~3;

function readString(buffer, offset) {
  let end = offset;
  while (end < buffer.length && buffer[end] !== 0) end += 1;
  if (end >= buffer.length) return null;
  return { value: buffer.toString("ascii", offset, end), next: offset + padded(end - offset + 1) };
}

/** Enough of OSC 1.0 to read what this app sends: one message, float32 arguments. */
function decode(buffer) {
  const address = readString(buffer, 0);
  if (address === null) return null;
  const tags = readString(buffer, address.next);
  if (tags === null || !tags.value.startsWith(",")) return null;
  const args = [];
  let offset = tags.next;
  for (const tag of tags.value.slice(1)) {
    if (tag === "f" && offset + 4 <= buffer.length) {
      args.push(buffer.readFloatBE(offset));
      offset += 4;
    } else if (tag === "i" && offset + 4 <= buffer.length) {
      args.push(buffer.readInt32BE(offset));
      offset += 4;
    } else {
      // An argument this script cannot size makes every argument after it unlocatable, so
      // it stops rather than guessing — the same rule the real decoder follows.
      break;
    }
  }
  return { address: address.value, args };
}

const socket = createSocket("udp4");
socket.on("message", (data) => {
  const message = decode(data);
  console.log(
    message === null
      ? `${String(data.length)} bytes that are not an OSC message this script reads`
      : `${message.address} ${message.args.map((value) => value.toFixed(4)).join(" ")}`,
  );
});
socket.bind(port, HOST, () => {
  console.log(`listening for OSC on ${HOST}:${String(port)} — ctrl-C to stop`);
});
