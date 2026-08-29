import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { FrameEvaluationInput } from "../types/frame.ts";
import { createNodeFrameRng, createRng, frameSeed, hashSeed, hashString, nodeSeed, rngForFrame } from "./rng.ts";

/**
 * §V45: every random generator is seeded from the project or node seed, and the same
 * seed with the same frameIndex must produce the same output — in the browser, in a
 * headless Dawn render, and on someone else's machine a year from now.
 */

const frame = (frameIndex: number, randomSeed = 1234): FrameEvaluationInput => ({
  timeSeconds: frameIndex / 60,
  deltaSeconds: 1 / 60,
  frameIndex,
  mode: "fixed-step",
  randomSeed,
});

describe("seeded RNG (§V45)", () => {
  it("never falls back to Math.random or a wall clock", () => {
    const source = readFileSync(fileURLToPath(new URL("./rng.ts", import.meta.url)), "utf8");
    // Comments talk about Math.random precisely to forbid it; only executable code counts.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/Math\.random/);
    expect(code).not.toMatch(/Date\.now|performance\.now/);
  });

  it("produces the same sequence for the same seed", () => {
    const a = createRng(42);
    const b = createRng(42);
    const first = Array.from({ length: 32 }, () => a.nextUint32());
    const second = Array.from({ length: 32 }, () => b.nextUint32());
    expect(first).toEqual(second);
  });

  it("produces a different sequence for a different seed", () => {
    const a = Array.from({ length: 8 }, createRng(1).nextUint32);
    const b = Array.from({ length: 8 }, createRng(2).nextUint32);
    expect(a).not.toEqual(b);
  });

  it("is stable across runs — pinned reference values", () => {
    // Pinned so a refactor of the mixing function cannot silently change every
    // previously rendered frame's noise.
    const rng = createRng(0);
    expect([rng.nextUint32(), rng.nextUint32(), rng.nextUint32()]).toEqual([
      1_684_164_658, 3_653_269_916, 2_939_563_536,
    ]);
  });

  it("returns floats inside [0, 1) and integers inside the requested range", () => {
    const rng = createRng(7);
    for (let i = 0; i < 2000; i += 1) {
      const value = rng.nextFloat();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
      const integer = rng.nextInt(3, 9);
      expect(integer).toBeGreaterThanOrEqual(3);
      expect(integer).toBeLessThan(9);
    }
  });

  it("spreads values across the unit interval instead of clustering", () => {
    const rng = createRng(99);
    const buckets = new Array<number>(10).fill(0);
    for (let i = 0; i < 10_000; i += 1) {
      const bucketIndex = Math.floor(rng.nextFloat() * 10);
      buckets[bucketIndex] = (buckets[bucketIndex] ?? 0) + 1;
    }
    for (const count of buckets) {
      expect(count).toBeGreaterThan(700);
      expect(count).toBeLessThan(1300);
    }
  });

  it("rewinds to the construction seed on reset, so a replay reproduces the run", () => {
    const rng = createRng(5);
    const first = [rng.nextUint32(), rng.nextUint32()];
    rng.reset();
    expect([rng.nextUint32(), rng.nextUint32()]).toEqual(first);
  });

  it("forks independent sub-streams from one seed", () => {
    const parent = createRng(11);
    const a = parent.fork("uv").nextUint32();
    const b = parent.fork("offset").nextUint32();
    expect(a).not.toBe(b);
    // Forking is pure: same salt, same stream, regardless of parent consumption.
    const parentAfterUse = createRng(11);
    parentAfterUse.nextUint32();
    expect(parentAfterUse.fork("uv").nextUint32()).toBe(a);
  });
});

describe("project seed + node seed + frameIndex (§V45)", () => {
  it("gives the same output for the same seed and frame", () => {
    const first = createNodeFrameRng({ projectSeed: 2026, nodeId: "noise-1", frameIndex: 120 });
    const second = createNodeFrameRng({ projectSeed: 2026, nodeId: "noise-1", frameIndex: 120 });
    expect(Array.from({ length: 8 }, first.nextFloat)).toEqual(Array.from({ length: 8 }, second.nextFloat));
  });

  it("gives different output for a different frame, node, or project seed", () => {
    const base = createNodeFrameRng({ projectSeed: 1, nodeId: "n", frameIndex: 10 }).nextUint32();
    expect(createNodeFrameRng({ projectSeed: 1, nodeId: "n", frameIndex: 11 }).nextUint32()).not.toBe(base);
    expect(createNodeFrameRng({ projectSeed: 1, nodeId: "m", frameIndex: 10 }).nextUint32()).not.toBe(base);
    expect(createNodeFrameRng({ projectSeed: 2, nodeId: "n", frameIndex: 10 }).nextUint32()).not.toBe(base);
  });

  it("supports random access: frame 900 is reproducible without evaluating 0..899", () => {
    const direct = createNodeFrameRng({ projectSeed: 7, nodeId: "sim", frameIndex: 900 }).nextUint32();
    let sequential = 0;
    for (let index = 0; index <= 900; index += 1) {
      sequential = createNodeFrameRng({ projectSeed: 7, nodeId: "sim", frameIndex: index }).nextUint32();
    }
    expect(sequential).toBe(direct);
  });

  it("derives the same stream from a FrameEvaluationInput as from its parts", () => {
    const fromFrame = rngForFrame(frame(33, 4242), "node-x").nextUint32();
    const fromParts = createNodeFrameRng({ projectSeed: 4242, nodeId: "node-x", frameIndex: 33 }).nextUint32();
    expect(fromFrame).toBe(fromParts);
  });

  it("separates salted streams inside one node on one frame", () => {
    const a = rngForFrame(frame(1), "node", "jitter").nextUint32();
    const b = rngForFrame(frame(1), "node", "colour").nextUint32();
    const unsalted = rngForFrame(frame(1), "node").nextUint32();
    expect(new Set([a, b, unsalted]).size).toBe(3);
  });

  it("hashes deterministically and order-sensitively", () => {
    expect(hashString("abc")).toBe(hashString("abc"));
    expect(hashString("abc")).not.toBe(hashString("acb"));
    expect(hashSeed(1, 2)).not.toBe(hashSeed(2, 1));
    expect(hashSeed(1, "a")).toBe(hashSeed(1, "a"));
    expect(nodeSeed(1, "n")).toBe(nodeSeed(1, "n"));
    expect(frameSeed(nodeSeed(1, "n"), 3)).toBe(frameSeed(nodeSeed(1, "n"), 3));
  });

  it("distinguishes non-integer seeds", () => {
    expect(hashSeed(0.1)).not.toBe(hashSeed(0.2));
    expect(createRng(hashSeed(0.1)).nextUint32()).not.toBe(createRng(hashSeed(0.2)).nextUint32());
  });

  it("keeps every value a real uint32", () => {
    const rng = createRng(123456);
    for (let i = 0; i < 500; i += 1) {
      const value = rng.nextUint32();
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(0xffff_ffff);
    }
  });
});
