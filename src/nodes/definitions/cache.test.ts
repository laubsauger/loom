import { describe, expect, it } from "vitest";

import { scratchResourceId } from "../../compiler/resources.ts";
import { estimateResourceBytes } from "../../runtime/backend/plan.ts";
import { createNodeRegistry, validateNodeDefinition } from "../registry/registry.ts";
import {
  CACHE_DEFAULT_FRAMES,
  CACHE_DEFAULT_SCALE,
  CACHE_RING_KEY,
  cacheNode,
} from "./cache.ts";
import { compileContext, inputResourceId, outputResourceId } from "./test-support.ts";
import type { ParameterValue } from "../../domain/types/parameters.ts";

/** Cache — N frames held, one read back (T237). */

function compiled(parameters: Readonly<Record<string, ParameterValue>> = {}) {
  return cacheNode.compile(compileContext({ inputs: ["input"], parameters }));
}

function passes(parameters: Readonly<Record<string, ParameterValue>> = {}) {
  return compiled(parameters).passes as ReadonlyArray<{
    id: string;
    target: string;
    textures?: ReadonlyArray<{ binding: string; resourceId: string; array?: boolean }>;
    uniforms?: { tap?: number };
    uniformBinding?: string;
  }>;
}

describe("Cache (T237)", () => {
  it("registers with no manifest diagnostics", () => {
    expect(validateNodeDefinition(cacheNode)).toEqual([]);
    expect(createNodeRegistry([cacheNode]).list().map((d) => d.type)).toEqual(["cache"]);
  });

  it("writes into the ring and reads a TAP out of it", () => {
    // The shape of the node: one pass fills the slice this frame owns, the other binds a
    // slice `index` frames back. Both name the same ring resource — the difference is the
    // tap, which is what makes the ring one resource instead of N.
    const ring = scratchResourceId("n1", CACHE_RING_KEY);
    const [write, read] = passes({ index: 3 });

    expect(write?.target).toBe(ring);
    expect(write?.textures).toEqual([
      { binding: "inputTexture", resourceId: inputResourceId("input") },
    ]);

    expect(read?.target).toBe(outputResourceId("out"));
    // T425: the ring binds as ONE stable ARRAY view and the tap rides the uniform block
    // — a per-layer view would rebuild the pass's bind group every rotation, which the
    // settled-frame allocation gate refuses (found the day a cache entered an example).
    // B160: the second binding is the ring's WRITE TARGET — what an empty history
    // reads, so frame 0 passes the input through instead of flashing black (§V229).
    expect(read?.textures).toEqual([
      { binding: "ringTexture", resourceId: ring, array: true },
      { binding: "liveTexture", resourceId: ring, live: true },
    ]);
    expect(read?.uniforms).toEqual({ tap: 3, ringLatest: 0, ringWritten: 0, ringFrames: 8 });
    expect(read?.uniformBinding).toBe("cacheTap");
  });

  it("never taps the slice it is writing", () => {
    // Tap 0 would be a read of the texture the write pass is still filling — the hazard a
    // ping-pong's read/write split exists to prevent, and the reason the plan reader
    // refuses a tap below 1 rather than trusting each node to remember.
    const taps = [0, -4, 1].map(
      (index) => (passes({ index }).at(1)?.uniforms as { tap?: number } | undefined)?.tap,
    );
    expect(taps).toEqual([1, 1, 1]);
  });

  it("clamps a tap deeper than the ring and SAYS so", () => {
    // Silently wrapping would make a 12-frame delay look like an 8-frame delay, which is
    // indistinguishable from the node being broken. Clamping without saying so is the
    // same bug with better manners.
    const result = compiled({ frames: 8, index: 12 });
    expect((result.passes as ReadonlyArray<{ uniforms?: { tap?: number } }>)[1]?.uniforms?.tap).toBe(7);
    expect(result.diagnostics?.[0]?.code).toBe("node.compile.tapClamped");
    expect(result.diagnostics?.[0]?.severity).toBe("warning");
    expect(result.diagnostics?.[0]?.suggestion).toMatch(/Raise Frames/);
  });

  it("declares a ring, not N targets", () => {
    // §V227: the alternative — N targets shifted along by copies — costs N full-frame
    // copies per FRAME, roughly a gigabyte per frame of write bandwidth at 60 slices of
    // 1080p. The ring rotates an integer instead. One scratch entry is what that
    // difference looks like from here.
    expect(compiled({ frames: 12, scale: 0.25 }).scratch).toEqual([
      { key: CACHE_RING_KEY, kind: "ring", frames: 12, scale: 0.25 },
    ]);
  });

  it("defaults to eight half-scale frames, which is ~32 MiB at 1080p (§V228)", () => {
    // The trap this default exists to avoid: 60 frames at full scale is 949 MiB — 93% of
    // the default project budget — from dropping ONE node. When the cost IS the
    // parameter, the default has to be the cheap end and the arithmetic has to be
    // visible. Asserted as bytes rather than as two numbers, because the bytes are the
    // thing that matters and `estimateResourceBytes` is what reports them.
    expect(CACHE_DEFAULT_FRAMES).toBe(8);
    expect(CACHE_DEFAULT_SCALE).toBe(0.5);

    const half: readonly [number, number] = [1920 * CACHE_DEFAULT_SCALE, 1080 * CACHE_DEFAULT_SCALE];
    const bytes = estimateResourceBytes([
      {
        kind: "ring",
        id: "ring",
        size: half,
        format: "rgba16float",
        frames: CACHE_DEFAULT_FRAMES,
      },
    ]);
    expect(bytes / (1024 * 1024)).toBeCloseTo(31.6, 1);
  });

  it("makes the tap structural, so changing it recompiles", () => {
    // The honest limit of the fixed-tap design: `index` chooses which slice the read pass
    // BINDS, so it cannot move without a rebuild. Right for a delay of n frames, wrong for
    // animating time — which is T321's job and needs a texture-array binding this
    // deliberately does not have. The pass id carries the tap so the structure key differs.
    expect(passes({ index: 1 })[1]?.id).not.toBe(passes({ index: 2 })[1]?.id);
    const parameter = cacheNode.parameters["index"];
    expect(parameter?.compileTime).toBe(true);
  });

  it("declares its state and exposes a reset that reaches it (§V46, §V123)", () => {
    // A node holding seconds of pixels is stateful, and a stateful node that cannot be
    // cleared is one you have to delete to reset. The pulse fires the scoped reset command
    // — which resolves ring resources as well as feedback pairs, or this would be a button
    // that lies.
    expect(cacheNode.stateful).toEqual({
      reset: true,
      deterministicReplay: true,
      checkpoint: false,
      randomAccess: false,
    });
    const pulse = cacheNode.parameters["resetPulse"];
    expect(pulse?.type).toBe("pulse");
    expect(pulse?.type === "pulse" ? pulse.fires : undefined).toBe("runtime.resetFeedback");
  });

  it("reports rather than emitting passes when nothing is wired", () => {
    const bare = cacheNode.compile(compileContext({ inputs: [] }));
    expect(bare.passes).toEqual([]);
    expect(bare.diagnostics?.[0]?.message).toContain('input port "input"');
  });
});
