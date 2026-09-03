import { describe, expect, it } from "vitest";

import { createEtherDreamEmulator } from "./ether-dream-emulator.ts";
import { createLaserHost, type LaserDiscovery } from "./laser-host.ts";
import type { LaserClock, TcpSocketLike } from "./laser-service.ts";

/**
 * T950 — the helper's laser door, driven end to end against the DAC emulator through
 * the SAME command shapes the bridge dispatches. What these pin beyond the service's
 * own suite: the vet runs on the socket's side, discovery is the capacity's only
 * source (and its refusal names the mechanism), the flat sample packing crosses
 * intact, and the bridge's page-death dispose leaves the DEVICE e-stopped — read off
 * the emulator's own light engine, never a spy (§V847).
 */

function rig(options: { discover?: boolean; deadManMs?: number } = {}) {
  const emulator = createEtherDreamEmulator({ bufferCapacity: 300, maxPointRate: 30000 });
  let dataHandler: ((bytes: Uint8Array) => void) | null = null;
  const socket: TcpSocketLike = {
    write(bytes) {
      const response = emulator.receive(bytes);
      if (response.length > 0) dataHandler?.(response);
    },
    onData(handler) {
      dataHandler = handler;
    },
    onClose() {},
    close() {},
  };
  let nowMs = 0;
  const ticks: Array<{ tick: () => void }> = [];
  const clock: LaserClock = {
    now: () => nowMs,
    every(_ms, tick) {
      const entry = { tick };
      ticks.push(entry);
      return () => ticks.splice(ticks.indexOf(entry), 1);
    },
  };
  const advance = (ms: number): void => {
    nowMs += ms;
    for (const entry of [...ticks]) entry.tick();
  };
  const discovery: LaserDiscovery = {
    discover: async () =>
      options.discover === false
        ? null
        : { bufferCapacity: emulator.bufferCapacity(), maxPointRate: 30000 },
  };
  const pushes: string[] = [];
  const host = createLaserHost({
    sockets: { connect: () => socket },
    discovery,
    clock,
    deadManMs: options.deadManMs ?? 100,
  });
  host.onState((state, detail) => pushes.push(`${state.phase}: ${detail}`));
  return { emulator, host, advance, pushes };
}

/** Two segments of a frame, flat (x, y, r, g, b) — the wire shape. */
const SAMPLES = [0, 0, 1, 0, 0, 0.5, 0.5, 0, 1, 0];

describe("T950 — the laser door vets before it dials", () => {
  it("refuses an empty host, a broadcast, and a DNS name — each with the vet's own sentence", async () => {
    const { host } = rig();
    const empty = await host.command({ kind: "connect", host: "" });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.reason).toContain("No destination");
    const broadcast = await host.command({ kind: "connect", host: "192.168.1.255" });
    expect(broadcast.ok).toBe(false);
    if (!broadcast.ok) expect(broadcast.reason).toContain("broadcast");
    const named = await host.command({ kind: "connect", host: "laser.local" });
    expect(named.ok).toBe(false);
    if (!named.ok) expect(named.reason).toContain("DNS");
  });

  it("no broadcast, no connection: the refusal names the mechanism and nothing is guessed", async () => {
    const { host } = rig({ discover: false });
    const outcome = await host.command({ kind: "connect", host: "192.168.1.50" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toContain("7654");
      expect(outcome.reason).toContain("never guessed");
    }
    expect(outcome.state.phase).toBe("disconnected");
  });

  it("a good connect carries the DEVICE'S OWN numbers in the state report", async () => {
    const { host } = rig();
    const outcome = await host.command({ kind: "connect", host: "192.168.1.50" });
    expect(outcome.ok).toBe(true);
    expect(outcome.state.phase).toBe("connected");
    expect(outcome.state.device).toEqual({ bufferCapacity: 300, maxPointRate: 30000 });
  });
});

describe("T950 — commands drive the device, and the device's state comes back", () => {
  it("arm → stream → the emulator holds the block; unarmed stream refuses with G1's sentence", async () => {
    const { emulator, host } = rig();
    await host.command({ kind: "connect", host: "192.168.1.50" });
    const early = await host.command({ kind: "stream", samples: SAMPLES, pointRate: 30000 });
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.reason).toContain("never a document state");

    await host.command({ kind: "arm" });
    const streamed = await host.command({ kind: "stream", samples: SAMPLES, pointRate: 30000 });
    expect(streamed.ok).toBe(true);
    expect(streamed.state.phase).toBe("streaming");
    // 2 samples + the blanked tail of 8: the device's own count, not our bookkeeping.
    expect(emulator.status().bufferFullness).toBe(10);
  });

  it("a refused e-stop clear surfaces the device's refusal", async () => {
    const { emulator, host } = rig();
    await host.command({ kind: "connect", host: "192.168.1.50" });
    emulator.holdEmergencyStop(true);
    await host.command({ kind: "estop" });
    const refused = await host.command({ kind: "clearEstop" });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toContain("REFUSED");
    emulator.holdEmergencyStop(false);
    const cleared = await host.command({ kind: "clearEstop" });
    expect(cleared.ok).toBe(true);
  });
});

describe("T950 — G2 through the bridge's own paths", () => {
  it("the dead-man pushes its state change and the DEVICE ends e-stopped", async () => {
    const { emulator, host, advance, pushes } = rig({ deadManMs: 100 });
    await host.command({ kind: "connect", host: "192.168.1.50" });
    await host.command({ kind: "arm" });
    await host.command({ kind: "stream", samples: SAMPLES, pointRate: 30000 });
    advance(150);
    expect(emulator.status().lightEngineState).toBe(3);
    expect(pushes.some((entry) => entry.includes("dead-man"))).toBe(true);
  });

  it("dispose — the bridge's page-death path — blanks, stops and e-stops the device", async () => {
    const { emulator, host } = rig();
    await host.command({ kind: "connect", host: "192.168.1.50" });
    await host.command({ kind: "arm" });
    await host.command({ kind: "stream", samples: SAMPLES, pointRate: 30000 });
    host.dispose();
    expect(emulator.status().lightEngineState).toBe(3);
  });
});
