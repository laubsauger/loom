// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DEVICE_HELPER_COMMAND } from "@devices/helper.ts";

import type { GraphDocument } from "../domain/types/graph.ts";
import type { CompiledGraph } from "../compiler/index.ts";
import type { DeviceClient } from "@devices/device-client.ts";
import type { VisionOutcome } from "@devices/device-protocol.ts";
import type { LoomBackend } from "../runtime/backend/index.ts";
import {
  maskCoverage,
  maskToFloats,
  texelsToRgbaBase64,
  useVisionBridge,
} from "./use-vision-bridge.ts";

/**
 * T1029 — the Person Mask CPU half, per path and by mechanism (the laser pump's
 * discipline applied to a reader): the no-helper path is asserted behaviourally
 * (nothing crosses, the diagnostic says what to do), the ONE firing path is asserted
 * to the exact bytes on the wire AND the exact floats published back, and §V856's
 * coverage scalar is pinned so "found nobody" can never again be confused with
 * "did not run".
 */

describe("T1029 — the pure halves, exact", () => {
  it("texels cross as clamped RGBA8, base64 — the wire's own shape", () => {
    // 0.5 → 128 (round), out-of-range clamps, NaN-free by construction upstream (G4's
    // cousin lives in the preprocess; this is just the byte conversion).
    const texels = new Float32Array([0, 1, 0.5, 2, -1, 0.25, 1, 1]);
    const decoded = Uint8Array.from(atob(texelsToRgbaBase64(texels)), (c) => c.charCodeAt(0));
    expect([...decoded]).toEqual([0, 255, 128, 255, 0, 64, 255, 255]);
  });

  it("maskToFloats undoes the letterbox: only the centred band maps onto the picture", () => {
    // A 4×4 mask for a 2:1 picture: the picture occupies the middle 4×2 band. Rows 0
    // and 3 are letterbox padding and must never reach the output.
    const mask = new Uint8Array([
      9, 9, 9, 9,
      255, 0, 255, 0,
      0, 255, 0, 255,
      9, 9, 9, 9,
    ]);
    const out = maskToFloats(mask, 4, 4, 4, 2);
    expect([...out]).toEqual([1, 0, 1, 0, 0, 1, 0, 1]);
  });

  it("coverage counts the confident fraction from the result's own bytes (§V856)", () => {
    const floats = new Float32Array([0, 0.4, 0.6, 1]);
    const bytes = new Uint8Array(floats.buffer);
    expect(maskCoverage(bytes)).toBe(0.5);
    expect(maskCoverage(new Uint8Array(new Float32Array(4).buffer))).toBe(0);
  });
});

/* ------------------------------------------------------------------ the hook */

const graph = {
  revision: 1,
  nodes: {
    mask: { id: "mask", type: "personMask", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {}, label: "mask1" },
  },
  edges: {},
  groups: {},
} as unknown as GraphDocument;

/** The plan allocated the node: result external sized 4×2, input buffer present. */
const compiled = {
  resources: [
    { id: "scratch:mask:modelResult", size: [4, 2] },
    { id: "scratch:mask:modelInput", size: [512, 512] },
  ],
} as unknown as CompiledGraph;

function fakeClient(outcome: VisionOutcome) {
  const requests: Array<{ width: number; height: number; rgbaBase64: string }> = [];
  const client = {
    vision: (request: { width: number; height: number; rgbaBase64: string }) => {
      requests.push(request);
      return Promise.resolve(outcome);
    },
  } as unknown as DeviceClient;
  return { client, requests };
}

function fakeBackend(texels: Float32Array) {
  const registered = new Map<string, { currentFrame(): { frameId: number; bytes: Uint8Array } | undefined }>();
  const backend = {
    readBuffer: () => Promise.resolve(texels.buffer),
    registerMediaSource: (id: string, source: never) => {
      registered.set(id, source);
      return () => registered.delete(id);
    },
  } as unknown as LoomBackend;
  return { backend, registered };
}

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

const frame = { frameIndex: 1, timeSeconds: 0.1, deltaSeconds: 1 / 60, mode: "realtime", randomSeed: 7 } as never;

