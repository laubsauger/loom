import { describe, expect, it } from "vitest";
import { wgsl } from "./wgsl.ts";

/**
 * T1335b — THE INVALIDATION, WHICH IS THE HALF A TYPE CANNOT CARRY.
 *
 * The brand guarantees shader text came from a cache. It guarantees nothing about that cache
 * being RIGHT, and a wrong one has the worst failure shape there is: a stale shader renders
 * the previous picture perfectly and every assertion about it passes. §V968's rule applies
 * exactly — the known positive worth testing is the INVALIDATION, not the hit.
 *
 * ⚑ AND THE HIT CANNOT BE TESTED FROM OUT HERE, WHICH IS WORTH STATING RATHER THAN FAKING.
 * A string is a primitive: `Object.is` on two equal strings is true whether the second came
 * from the cache or from a rebuild, so an identity assertion would be green under a cache
 * that never caches. (Two of the assertions in the first draft of this file claimed exactly
 * that and were deleted when they failed for that reason — the test was wrong, not the
 * code.) What the cache actually bought is measured where it is visible: in the production
 * CPU profile, where `src/points/codegen.ts` went from 39.4% of script to 1.2% (§T1333b).
 * These claims are about CORRECTNESS under change, and `wgsl-invalidation.gpu.test.ts`
 * carries the same one through the real stack in pixels.
 *
 * Red-verified by pinning the key: collapse the trie walk in `wgsl` to one node per call
 * site — ignoring the interpolated values, which is the plausible bug — and every claim
 * below goes red on the second distinct value.
 */

function emit(value: string | number): string {
  return wgsl`fn main() { let k = ${value}; }`;
}

describe("T1335b — emitted WGSL is keyed by call site AND by every value", () => {
  it("gives DIFFERENT text when an interpolated value changes", () => {
    expect(emit(1)).toBe("fn main() { let k = 1; }");
    expect(emit(2)).toBe("fn main() { let k = 2; }");
  });

  it("gives the FIRST text back after a second value has been through — a cache that overwrote would not", () => {
    emit(1);
    emit(2);
    expect(emit(1)).toBe("fn main() { let k = 1; }");
  });

  it("keys on EVERY value, not just the first", () => {
    const two = (a: number, b: number): string => wgsl`${a}:${b}`;
    expect(two(1, 1)).toBe("1:1");
    expect(two(1, 2)).toBe("1:2");
    expect(two(2, 1)).toBe("2:1");
    expect(two(1, 1)).toBe("1:1");
  });

  it("keeps two call sites apart even when one has been evaluated and the other has not", () => {
    const here = wgsl`site A`;
    const there = wgsl`site B`;
    expect(here).toBe("site A");
    expect(there).toBe("site B");
  });

  it("stays correct after a site has been interpolated with far more values than it can hold", () => {
    // The per-site cap is 64. Eviction may drop any of these; correctness may not depend on
    // which, so the claim is that the TEXT is still right on both sides of the cap.
    for (let index = 0; index < 300; index += 1) emit(index);
    expect(emit(299)).toBe("fn main() { let k = 299; }");
    expect(emit(0)).toBe("fn main() { let k = 0; }");
  });
});
