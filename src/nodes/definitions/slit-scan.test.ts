import { describe, expect, it } from "vitest";

import { slitScanNode } from "./slit-scan.ts";
import { compileContext } from "./test-support.ts";

/** SlitScan at the fixture level (T321). The pixels live in slit-scan.gpu.test.ts. */
describe("slitScan — manifest and emission (T321)", () => {
  it("records into its ring and reads it back as a WHOLE-ARRAY binding", () => {
    const result = slitScanNode.compile(
      compileContext({ nodeId: "slit", inputs: ["input", "map"], parameters: { frames: 24, depth: 0.5 } }),
    );
    expect(result.diagnostics ?? []).toEqual([]);
    const [record, scan] = result.passes as Array<{
      id: string;
      target: string;
      textures?: Array<{ binding: string; resourceId: string; array?: boolean; tap?: number }>;
      uniforms?: Record<string, number>;
    }>;
    expect(record?.id).toBe("slit:record");
    expect(record?.target).toBe("scratch:slit:history");
    // T321: the array binding — no tap, the fragment picks the layer. T1019a: SAMPLED
    // (no `unfiltered`), Cache's read path — a scaled ring upsamples smoothly, and at
    // scale 1 the sample lands on the exact texel the old load read (the Dawn gate's
    // per-column exactness held unchanged through the switch, which is the proof).
    const history = scan?.textures?.find((binding) => binding.binding === "history");
    expect(history).toEqual({
      binding: "history",
      resourceId: "scratch:slit:history",
      array: true,
    });
    expect(history?.tap).toBeUndefined();
    // The statics keep the block matching its struct; the backend merges the live
    // head per frame.
    expect(scan?.uniforms).toEqual({ depth: 0.5, ringLatest: 0, ringWritten: 0, ringFrames: 24 });
    // T1019a: the ring carries the scale — default 1, so existing documents keep
    // their exact bytes; halving it quarters the memory (the parameter's own line).
    expect(result.scratch).toEqual([{ kind: "ring", key: "history", frames: 24, scale: 1 }]);
  });

  it("declares reset honestly: a pulse wired to the ring, not a listed gap", () => {
    expect(slitScanNode.stateful?.reset).toBe(true);
    const pulse = slitScanNode.parameters["resetPulse"];
    expect(pulse?.type).toBe("pulse");
  });
});
