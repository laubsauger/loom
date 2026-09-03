import { describe, expect, it } from "vitest";

import {
  COMMAND,
  RESPONSE,
  POINT_BYTES,
  blankedTail,
  clampPointRate,
  createEtherDreamClient,
  deadManPayloads,
  encodeBegin,
  encodeData,
  encodePrepare,
  encodeQueueRate,
  encodeSingle,
  parseBroadcast,
  parseResponse,
  samplesToPoints,
  applyScanFail,
  SCAN_FAIL_START,
  type DacPoint,
} from "./ether-dream.ts";
import { createEtherDreamEmulator } from "./ether-dream-emulator.ts";

/**
 * T950 — the Ether Dream protocol, gated to exact bytes with no hardware in the room.
 *
 * Two layers on purpose. The BYTE layer pins the wire against the vendor's struct
 * definitions (including the one place the spec contradicts its own comment — the
 * queue-rate opcode). The CONVERSATION layer runs the client against the emulator's
 * state machines, because the failure modes that matter — overflow, out-of-sequence
 * commands, a latched e-stop refusing to clear, underflow — only exist between two
 * parties. The safety encoders (G3/G4/G9) are gated here too, since they are the only
 * functions that produce point bytes and their direction (blank-and-hold, never
 * clamp-to-centre) is the difference between a bug and a hazard.
 */

describe("T950 — the wire, byte-exact", () => {
  it("encodes every command exactly as the spec's structs lay them out", () => {
    expect([...encodePrepare()]).toEqual([0x70]);
    // begin: 'b', u16 low_water_mark LE, u32 point_rate LE. 30000 = 0x7530.
    expect([...encodeBegin(0, 30000)]).toEqual([0x62, 0, 0, 0x30, 0x75, 0, 0]);
    expect([...encodeQueueRate(30000)]).toEqual([0x74, 0x30, 0x75, 0, 0]);
    expect([...encodeSingle(COMMAND.stop)]).toEqual([0x73]);
    expect([...encodeSingle(COMMAND.emergencyStop)]).toEqual([0x00]);
    expect([...encodeSingle(COMMAND.clearEmergencyStop)]).toEqual([0x63]);
    expect([...encodeSingle(COMMAND.ping)]).toEqual([0x3f]);
  });

  it("queue-rate is 0x74, NOT ASCII 'q' — the spec contradicts its own comment", () => {
    // The vendor page writes "'q' (0x74)"; 'q' is 0x71. The reference implementation
    // (nannou-org/ether-dream protocol.rs, run against real DACs) uses 0x74, so the
    // BYTE VALUE wins. This test is here so nobody helpfully "fixes" it to 0x71.
    expect(COMMAND.queueRate).toBe(0x74);
    expect("q".charCodeAt(0)).toBe(0x71);
  });

  it("packs an 18-byte dac_point, little-endian, signed axes", () => {
    const bytes = encodeData([
      { control: 0x8001, x: -32768, y: 32767, r: 65535, g: 0, b: 0x1234, i: 65535, u1: 1, u2: 2 },
    ]);
    expect(bytes.length).toBe(3 + POINT_BYTES);
    expect([...bytes.subarray(0, 3)]).toEqual([0x64, 1, 0]); // 'd', npoints LE
    expect([...bytes.subarray(3)]).toEqual([
      0x01, 0x80, // control
      0x00, 0x80, // x = -32768
      0xff, 0x7f, // y = 32767
      0xff, 0xff, // r
      0x00, 0x00, // g
      0x34, 0x12, // b
      0xff, 0xff, // i
      0x01, 0x00, // u1
      0x02, 0x00, // u2
    ]);
  });

  it("round-trips a response and a broadcast through parse", () => {
    const emulator = createEtherDreamEmulator({ bufferCapacity: 1799 });
    const response = parseResponse(emulator.receive(encodePrepare()));
    expect(response.response).toBe(RESPONSE.ack);
    expect(response.command).toBe(COMMAND.prepare);
    expect(response.status.playbackState).toBe(1); // prepared
    expect(response.status.bufferFullness).toBe(0);

    // A broadcast frame, hand-laid: mac, hw 2, sw 3, capacity 1799, max rate 30000.
    const broadcast = new Uint8Array(16 + 20);
    const view = new DataView(broadcast.buffer);
    broadcast.set([1, 2, 3, 4, 5, 6], 0);
    view.setUint16(6, 2, true);
    view.setUint16(8, 3, true);
    view.setUint16(10, 1799, true);
    view.setUint32(12, 30000, true);
    const parsed = parseBroadcast(broadcast);
    expect(parsed.mac).toEqual([1, 2, 3, 4, 5, 6]);
    expect(parsed.bufferCapacity).toBe(1799);
    expect(parsed.maxPointRate).toBe(30000);
  });
});

