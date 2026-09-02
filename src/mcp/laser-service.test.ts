import { describe, expect, it } from "vitest";

import { COMMAND, POINT_BYTES } from "./ether-dream.ts";
import { createEtherDreamEmulator } from "./ether-dream-emulator.ts";
import { createLaserService, type LaserClock, type TcpSocketLike } from "./laser-service.ts";

/**
 * T950 — the helper-side lifecycle against the DAC emulator, on a fake clock: the
 * dead-man ACTUALLY FIRING is asserted here, deterministically, which is the whole
 * point of injecting time into the one place a real timer will live (G2). Every
 * transition's refusal is asserted as a sentence, per §V365.
 */

function rig(deadManMs = 100) {
  const emulator = createEtherDreamEmulator({ bufferCapacity: 400, maxPointRate: 30000 });
  const written: Uint8Array[] = [];
  let dataHandler: ((bytes: Uint8Array) => void) | null = null;
  const socket: TcpSocketLike = {
    write(bytes) {
      written.push(bytes);
      const response = emulator.receive(bytes);
      if (response.length > 0) dataHandler?.(response);
    },
    onData(handler) {
      dataHandler = handler;
    },
    onClose() {
      /* the emulator never hangs up */
    },
    close() {
      /* nothing to release */
    },
  };
  let nowMs = 0;
  const ticks: Array<{ ms: number; tick: () => void }> = [];
  const clock: LaserClock = {
    now: () => nowMs,
    every(ms, tick) {
      const entry = { ms, tick };
      ticks.push(entry);
      return () => ticks.splice(ticks.indexOf(entry), 1);
    },
  };
  const advance = (ms: number): void => {
    nowMs += ms;
    for (const entry of [...ticks]) entry.tick();
  };
  const states: string[] = [];
  const service = createLaserService({
    sockets: { connect: () => socket },
    clock,
    deadManMs,
    onState: (state, reason) => states.push(`${state.phase}: ${reason}`),
  });
  const device = { bufferCapacity: emulator.bufferCapacity(), maxPointRate: 30000 };
  return { emulator, service, written, advance, states, device };
}

const SAMPLES = Array.from({ length: 20 }, (_, i) => ({ x: i / 20, y: 0, r: 1, g: 0, b: 0 }));

/** Command opcodes in write order, one letter each, for sequence assertions. */
function opcodes(written: readonly Uint8Array[]): number[] {
  return written.map((bytes) => bytes[0]!);
}

describe("T950 — the armed lifecycle refuses in sentences", () => {
  it("stream is refused before connect, before arm, and after an e-stop — each with its reason", () => {
    const { service, device } = rig();
    expect(service.stream(SAMPLES, 30000)).toContain("no device");
    service.connect("192.168.1.50", 7765, device);
    expect(service.stream(SAMPLES, 30000)).toContain("not armed");
    expect(service.stream(SAMPLES, 30000)).toContain("never a document state"); // G1, in the copy
    service.arm();
    expect(service.stream(SAMPLES, 30000)).toBeNull();
    service.estop();
    expect(service.stream(SAMPLES, 30000)).toContain("emergency-stopped");
  });

  it("arming requires a connection, and the first stream opens the session at the clamped rate", () => {
    const { service, written, device } = rig();
    service.connect("192.168.1.50", 7765, device);
    service.arm();
    expect(service.stream(SAMPLES, 90000)).toBeNull(); // wants 90k; device says 30k
    expect(opcodes(written)).toEqual([COMMAND.prepare, COMMAND.begin, COMMAND.data]);
    const begin = written[1]!;
    const view = new DataView(begin.buffer, begin.byteOffset);
    expect(view.getUint32(3, true)).toBe(30000); // G9: clamped to the device's report
  });

  it("every streamed block ends blanked — G3 through the service, read from the wire", () => {
    const { service, written, device } = rig();
    service.connect("192.168.1.50", 7765, device);
    service.arm();
    service.stream(SAMPLES, 30000);
    const data = written.at(-1)!;
    expect(data[0]).toBe(COMMAND.data);
    // The final points of the block: colour and intensity all zero.
    for (let tail = 0; tail < 8; tail += 1) {
      const at = data.length - (tail + 1) * POINT_BYTES;
      const view = new DataView(data.buffer, data.byteOffset + at, POINT_BYTES);
      const light =
        view.getUint16(6, true) + view.getUint16(8, true) + view.getUint16(10, true) + view.getUint16(12, true);
      expect(light, `tail point ${String(tail)}`).toBe(0);
    }
  });

  it("withholds a frame the device has no room for instead of drawing NAK-Full", () => {
    const { service, device } = rig();
    service.connect("192.168.1.50", 7765, device);
    service.arm();
    const huge = Array.from({ length: 500 }, () => ({ x: 0, y: 0, r: 1, g: 1, b: 1 }));
    const refusal = service.stream(huge, 30000);
    expect(refusal).toContain("no room");
  });
});

describe("T950 — the dead-man (G2), deterministically fired", () => {
  it("blanks, stops and e-stops when blocks stop arriving; the emulator ends emergency-stopped", () => {
    const { emulator, service, written, advance, states, device } = rig(100);
    service.connect("192.168.1.50", 7765, device);
    service.arm();
    service.stream(SAMPLES, 30000);
    expect(service.state().phase).toBe("streaming");

    advance(60); // inside the window: nothing fires
    expect(service.state().phase).toBe("streaming");

    written.length = 0;
    advance(60); // 120 ms since the last block: past the 100 ms dead-man
    expect(opcodes(written)).toEqual([COMMAND.data, COMMAND.stop, COMMAND.emergencyStop]);
    expect(service.state().phase).toBe("estopped");
    expect(emulator.status().lightEngineState).toBe(3); // the DEVICE is e-stopped
    expect(states.some((entry) => entry.includes("dead-man"))).toBe(true);
  });

  it("keeps quiet while blocks keep arriving", () => {
    const { service, written, advance, device } = rig(100);
    service.connect("192.168.1.50", 7765, device);
    service.arm();
    for (let frame = 0; frame < 5; frame += 1) {
      service.stream(SAMPLES, 30000);
      advance(60);
    }
    expect(opcodes(written)).not.toContain(COMMAND.emergencyStop);
    expect(service.state().phase).toBe("streaming");
  });

  it("dispose mid-stream fires the same sequence — a closed session never leaves a beam", () => {
    const { emulator, service, written, device } = rig();
    service.connect("192.168.1.50", 7765, device);
    service.arm();
    service.stream(SAMPLES, 30000);
    written.length = 0;
    service.dispose();
    expect(opcodes(written)).toEqual([COMMAND.data, COMMAND.stop, COMMAND.emergencyStop]);
    expect(emulator.status().lightEngineState).toBe(3);
  });
});

describe("T950 — the e-stop arc against a device that argues back (G7)", () => {
  it("a held condition refuses to clear and the refusal is surfaced, not retried", () => {
    const { emulator, service, device } = rig();
    service.connect("192.168.1.50", 7765, device);
    emulator.holdEmergencyStop(true);
    service.estop();
    service.clearEstop();
    expect(service.state().clearRefused).toBe(true);

    emulator.holdEmergencyStop(false);
    service.clearEstop();
    expect(service.state().clearRefused).toBe(false);
    expect(emulator.status().lightEngineState).toBe(0); // ready again
  });
});
