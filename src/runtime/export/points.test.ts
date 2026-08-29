import { describe, expect, it } from "vitest";

import { ATTRIBUTE_STRIDES } from "../../points/attributes.ts";
import { scratchResourceId } from "../../compiler/resources.ts";
import { createPointsReadback, type PointSetInfo } from "./points.ts";

/**
 * T125's export half: windowed decode against the shared stride tables (the vec3f
 * stride-16 trap included), the ≤10Hz throttle, and the named refusals.
 */

const INFO: PointSetInfo = {
  attributes: [
    { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
    { name: "id", type: "u32", semantic: "id", default: [0] },
  ],
  capacity: 100,
};

function positionBuffer(): ArrayBuffer {
  // Slot i holds (i, 2i, 3i) at stride 16 — the padded component is garbage on purpose.
  const data = new Float32Array(100 * 4);
  for (let index = 0; index < 100; index += 1) {
    data.set([index, index * 2, index * 3, 999], index * 4);
  }
  return data.buffer;
}

function harness(overrides: { now?: () => number } = {}) {
  const reads: string[] = [];
  const readback = createPointsReadback({
    readBuffer: (resourceId) => {
      reads.push(resourceId);
      if (resourceId.endsWith(":position")) return Promise.resolve(positionBuffer());
      return Promise.resolve(new Uint32Array(Array.from({ length: 100 }, (_, i) => i * 7)).buffer);
    },
    pointSetInfo: (nodeId) => (nodeId === "sim" ? INFO : undefined),
    now: overrides.now ?? (() => 0),
    minIntervalMs: 100,
  });
  return { readback, reads };
}

describe("createPointsReadback (T125)", () => {
  it("decodes a window at the real stride — the padded vec3 lane never leaks", async () => {
    const { readback, reads } = harness();
    const window = await readback.read({ nodeId: "sim", start: 10, count: 3 });

    expect(reads[0]).toBe(scratchResourceId("sim", "position"));
    expect(window.type).toBe("vec3f");
    expect(ATTRIBUTE_STRIDES["vec3f"]).toBe(16); // the trap this test guards
    expect(window.values).toEqual([
      [10, 20, 30],
      [11, 22, 33],
      [12, 24, 36],
    ]);
    expect(window.capacity).toBe(100);
  });

  it("reads unsigned attributes as u32, not reinterpreted floats", async () => {
    let clock = 0;
    const { readback } = harness({ now: () => (clock += 1000) });
    const window = await readback.read({ nodeId: "sim", attribute: "id", start: 5, count: 2 });
    expect(window.values).toEqual([[35], [42]]);
  });

  it("clamps the window to capacity and the 256 cap", async () => {
    const { readback } = harness();
    const window = await readback.read({ nodeId: "sim", start: 98, count: 50 });
    expect(window.start).toBe(98);
    expect(window.count).toBe(2);
  });

  it("throttles to the configured interval (§V16), refusing rather than queueing", async () => {
    let clock = 0;
    const { readback } = harness({ now: () => clock });
    await readback.read({ nodeId: "sim", count: 1 });
    clock = 50;
    await expect(readback.read({ nodeId: "sim", count: 1 })).rejects.toThrow(/throttled/);
    clock = 150;
    await expect(readback.read({ nodeId: "sim", count: 1 })).resolves.toBeDefined();
  });

  it("names unknown nodes and attributes instead of guessing", async () => {
    let clock = 0;
    const { readback } = harness({ now: () => (clock += 1000) });
    await expect(readback.read({ nodeId: "nope" })).rejects.toThrow(/no point set/);
    await expect(readback.read({ nodeId: "sim", attribute: "vel" })).rejects.toThrow(/Declared: position, id/);
  });
});