describe("T1029 — the hook, per path", () => {
  it("NO HELPER: a WARNING at the node, coverage READS ZERO, and nothing ever crosses (T1067)", async () => {
    const { backend } = fakeBackend(new Float32Array(4));
    const view = renderHook(() =>
      useVisionBridge({ deviceClient: () => null, backend: () => backend }),
    );
    act(() => view.result.current.track(graph, compiled));
    // WARNING, so the node's own badge lights: info reached only the problems pane and
    // the owner met a silently black node (the shipped E52 report, verbatim).
    expect(view.result.current.diagnostics[0]?.severity).toBe("warning");
    expect(view.result.current.diagnostics[0]?.code).toBe("vision.helper.absent");
    expect(view.result.current.diagnostics[0]?.message).toContain(DEVICE_HELPER_COMMAND);
    /* THE SHIPPED FAILURE: E52 spends `mask1:coverage`, and with no helper this hook
       tracked the entry but never joined the channel chain — so the expression FAILED
       ("publishes no channel") instead of dimming the room. The channel must exist
       whenever the NODE exists: zero, with the distinction carried by the warning. */
    expect(view.result.current.resolver("mask1:coverage", { frame } as never)).toBe(0);
    // And BEFORE any track at all (the first structural compile's world): the channel
    // belongs to the NODE, answered from the live document, or the first compile pins
    // an expression error nothing later clears — the shipped E52 failure exactly.
    const cold = renderHook(() =>
      useVisionBridge({ deviceClient: () => null, graph: () => graph }),
    );
    expect(cold.result.current.resolver("mask1:coverage", { frame } as never)).toBe(0);
    expect(cold.result.current.resolver("depth1:coverage", { frame } as never)).toBeUndefined();
    // The typo protection survives: a channel nothing publishes still refuses by name.
    expect(view.result.current.resolver("mask1:nonsense", { frame } as never)).toBeUndefined();
    await flush();
  });

  it("THE FIRING PATH: planner bytes cross exactly, the mask comes back as exact floats, coverage separates found-nobody from did-not-run", async () => {
    // Two lit texels then zeros: the wire must carry round(v*255) of exactly these.
    const texels = new Float32Array(512 * 512 * 4);
    texels[0] = 1;
    texels[1] = 0.5;
    // A 4×4 mask, fully confident top-left quadrant of the centred band.
    const mask = new Uint8Array([9, 9, 9, 9, 255, 255, 0, 0, 0, 0, 0, 0, 9, 9, 9, 9]);
    const { client, requests } = fakeClient({
      ok: true,
      maskWidth: 4,
      maskHeight: 4,
      maskBase64: btoa(String.fromCharCode(...mask)),
      millis: 21,
    });
    const { backend, registered } = fakeBackend(texels);
    const view = renderHook(() =>
      useVisionBridge({ deviceClient: () => client, backend: () => backend }),
    );
    act(() => view.result.current.track(graph, compiled));
    act(() => view.result.current.observe(frame));
    await flush();
    await flush();

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ width: 512, height: 512 });
    const sent = Uint8Array.from(atob(requests[0]!.rgbaBase64), (c) => c.charCodeAt(0));
    expect(sent[0]).toBe(255);
    expect(sent[1]).toBe(128);
    expect(sent[2]).toBe(0);

    // The published frame: the media source the node's external texture uploads from,
    // at the OUTPUT size (4×2), letterbox undone — band rows 1..2 of the mask.
    const source = registered.get("infer:mask");
    expect(source).toBeDefined();
    const published = source!.currentFrame();
    expect(published).toBeDefined();
    const floats = new Float32Array(published!.bytes.buffer, published!.bytes.byteOffset, 8);
    expect([...floats]).toEqual([1, 1, 0, 0, 0, 0, 0, 0]);
    expect(maskCoverage(published!.bytes)).toBe(0.25);
  });

  it("A DOOR REFUSAL surfaces as the node's own warning on the next track — never a silent zero mask", async () => {
    const { client } = fakeClient({ ok: false, reason: "person segmentation needs Apple's Vision framework, which only exists on macOS" });
    const { backend } = fakeBackend(new Float32Array(512 * 512 * 4));
    const view = renderHook(() =>
      useVisionBridge({ deviceClient: () => client, backend: () => backend }),
    );
    act(() => view.result.current.track(graph, compiled));
    act(() => view.result.current.observe(frame));
    await flush();
    await flush();
    act(() => view.result.current.track(graph, compiled));
    const warning = view.result.current.diagnostics.find((entry) => entry.code === "vision.refused");
    expect(warning?.message).toContain("only exists on macOS");
  });
});