describe("T950 — the safety encoders (G3/G4/G9)", () => {
  it("G4: a NaN blanks and HOLDS the last valid position — never the centre of the field", () => {
    const { points } = samplesToPoints(
      [
        { x: 0.5, y: -0.25, r: 1, g: 0, b: 0, },
        { x: Number.NaN, y: 0, r: 1, g: 1, b: 1 },
        { x: 4, y: 0, r: 1, g: 1, b: 1 }, // out of range is the same hazard
      ],
      { x: 0, y: 0 },
    );
    const valid = points[0]!;
    expect(valid.x).toBe(Math.round(0.5 * 32767));
    expect(valid.i).toBe(65535);
    for (const bad of [points[1]!, points[2]!]) {
      // The hazard geometry a clamp would produce: a full-brightness point parked at
      // (0,0). The rule is the opposite — colour ZEROED, position HELD.
      expect(bad.x).toBe(valid.x);
      expect(bad.y).toBe(valid.y);
      expect(bad.r + bad.g + bad.b + bad.i).toBe(0);
    }
  });

  it("G3: the blanked tail is dark, at the last position, never empty", () => {
    const tail = blankedTail({ x: -1, y: 1 }, 4);
    expect(tail.length).toBe(4);
    for (const point of tail) {
      expect(point.x).toBe(-32767);
      expect(point.y).toBe(32767);
      expect(point.r + point.g + point.b + point.i).toBe(0);
    }
    expect(blankedTail({ x: 0, y: 0 }, 0).length).toBe(1); // never an empty tail
  });

  it("G9: the rate clamps to the device's reported maximum, lowered — never raised — by a ceiling", () => {
    expect(clampPointRate(50000, 30000)).toBe(30000);
    expect(clampPointRate(20000, 30000)).toBe(20000);
    expect(clampPointRate(50000, 30000, 24000)).toBe(24000);
    expect(clampPointRate(50000, 30000, 90000)).toBe(30000); // a ceiling cannot raise
    expect(clampPointRate(-5, 30000)).toBe(1);
  });

  it("G2: the dead-man fires darkness, then stop, then e-stop — in that order", () => {
    const payloads = deadManPayloads({ x: 0.25, y: 0.25 });
    expect(payloads.length).toBe(3);
    expect(payloads[0]![0]).toBe(COMMAND.data);
    expect(payloads[1]![0]).toBe(COMMAND.stop);
    expect(payloads[2]![0]).toBe(COMMAND.emergencyStop);
    // And the darkness really is dark: every point in the first payload carries zero
    // colour and zero intensity.
    const data = payloads[0]!;
    for (let at = 3; at < data.length; at += POINT_BYTES) {
      const view = new DataView(data.buffer, data.byteOffset + at, POINT_BYTES);
      expect(view.getUint16(6, true) + view.getUint16(8, true) + view.getUint16(10, true) + view.getUint16(12, true)).toBe(0);
    }
  });
});

