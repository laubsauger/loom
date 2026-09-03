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
 * ## Two ROW KINDS, because the limits are not all counts (T1076)
 *
 * Every budget here was "how many of X does this pass bind, against a per-stage maximum".
 * `maxStorageBufferBindingSize` is not that shape: it is BYTES PER BINDING, not a count
 * per pass, and jamming it into `count(pass)` would either report a nonsense number or
 * silently pick one binding to speak for all of them. So the table carries two kinds —
 * `count` rows compare one number per pass, `size` rows compare EACH binding's own bytes
 * — and `BindingOverflow` says which unit it is reporting in.
 *
 * It became load-bearing with T1076: point attributes are packed into one storage buffer
 * per producer, so the ceiling stopped being "how many attributes fit in 8 bindings" and
 * became "how many bytes fit in one binding". The schema-level refusal lives where the
 * layout arithmetic is (`points/packing.ts`) and speaks in attributes and capacity; this
 * is the device-aware backstop, and it is the ONLY one that lowers when a real device
 * reports a smaller limit than the baseline.
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
  /** T1076: bytes ONE storage binding may carry — 128 MiB. A size row, not a count row. */
  maxStorageBufferBindingSize: 134_217_728,
});

export interface BindingCountBudget {
  readonly kind: "count";
  /** What the user is being told they have too many of. */
  readonly what: string;
  /** The limit's name in the capability report, which is also its WebGPU spelling. */
  readonly limitKey: string;
  /** How many of this kind the pass binds. */
  readonly count: (pass: PassDescriptor) => number;
  /** How to get under the limit, phrased for this particular kind. */
  readonly remedy: string;
}

/**
 * T1076: a per-BINDING byte budget. Each binding is measured on its own — one oversized
 * buffer is a refusal even where every other binding on the pass is tiny.
 */
export interface BindingSizeBudget {
  readonly kind: "size";
  readonly what: string;
  readonly limitKey: string;
  /** Every binding whose byte size this pass declares, named so the message can say which. */
  readonly sizes: (pass: PassDescriptor) => ReadonlyArray<{ readonly binding: string; readonly bytes: number }>;
  readonly remedy: string;
}

export type BindingBudget = BindingCountBudget | BindingSizeBudget;

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

/**
 * T1076: the bytes a point-attribute binding declares. Only REGION bindings carry a size —
 * a plain whole-buffer binding's bytes live in the resource table, not the pass — so this
 * reports what the plan actually states rather than inventing the rest.
 */
const bufferRegionSizes = (
  pass: PassDescriptor,
): ReadonlyArray<{ binding: string; bytes: number }> =>
  "buffers" in pass
    ? (pass.buffers ?? []).flatMap((binding) =>
        binding.bytes === undefined ? [] : [{ binding: binding.binding, bytes: binding.bytes }],
      )
    : [];

export const BINDING_BUDGETS: ReadonlyArray<BindingBudget> = Object.freeze([
  {
    kind: "count",
    what: "storage buffers",
    limitKey: "maxStorageBuffersPerShaderStage",
    count: (pass) => ("buffers" in pass ? (pass.buffers?.length ?? 0) : 0),
    remedy:
      "Split the work across passes, or shorten the chain feeding it — since T1076 a point kernel spends one storage buffer per PRODUCER it reads from, not one per attribute.",
  },
  {
    kind: "count",
    what: "sampled textures",
    limitKey: "maxSampledTexturesPerShaderStage",
    count: textureCount,
    remedy: "Composite in stages: fold some inputs in an earlier pass and read its result.",
  },
  {
    kind: "count",
    what: "samplers",
    limitKey: "maxSamplersPerShaderStage",
    count: (pass) => ("samplers" in pass ? (pass.samplers?.length ?? 0) : 0),
    remedy: "Reuse one sampler across bindings that want the same filtering.",
  },
  {
    kind: "count",
    what: "uniform buffers",
    limitKey: "maxUniformBuffersPerShaderStage",
    count: uniformCount,
    remedy: "Merge the pass's uniform blocks into one.",
  },
  {
    kind: "size",
    what: "storage buffer",
    limitKey: "maxStorageBufferBindingSize",
    sizes: bufferRegionSizes,
    remedy:
      "Lower the point capacity, or carry fewer attributes — a packed point buffer is (sum of attribute strides) × capacity per half.",
  },
]);

export interface BindingOverflow {
  readonly passId: string;
  readonly nodeId?: string;
  readonly what: string;
  readonly limitKey: string;
  /** What was bound: a COUNT for a count row, a BYTE total for a size row. */
  readonly count: number;
  readonly limit: number;
  /** T1076: which unit `count` and `limit` are in, so the message can say MiB when it should. */
  readonly unit: "count" | "bytes";
  /** T1076: the offending binding's WGSL name, on a size row. */
  readonly binding?: string;
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
      const { limit, discovered } = limitFor(capabilities, budget.limitKey);
      const base = {
        passId: pass.id,
        ...(pass.nodeId === undefined ? {} : { nodeId: pass.nodeId }),
        what: budget.what,
        limitKey: budget.limitKey,
        limit,
        discovered,
        remedy: budget.remedy,
      };
      if (budget.kind === "size") {
        // T1076: EACH binding against the limit — one oversized region is a refusal even
        // where every other binding on the pass is small.
        for (const entry of budget.sizes(pass)) {
          if (entry.bytes <= limit) continue;
          overflows.push({ ...base, count: entry.bytes, unit: "bytes", binding: entry.binding });
        }
        continue;
      }
      const count = budget.count(pass);
      if (count === 0) continue;
      if (count <= limit) continue;
      overflows.push({ ...base, count, unit: "count" });
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
  // T1076: bytes read as MiB. "binds 201326592 bytes; the limit is 134217728" is a number
  // nobody can hold; "192.0 MiB against 128.0 MiB" is a decision someone can make.
  const bytes = overflow.unit === "bytes";
  const ceiling = bytes ? describeMiB(overflow.limit) : String(overflow.limit);
  const source = overflow.discovered
    ? `this device's ${overflow.limitKey} is ${ceiling}`
    : `the WebGPU baseline ${overflow.limitKey} is ${ceiling}, and this device did not report its own`;
  const bound = bytes
    ? `${describeMiB(overflow.count)} to ${overflow.what} "${String(overflow.binding)}"`
    : `${overflow.count} ${overflow.what}`;
  return `Pass "${overflow.passId}" binds ${bound}; ${source}.`;
}

function describeMiB(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MiB`;
}
