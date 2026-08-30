import type { BackendCapabilities } from "../domain/types/backend.ts";
import type { PassDescriptor } from "../runtime/backend/plan.ts";

/**
 * Per-pass binding budgets, checked before a GPU exists (T328, B33, §V24, §V12).
 *
 * ## The failure this refuses
 *
 * Binding nine storage buffers where the device allows eight does not throw. Pipeline
 * creation fails, every dispatch that would have used it silently no-ops, and the plan
 * compiles with zero diagnostics while frames keep "rendering". T327 caught it at
 * runtime with a persistent error net; this catches it at COMPILE, which is what covers
 * the cases that net cannot reach — a headless render, CI, and the user whose device is
 * stricter than the author's. On the author's machine the limit is generous and nothing
 * ever goes wrong.
 *
 * ## Why the whole class, not just storage buffers
 *
 * Storage buffers are what bit us, but the capability report has carried every one of
 * these limits since T13 and NOTHING read any of them except `maxTextureDimension2D`.
 * That is the same disease one layer down: the discovery exists, and no consumer. So
 * this is a table rather than an `if`, and a new binding category is a new row.
 *
 * ## Absent limits fall back to the WebGPU FLOOR, and that is not an assumption
 *
 * §V12 says discover before use. The thing that needs discovering is HEADROOM: every
 * conforming device meets the baseline, so treating the baseline as known is knowledge,
 * while exceeding it without having been told you may is the unsafe act. Falling back to
 * the floor when a report omits a key therefore refuses in exactly the direction §V12
 * wants — and it keeps the check alive for headless runs and test fixtures, which report
 * few limits and are precisely the runs with no GPU to complain later.
 *
 * ## What this deliberately does NOT cover
 *
 * `maxStorageTexturesPerShaderStage` is a real baseline limit (4) and is left out because
 * the plan has no storage-texture binding to count: `TextureBindingDescriptor` describes
 * a sampled texture, and a write-to-texture binding does not exist in the IR yet. Adding
 * a row for it would be counting zero and reporting a guarantee this cannot make. When
 * the binding kind arrives, this is where it is counted.
 */

/**
 * WebGPU's guaranteed minimums — what a conforming device supports without being asked.
 * Used only when the capability report does not name the limit; a report that names it
 * always wins, in both directions (a stricter device lowers the budget).
 */
const BASELINE: Readonly<Record<string, number>> = Object.freeze({
  maxStorageBuffersPerShaderStage: 8,
  maxSampledTexturesPerShaderStage: 16,
  maxSamplersPerShaderStage: 16,
  maxUniformBuffersPerShaderStage: 12,
});

export interface BindingBudget {
  /** What the user is being told they have too many of. */
  readonly what: string;
  /** The limit's name in the capability report, which is also its WebGPU spelling. */
  readonly limitKey: string;
  /** How many of this kind the pass binds. */
  readonly count: (pass: PassDescriptor) => number;
  /** How to get under the limit, phrased for this particular kind. */
  readonly remedy: string;
}

const textureCount = (pass: PassDescriptor): number =>
  "textures" in pass ? (pass.textures?.length ?? 0) : 0;

/**
 * Uniform BLOCKS a pass binds: its own, plus the shared frame block when the shader
 * declares one. Two at most today — counted anyway, because the point of a table is that
 * the next category to grow is already being watched.
 */
const uniformCount = (pass: PassDescriptor): number => {
  const own = "uniformBinding" in pass && pass.uniformBinding !== undefined ? 1 : 0;
  const shared = "sharedBinding" in pass && pass.sharedBinding !== undefined ? 1 : 0;
  return own + shared;
};

export const BINDING_BUDGETS: ReadonlyArray<BindingBudget> = Object.freeze([
  {
    what: "storage buffers",
    limitKey: "maxStorageBuffersPerShaderStage",
    count: (pass) => ("buffers" in pass ? (pass.buffers?.length ?? 0) : 0),
    remedy:
      "Bind fewer attributes, or split the work across passes — a kernel binding an in/out pair per attribute needs 2·(n−1)+2 storage buffers.",
  },
  {
    what: "sampled textures",
    limitKey: "maxSampledTexturesPerShaderStage",
    count: textureCount,
    remedy: "Composite in stages: fold some inputs in an earlier pass and read its result.",
  },
  {
    what: "samplers",
    limitKey: "maxSamplersPerShaderStage",
    count: (pass) => ("samplers" in pass ? (pass.samplers?.length ?? 0) : 0),
    remedy: "Reuse one sampler across bindings that want the same filtering.",
  },
  {
    what: "uniform buffers",
    limitKey: "maxUniformBuffersPerShaderStage",
    count: uniformCount,
    remedy: "Merge the pass's uniform blocks into one.",
  },
]);

export interface BindingOverflow {
  readonly passId: string;
  readonly nodeId?: string;
  readonly what: string;
  readonly limitKey: string;
  readonly count: number;
  readonly limit: number;
  /** True when the number came from the device report rather than the WebGPU floor. */
  readonly discovered: boolean;
  readonly remedy: string;
}

export function limitFor(
  capabilities: Pick<BackendCapabilities, "limits">,
  key: string,
): { limit: number; discovered: boolean } {
  const reported = capabilities.limits[key];
  if (typeof reported === "number" && Number.isFinite(reported) && reported > 0) {
    return { limit: reported, discovered: true };
  }
  return { limit: BASELINE[key] ?? Number.POSITIVE_INFINITY, discovered: false };
}

/** Every pass that binds more of something than the device allows. */
export function bindingOverflows(
  passes: ReadonlyArray<PassDescriptor>,
  capabilities: Pick<BackendCapabilities, "limits">,
): BindingOverflow[] {
  const overflows: BindingOverflow[] = [];
  for (const pass of passes) {
    // A swap and a counter bind nothing a shader stage sees; the budgets are per stage.
    if (pass.kind === "swap" || pass.kind === "counter") continue;
    for (const budget of BINDING_BUDGETS) {
      const count = budget.count(pass);
      if (count === 0) continue;
      const { limit, discovered } = limitFor(capabilities, budget.limitKey);
      if (count <= limit) continue;
      overflows.push({
        passId: pass.id,
        ...(pass.nodeId === undefined ? {} : { nodeId: pass.nodeId }),
        what: budget.what,
        limitKey: budget.limitKey,
        count,
        limit,
        discovered,
        remedy: budget.remedy,
      });
    }
  }
  return overflows;
}

/**
 * The sentence a person reads when they hit one (§V228).
 *
 * It states the budget where it is hit: what was bound, what is allowed, which limit that
 * is, and whether the number came from this device or from the floor every device meets.
 * "Too many storage buffers" would send someone counting bindings by hand in generated
 * WGSL — which is how the advanced kernel's own producer-side refusal is already worded,
 * and it is worth being consistent with it.
 */
export function describeOverflow(overflow: BindingOverflow): string {
  const source = overflow.discovered
    ? `this device's ${overflow.limitKey} is ${overflow.limit}`
    : `the WebGPU baseline ${overflow.limitKey} is ${overflow.limit}, and this device did not report its own`;
  return `Pass "${overflow.passId}" binds ${overflow.count} ${overflow.what}; ${source}.`;
}
