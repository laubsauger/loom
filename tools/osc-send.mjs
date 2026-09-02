#!/usr/bin/env node
/**
 * SEND OSC AT LOOM, FROM THIS MACHINE (T942 tier 3).
 *
 * A gate cannot plug in a controller and it cannot make a phone send OSC. §T959 shipped
 * `tools/midi-sender.html` for the MIDI half; a browser page cannot send UDP, so the OSC
 * half is this script instead. Both exist for the same reason: an I/O feature nobody can
 * exercise by hand is one nobody trusts.
 *
 * ## Use
 *
 *   node tools/osc-send.mjs 9000 /synth/cutoff 0.7
 *   node tools/osc-send.mjs 9000 /pad/xy 0.2 0.8
 *   node tools/osc-send.mjs --sweep 9000 /synth/cutoff      # 0→1→0, ten seconds
 *
 * In Loom: drop an OSC In node, set its Port to 9000, press Connect helper in the
 * inspector's OSC section with the pairing code `pnpm mcp:serve` printed, then Add address
 * → Learn and run this script. The row binds to the address it hears.
 *
 * ## It sends to 127.0.0.1 and takes no host argument
 *
 * Deliberate, and it is the same rule the helper binds by: the helper listens on loopback
 * only, so a sender anywhere else could not reach it anyway, and a `--host` flag here
 * would be a flag somebody points at a machine that is not theirs. §T458 measured what a
 * "local" tool that is not local costs.
 */

import { createSocket } from "node:dgram";

const HOST = "127.0.0.1";

const padded = (length) => (length + 3) & ~3;

/** OSC 1.0: address, type tags, then big-endian float32 arguments. */
function encode(address, args) {
  const tags = `,${"f".repeat(args.length)}`;
  const addressBytes = padded(address.length + 1);
  const tagBytes = padded(tags.length + 1);
  const out = Buffer.alloc(addressBytes + tagBytes + args.length * 4);
  out.write(address, 0, "ascii");
  out.write(tags, addressBytes, "ascii");
  args.forEach((value, index) => {
    out.writeFloatBE(value, addressBytes + tagBytes + index * 4);
  });
  return out;
}

const argv = process.argv.slice(2);
const sweep = argv[0] === "--sweep";
const rest = sweep ? argv.slice(1) : argv;
const port = Number(rest[0]);
const address = rest[1];
const values = rest.slice(2).map(Number);

if (!Number.isInteger(port) || port <= 0 || typeof address !== "string" || !address.startsWith("/")) {
  console.error("usage: node tools/osc-send.mjs [--sweep] <port> </address> [value ...]");
  process.exit(2);
}

const socket = createSocket("udp4");

const shoot = (args) =>
  new Promise((resolve, reject) => {
    socket.send(encode(address, args), port, HOST, (error) => (error ? reject(error) : resolve()));
  });

if (!sweep) {
  const args = values.length > 0 ? values : [1];
  await shoot(args);
  // "Sent" is all this can honestly claim, and the wording matches the app's own — the
  // datagram left this machine and nothing here knows whether it arrived.
  console.log(`sent ${address} ${args.join(" ")} to ${HOST}:${port} — arrival unconfirmed (UDP)`);
  socket.close();
} else {
  console.log(`sweeping ${address} on ${HOST}:${port} at 60 Hz for ten seconds — ctrl-C to stop`);
  const started = Date.now();
  const timer = setInterval(() => {
    const t = (Date.now() - started) / 1000;
    if (t > 10) {
      clearInterval(timer);
      socket.close();
      return;
    }
    // A triangle rather than a sine: the corners are visible in a plot, so "is this
    // actually moving" is answerable at a glance.
    const phase = (t / 5) % 2;
    void shoot([phase <= 1 ? phase : 2 - phase]).catch(() => undefined);
  }, 1000 / 60);
}
