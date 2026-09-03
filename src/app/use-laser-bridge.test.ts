// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createNodeRegistry } from "../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import type { GraphDocument } from "../domain/types/graph.ts";
import type { DeviceClient } from "../mcp/device-client.ts";
import type { LaserOutcome, LaserStateReport } from "../mcp/device-protocol.ts";
import type { LoomBackend } from "../runtime/backend/index.ts";
import { laserPumpNodeTypes, samplesFromBuffers, useLaserBridge } from "./use-laser-bridge.ts";

/**
 * T950 — the pump WITH its transport: the per-path mechanism checks the old
 * no-transport test demanded of its replacement (its own words: "when the helper
 * driver lands and a sender legitimately appears here, this test is the reviewer's
 * tap on the shoulder to replace it with per-path mechanism checks"). Each no-fire
 * path is asserted BEHAVIOURALLY — the fake client counts what crossed — and the
 * one legitimate firing path is asserted too, because a guard that can never pass
 * light would be a different device (the flicker metric's §V839 lesson: verify the
 * sign, not just the response).
 */

const registry = createNodeRegistry(allNodeDefinitions).view();

const graph: GraphDocument = {
  revision: 1,
  nodes: {
    beam: { id: "beam", type: "laserPath", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {}, label: "beam1" },
    out: { id: "out", type: "laserOut", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {}, label: "laserout1" },
  },
  edges: {
    e1: { id: "e1", source: { nodeId: "beam", portId: "out" }, target: { nodeId: "out", portId: "points" } },
  },
  groups: {},
} as never;

const READY: LaserStateReport = {
  phase: "armed",
  clearRefused: false,
  underflowed: false,
  bufferFullness: 0,
  device: { bufferCapacity: 300, maxPointRate: 30000 },
};

function fakeClient() {
  const commands: Array<Record<string, unknown>> = [];
  let pushListener: ((detail: string) => void) | null = null;
  const client = {
    laser: (command: Record<string, unknown>): Promise<LaserOutcome> => {
      commands.push(command);
      return Promise.resolve({ ok: true, state: READY });
    },
    onLaserState: (listener: (detail: string) => void) => {
      pushListener = listener;
    },
  } as unknown as DeviceClient;
  return { client, commands, push: (detail: string) => pushListener?.(detail) };
}

/** Two lit samples, one blanked move, then the park marker and stale tail. */
function fakeBackend() {
  const position = new Float32Array(4 * 4);
  const tint = new Float32Array(4 * 4);
  position.set([0.5, -0.25, 0, 0], 0);
  tint.set([1, 0.5, 0.25, 1], 0);
  position.set([0.625, -0.125, 0, 0], 4);
  tint.set([0.875, 0.875, 0.875, 0], 4); // unlit: a blanked move — position crosses, colour must not
  position.set([0.75, -0.5, 0, 0], 8);
  tint.set([0, 1, 0, 1], 8);
  position.set([9, 9, -1.0e6, 0], 12); // the park marker: everything after is stale
  tint.set([1, 1, 1, 1], 12);
  return {
    readBuffer: (resourceId: string) =>
      Promise.resolve((resourceId.endsWith(":position") ? position : tint).buffer),
  } as unknown as LoomBackend;
}

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

function mount(client: DeviceClient | null, backend: LoomBackend | null) {
  return renderHook(() =>
    useLaserBridge({ deviceClient: () => client, backend: () => backend }),
  );
}

describe("T950 — samplesFromBuffers is the wire's exact shape", () => {
  it("trims at the park marker and zeroes the colour of a blanked move, never its position", () => {
    // Every value exact in f32, so the equality is EXACT — no closeTo fog (§V147).
    const position = new Float32Array([0.5, -0.25, 0, 0, 0.625, -0.125, 0, 0, 9, 9, -1.0e6, 0]);
    const tint = new Float32Array([1, 0.5, 0.25, 1, 0.875, 0.875, 0.875, 0, 1, 1, 1, 1]);
    expect(samplesFromBuffers(position, tint)).toEqual([
      0.5, -0.25, 1, 0.5, 0.25,
      0.625, -0.125, 0, 0, 0, // the blanked move: the galvo's path, dark
    ]);
  });
});

describe("T950 — every no-fire path, by mechanism", () => {
  it("derives its node set from EMISSION_PUMPS, never a hand-list (§T1006)", () => {
    expect(laserPumpNodeTypes()).toEqual(["laserOut"]);
  });

  it("BLOCKED policy (a take): the refusal's own sentence, and nothing crosses the client", async () => {
    const { client, commands } = fakeClient();
    const view = mount(client, fakeBackend());
    act(() => view.result.current.sync(graph, registry, "blocked"));
    await flush();
    expect(commands).toEqual([]);
    expect(view.result.current.diagnostics[0]?.code).toBe("laser.emission.blocked");
    expect(view.result.current.diagnostics[0]?.message).toContain("only a live session");
  });

  it("NO HELPER: says what to do (§T948's copy rule), and there is no client to cross", async () => {
    const view = mount(null, fakeBackend());
    act(() => view.result.current.sync(graph, registry, "live-session"));
    await flush();
    expect(view.result.current.diagnostics[0]?.code).toBe("laser.helper.absent");
    expect(view.result.current.diagnostics[0]?.message).toContain("pnpm mcp:serve");
  });

  it("UNARMED: G1 in the diagnostic, and no stream command is even attempted", async () => {
    const { client, commands } = fakeClient();
    const view = mount(client, fakeBackend());
    act(() => view.result.current.sync(graph, registry, "live-session"));
    await flush();
    expect(commands.filter((entry) => entry["kind"] === "stream")).toEqual([]);
    expect(view.result.current.diagnostics[0]?.code).toBe("laser.disarmed");
    expect(view.result.current.diagnostics[0]?.message).toContain("never saved with the document");
  });
});

describe("T950 — the one firing path, and what ends it", () => {
  it("ARMED and live: the planned stream crosses, exactly as the buffers hold it", async () => {
    const { client, commands } = fakeClient();
    const view = mount(client, fakeBackend());
    await act(async () => {
      await view.result.current.session.arm();
    });
    expect(view.result.current.session.armed).toBe(true);
    act(() => view.result.current.sync(graph, registry, "live-session"));
    await flush();
    const stream = commands.find((entry) => entry["kind"] === "stream");
    expect(stream).toBeDefined();
    expect(stream?.["samples"]).toEqual([
      0.5, -0.25, 1, 0.5, 0.25,
      0.625, -0.125, 0, 0, 0,
      0.75, -0.5, 0, 1, 0,
    ]);
    expect(view.result.current.diagnostics[0]?.code).toBe("laser.armed");
  });

  it("a dead-man push DISARMS the session — light needs a person to come back", async () => {
    const { client, push } = fakeClient();
    const view = mount(client, fakeBackend());
    await act(async () => {
      await view.result.current.session.arm();
    });
    expect(view.result.current.session.armed).toBe(true);
    act(() => push("no point block for 250 ms — the dead-man blanked, stopped and e-stopped the device"));
    expect(view.result.current.session.armed).toBe(false);
  });
});