describe("T950 — client against emulator: the conversation is the contract", () => {
  function connected() {
    const emulator = createEtherDreamEmulator({ bufferCapacity: 100, maxPointRate: 30000 });
    const client = createEtherDreamClient();
    client.onBroadcast({
      mac: [0, 0, 0, 0, 0, 0],
      hwRevision: 0,
      swRevision: 0,
      bufferCapacity: emulator.bufferCapacity(),
      maxPointRate: 30000,
      status: emulator.status(),
    });
    const exchange = (bytes: Uint8Array) => client.onResponse(parseResponse(emulator.receive(bytes)));
    return { emulator, client, exchange };
  }

  const SAMPLE = { x: 0, y: 0, r: 1, g: 1, b: 1 };

  it("streams inside the credit window and NAK-Full never fires", () => {
    const { client, exchange } = connected();
    expect(client.writable()).toBe(0); // capacity known, but no session: idle writes nothing
    exchange(encodePrepare());
    exchange(encodeBegin(0, 30000));
    expect(client.state().phase).toBe("playing");

    // Fill to the device's reported capacity in blocks the credit window allows.
    let sent = 0;
    while (client.writable() > 0) {
      const block = Math.min(client.writable(), 40);
      const { points } = samplesToPoints(Array.from({ length: block }, () => SAMPLE));
      const response = exchange(encodeData(points));
      expect(response.response).toBe(RESPONSE.ack);
      client.wrote(0); // the response already replaced the report; nothing is in flight
      sent += block;
    }
    expect(sent).toBe(100); // exactly the capacity, no overflow attempt
    expect(client.writable()).toBe(0);
  });

  it("the credit model counts in-flight writes before any response lands", () => {
    const { client, exchange } = connected();
    exchange(encodePrepare());
    exchange(encodeBegin(0, 30000));
    client.wrote(60);
    expect(client.writable()).toBe(40); // capacity 100 − in-flight 60
    client.wrote(40);
    expect(client.writable()).toBe(0); // a further block would risk NAK-Full: withheld
  });

  it("an overfull write is refused by the DEVICE with NAK-Full — the model's failure, not its flow control", () => {
    const { emulator, exchange } = connected();
    exchange(encodePrepare());
    exchange(encodeBegin(0, 30000));
    const { points } = samplesToPoints(Array.from({ length: 101 }, () => SAMPLE));
    const response = exchange(encodeData(points));
    expect(response.response).toBe(RESPONSE.nakFull);
    expect(emulator.status().bufferFullness).toBe(0); // refused wholesale, not truncated
  });

  it("drain frees credit; running dry raises the underflow flag the client surfaces", () => {
    const { emulator, client, exchange } = connected();
    exchange(encodePrepare());
    exchange(encodeBegin(0, 30000));
    const { points } = samplesToPoints(Array.from({ length: 50 }, () => SAMPLE));
    exchange(encodeData(points));
    emulator.drain(20);
    const after = exchange(encodeSingle(COMMAND.ping));
    expect(after.status.bufferFullness).toBe(30);
    expect(client.writable()).toBe(70);

    emulator.drain(1000); // the stream runs dry
    const dry = exchange(encodeSingle(COMMAND.ping));
    expect(dry.status.playbackState).toBe(0); // back to idle
    expect(client.state().underflowed).toBe(true);
  });

  it("commands out of sequence are NAK-Invalid: begin before prepare, data while idle", () => {
    const { exchange } = connected();
    expect(exchange(encodeBegin(0, 30000)).response).toBe(RESPONSE.nakInvalid);
    const { points } = samplesToPoints([SAMPLE]);
    expect(exchange(encodeData(points)).response).toBe(RESPONSE.nakInvalid);
  });

  it("e-stop latches, a held condition REFUSES to clear, and the refusal is surfaced — not retried into silence", () => {
    const { emulator, client, exchange } = connected();
    exchange(encodePrepare());
    exchange(encodeBegin(0, 30000));
    emulator.holdEmergencyStop(true);
    exchange(encodeSingle(COMMAND.emergencyStop));
    expect(client.state().phase).toBe("estopped");
    expect(client.writable()).toBe(0); // an e-stopped client writes nothing

    const refused = exchange(encodeSingle(COMMAND.clearEmergencyStop));
    expect(refused.response).toBe(RESPONSE.nakStopCondition);
    expect(client.state().clearRefused).toBe(true); // G7: the UI shows this, no silent retry

    emulator.holdEmergencyStop(false);
    const cleared = exchange(encodeSingle(COMMAND.clearEmergencyStop));
    expect(cleared.response).toBe(RESPONSE.ack);
    expect(client.state().clearRefused).toBe(false);
    expect(client.state().phase).toBe("idle");
  });

  it("survives TCP chunking: a command split across receives answers once, whole", () => {
    const { emulator } = connected();
    const begin = encodeBegin(0, 30000);
    expect(emulator.receive(encodePrepare()).length).toBe(22);
    expect(emulator.receive(begin.subarray(0, 3)).length).toBe(0); // partial: no answer yet
    const rest = emulator.receive(begin.subarray(3));
    expect(rest.length).toBe(22);
    expect(parseResponse(rest).response).toBe(RESPONSE.ack);
    expect(emulator.status().playbackState).toBe(2);
  });
});

