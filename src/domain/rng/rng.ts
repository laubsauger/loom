import type { FrameEvaluationInput } from "../types/frame.ts";

/**
 * Deterministic seeded randomness (§V45, T65).
 *
 * `Math.random` is forbidden anywhere in the graph: the same project seed, node seed
 * and `frameIndex` must produce the same stream on any machine, in any run, in the
 * browser and in a headless offline render (§V47). Everything here is a pure integer
 * hash — splitmix32 for the stream, FNV-1a for string keys.
 */

const UINT32 = 0x1_0000_0000;

/** splitmix32 finaliser. Pure, branchless, well-distributed avalanche. */
function splitmix32(state: number): number {
  let t = (state + 0x9e37_79b9) | 0;
  t = Math.imul(t ^ (t >>> 16), 0x21f0_aaad);
  t = Math.imul(t ^ (t >>> 15), 0x735a_2d97);
  return (t ^ (t >>> 15)) >>> 0;
}

/** FNV-1a over UTF-16 code units. Stable for a given string, ∀ platforms. */
export function hashString(value: string): number {
  let hash = 0x811c_9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x0100_0193);
  }
  return hash >>> 0;
}

/**
 * Folds any number of seed components into one uint32. Order matters, so
 * `hashSeed(a, b) !== hashSeed(b, a)` and distinct components never collide by
 * accident of addition.
 */
export function hashSeed(...parts: ReadonlyArray<number | string>): number {
  let acc = 0x9e37_79b9;
  for (const part of parts) {
    const value = typeof part === "string" ? hashString(part) : normaliseNumber(part);
    acc = splitmix32((acc ^ value) | 0);
  }
  return acc >>> 0;
}

/** Non-integers and non-finite values still have to map to a stable uint32. */
function normaliseNumber(value: number): number {
  if (Number.isInteger(value)) return value | 0;
  if (!Number.isFinite(value)) return Number.isNaN(value) ? 0x7fc0_0000 : value > 0 ? 0x7f80_0000 : 0xff80_0000;
  // Reinterpret the float bit pattern so 0.1 and 0.2 give different seeds.
  const buffer = new DataView(new ArrayBuffer(8));
  buffer.setFloat64(0, value);
  return (buffer.getUint32(0) ^ buffer.getUint32(4)) >>> 0;
}

export interface Rng {
  /** The uint32 this stream was constructed from. Two Rngs with equal seeds are equal. */
  readonly seed: number;
  /** Next raw value in [0, 2^32). */
  nextUint32(): number;
  /** Next value in [0, 1). */
  nextFloat(): number;
  /** Next value in [min, max). */
  nextRange(min: number, max: number): number;
  /** Next integer in [minInclusive, maxExclusive). */
  nextInt(minInclusive: number, maxExclusive: number): number;
  /** True with probability `probability` (default 0.5). */
  nextBool(probability?: number): boolean;
  /** Independent sub-stream. Derived purely from this seed plus the salt. */
  fork(salt: number | string): Rng;
  /** Rewinds to the construction seed, so a replay reproduces the run exactly. */
  reset(): void;
}

/** Creates a deterministic stream. Same seed → same sequence, always. */
export function createRng(seed: number): Rng {
  const baseSeed = normaliseNumber(seed) >>> 0;
  let state = baseSeed;

  const rng: Rng = {
    seed: baseSeed,
    nextUint32(): number {
      const value = splitmix32(state);
      state = (state + 0x9e37_79b9) | 0;
      return value;
    },
    nextFloat(): number {
      return rng.nextUint32() / UINT32;
    },
    nextRange(min: number, max: number): number {
      return min + rng.nextFloat() * (max - min);
    },
    nextInt(minInclusive: number, maxExclusive: number): number {
      const span = Math.max(0, Math.floor(maxExclusive) - Math.ceil(minInclusive));
      if (span <= 0) return Math.ceil(minInclusive);
      return Math.ceil(minInclusive) + (rng.nextUint32() % span);
    },
    nextBool(probability = 0.5): boolean {
      return rng.nextFloat() < probability;
    },
    fork(salt: number | string): Rng {
      return createRng(hashSeed(baseSeed, salt));
    },
    reset(): void {
      state = baseSeed;
    },
  };

  return rng;
}

/** Project seed + node identity → that node's stable seed, constant across frames. */
export function nodeSeed(projectSeed: number, nodeId: string, salt?: number | string): number {
  return salt === undefined ? hashSeed(projectSeed, nodeId) : hashSeed(projectSeed, nodeId, salt);
}

/** A node's seed + the frame number → the seed for that node on that frame (§V45). */
export function frameSeed(seedForNode: number, frameIndex: number): number {
  return hashSeed(seedForNode, frameIndex);
}

export interface NodeFrameRngInput {
  projectSeed: number;
  nodeId: string;
  frameIndex: number;
  /** Distinguishes several independent streams inside one node on one frame. */
  salt?: number | string;
}

/**
 * The stream a node should use on a given frame. Random access by construction:
 * frame 900 is reproducible without evaluating frames 0..899 (§V46 randomAccess).
 */
export function createNodeFrameRng(input: NodeFrameRngInput): Rng {
  const base = input.salt === undefined
    ? nodeSeed(input.projectSeed, input.nodeId)
    : nodeSeed(input.projectSeed, input.nodeId, input.salt);
  return createRng(frameSeed(base, input.frameIndex));
}

/**
 * Convenience for node evaluation: the frame input already carries the project seed
 * and frame index, so a node never needs to reach for a clock or a global (§V44).
 *
 * TIMELINE-ANCHORED, DELIBERATELY (T515, §V453/§V436). The stream keys on
 * `frame.frameIndex` — the wrapping timeline reading — so the same timeline position
 * always deals the same values: a scrub reproduces, an offline render reproduces, and
 * a LAP REPEATS the sequence. That repeat is the contract, not an oversight, and the
 * test suite pins it. A caller who wants fresh values on every lap — a fire that must
 * not re-burn identically each loop — should key `createNodeFrameRng` on
 * `absFrameIndexOf(frame)` instead, and say "free-running" where they do it. No
 * caller exists today; this note is here so the FIRST one inherits a decision instead
 * of a default.
 */
export function rngForFrame(frame: FrameEvaluationInput, nodeId: string, salt?: number | string): Rng {
  return createNodeFrameRng(
    salt === undefined
      ? { projectSeed: frame.randomSeed, nodeId, frameIndex: frame.frameIndex }
      : { projectSeed: frame.randomSeed, nodeId, frameIndex: frame.frameIndex, salt },
  );
}