describe("T950 — G5's software scan-fail, the pure dwell tracker", () => {
  const lit = (x: number, y = 0): DacPoint => ({ control: 0, x, y, r: 65535, g: 0, b: 0, i: 65535, u1: 0, u2: 0 });
  const dark = (x: number): DacPoint => ({ ...lit(x), r: 0, g: 0, b: 0, i: 0 });
  const blankedCopy = (point: DacPoint): DacPoint => ({ ...point, r: 0, g: 0, b: 0, i: 0 });

  it("blanks EXACTLY beyond the dwell budget — position kept, light cut (G4's shape)", () => {
    const run = Array.from({ length: 10 }, () => lit(1000, -2000));
    const out = applyScanFail(run, SCAN_FAIL_START, 6);
    expect(out.blanked).toBe(4);
    expect(out.points.slice(0, 6)).toEqual(run.slice(0, 6)); // the budget itself passes lit
    expect(out.points.slice(6)).toEqual(run.slice(6).map(blankedCopy));
    expect(out.state).toEqual({ x: 1000, y: -2000, dwell: 10 }); // still counting: no re-light while stuck
  });

  it("a MOVING beam is never falsely blanked — the legitimate case the guard could swallow", () => {
    // 40-unit steps: every step is within epsilon of its NEIGHBOUR, but displacement is
    // measured from the run's ANCHOR, so the crawl escapes at 80 units and the run
    // resets. Successive-difference comparison would label this beam permanently
    // stationary and blank a beam that is, in fact, moving.
    const crawl = [lit(0), lit(40), lit(80), lit(120), lit(160), lit(200)];
    const out = applyScanFail(crawl, SCAN_FAIL_START, 2);
    expect(out.blanked).toBe(0);
    expect(out.points).toEqual(crawl);
  });

  it("darkness resets the dwell — a blanked move is the galvo travelling, not the beam dwelling", () => {
    const withRest = [lit(500), lit(500), dark(500), lit(500), lit(500)];
    const rested = applyScanFail(withRest, SCAN_FAIL_START, 3);
    expect(rested.blanked).toBe(0);
    // Cut the dark point and the same lit points DO exceed the budget: the reset is
    // load-bearing, not incidental.
    const without = [lit(500), lit(500), lit(500), lit(500)];
    expect(applyScanFail(without, SCAN_FAIL_START, 3).blanked).toBe(1);
    expect(rested.points).toEqual(withRest);
  });

  it("the state crosses blocks — a frame boundary is not an amnesty", () => {
    const frame = Array.from({ length: 4 }, () => lit(-3000, 3000));
    const first = applyScanFail(frame, SCAN_FAIL_START, 6);
    expect(first.blanked).toBe(0);
    const second = applyScanFail(frame, first.state, 6);
    expect(second.blanked).toBe(2); // dwell 5,6 pass; 7,8 blank
    expect(second.points.slice(0, 2)).toEqual(frame.slice(0, 2));
    expect(second.points.slice(2)).toEqual(frame.slice(2).map(blankedCopy));
  });
});
