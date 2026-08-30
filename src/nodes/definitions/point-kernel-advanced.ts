import type { CompiledNodeDescription, NodeDefinition, ScratchRequest } from "../../domain/types/node-definition.ts";
import type { DispatchPassDescriptor } from "../../runtime/backend/plan.ts";
import type { PointAttributeSchema } from "../../points/attributes.ts";
import { ATTRIBUTE_STRIDES } from "../../points/attributes.ts";
import { ADVANCED_KERNEL_CONTRACT_VERSION, generateKernelModule } from "../../points/codegen.ts";
import {
  SCAN_WORKGROUP_SIZE,
  blockCount,
  clearDeadTailWgsl,
  generateCompactionModule,
} from "../../points/lifecycle.ts";
import { DEFAULT_POINT_KERNEL } from "../shaders/points.wgsl.ts";
import { readCompileInputs } from "./compile-context.ts";
import { readNumber } from "./parameter-readers.ts";
import { parseAttributes, pointPairId } from "./points.ts";

/**
 * The ADVANCED kernel (T322): a per-point kernel that may CHANGE COUNTS — the second
 * kernel node of the T302 split, shaped by TD deprecating its combined Create POP.
 * v1 kills; spawning is T323, with its own emitter vocabulary.
 *
 * The whole lifecycle is deterministic scan compaction (T119/T120, §V74 — never
 * atomics), wired at last: the kernel writes an auto-injected `alive: u32` flag
 * (`q.alive = 0u` kills), a glue pass zeroes the stale tail the guarded kernel never
 * touched, the scan counts survivors into a GPU-resident live count, and scatter packs
 * every attribute — ids riding along, identity never slot-keyed (§V73).
 *
 * THE INVERSION (§V231): scatter cannot land in the half the kernel just wrote (that
 * is its input), so compacted data lands in the READ half, the pairs declare
 * `swap: false`, and the edge map names `half: "read"` — consumers bind what the
 * payload says and cannot tell this producer from an ordinary one. The live count
 * travels as `count: { buffer }`; capacity stays the allocation bound.
 */

const ALIVE = "alive";

function withAlive(attributes: ReadonlyArray<PointAttributeSchema>): ReadonlyArray<PointAttributeSchema> {
  return [...attributes, { name: ALIVE, type: "u32", default: [1] }];
}

export function liveCountBufferId(nodeId: string): string {
  return pointPairId(nodeId, "liveCount");
}

export const pointKernelAdvancedNode: NodeDefinition = {
  type: "pointKernelAdvanced",
  version: 1,
  title: "Point Kernel (Advanced)",
  category: "points",
  description:
    "A per-point kernel that may kill points — survivors are compacted deterministically and the live count stays on the GPU.",
  tags: ["points", "particles", "compute", "kernel", "lifecycle", "advanced"],
  inputs: [],
  outputs: [
    {
      id: "out",
      label: "Out",
      type: { kind: "pointset", requires: [{ name: "position", type: "vec3f" }] },
    },
  ],
  parameters: {
    capacity: {
      type: "number",
      label: "Capacity",
      default: 4096,
      min: 1,
      max: 1_000_000,
      step: 1,
      compileTime: true,
      description: "Allocation bound. The live count only ever shrinks from here (v1 kills; spawn is T323).",
    },
    seed: { type: "number", label: "Seed", default: 7, step: 1 },
    attributes: {
      type: "string",
      label: "Attributes",
      default: "",
      multiline: true,
      compileTime: true,
      description:
        'JSON schema, e.g. [{"name":"position","type":"vec3f","semantic":"position","default":[0,0,0]}]. Empty = position/velocity/id. "alive" is injected.',
    },
    kernel: {
      type: "string",
      label: "Kernel",
      default: DEFAULT_POINT_KERNEL,
      multiline: true,
      compileTime: true,
      description: "fn process(p: Point, ctx: PointCtx) -> Point. Set q.alive = 0u to kill. pointRand(pointId, salt) is available.",
    },
  },
  stateful: { reset: true, deterministicReplay: true, checkpoint: false, randomAccess: false },
  contractVersion: ADVANCED_KERNEL_CONTRACT_VERSION,
  compile(context): CompiledNodeDescription {
    const { nodeId, parameters } = readCompileInputs(context);
    const capacity = Math.max(1, Math.round(readNumber(parameters, "capacity", 4096)));

    const parsed = parseAttributes(parameters["attributes"]);
    if (parsed.attributes === undefined) {
      return {
        passes: [],
        diagnostics: [
          { severity: "error", code: "node.points.attributes", message: `Node "${nodeId}": ${parsed.error}`, nodeId },
        ],
      };
    }
    if (parsed.attributes.some((attribute) => attribute.name === ALIVE)) {
      return {
        passes: [],
        diagnostics: [
          {
            severity: "error",
            code: "node.points.attributes",
            message: `Node "${nodeId}": "${ALIVE}" is the injected lifecycle flag; the schema must not declare it.`,
            nodeId,
          },
        ],
      };
    }
    const attributes = withAlive(parsed.attributes);
    // Baseline WebGPU allows 8 storage buffers per stage (§V24). The kernel binds an
    // in/out pair per attribute, the alive flag out-only, and the live count:
    // 2·(n−1) + 1 + 1. Beyond that the pipeline FAILS — refuse loudly instead.
    const storageBindings = (attributes.length - 1) * 2 + 2;
    if (storageBindings > 8) {
      return {
        passes: [],
        diagnostics: [
          {
            severity: "error",
            code: "node.points.attributes",
            message: `Node "${nodeId}": ${parsed.attributes.length} attributes need ${storageBindings} storage bindings; the baseline limit is 8. The advanced kernel fits at most 3 attributes.`,
            nodeId,
          },
        ],
      };
    }

    const kernelSource = typeof parameters["kernel"] === "string" ? parameters["kernel"] : DEFAULT_POINT_KERNEL;
    const names = attributes.map((attribute) => attribute.name);
    const module = generateKernelModule({
      attributes,
      reads: names,
      writes: names,
      kernel: kernelSource,
      lifecycle: { aliveAttribute: ALIVE },
    });
    if (!module.ok) {
      return {
        passes: [],
        diagnostics: module.errors.map((message) => ({
          severity: "error" as const,
          code: "node.points.kernel",
          message: `Node "${nodeId}": ${message}`,
          nodeId,
        })),
      };
    }

    const compaction = generateCompactionModule(attributes, capacity);
    if (!compaction.ok) {
      return {
        passes: [],
        diagnostics: compaction.errors.map((message) => ({
          severity: "error" as const,
          code: "node.points.lifecycle",
          message: `Node "${nodeId}": ${message}`,
          nodeId,
        })),
      };
    }

    const liveCount = liveCountBufferId(nodeId);
    const scanned = pointPairId(nodeId, "scanned");
    const blockSums = pointPairId(nodeId, "blockSums");
    const alivePair = pointPairId(nodeId, ALIVE);
    const frameUniforms = { timeSeconds: 0, deltaSeconds: 0, frameIndex: 0 };

    const passes: DispatchPassDescriptor[] = [
      {
        kind: "dispatch",
        id: `${nodeId}:kernel`,
        shader: module.wgsl,
        entryPoint: "main",
        workgroups: [Math.ceil(capacity / module.workgroupSize), 1, 1],
        buffers: module.buffers.map((binding) =>
          binding.role === "live"
            ? { binding: binding.variable, resourceId: liveCount }
            : {
                binding: binding.variable,
                resourceId: pointPairId(nodeId, binding.attribute),
                half: binding.role === "in" ? ("read" as const) : ("write" as const),
              },
        ),
        uniforms: { ...frameUniforms, seed: readNumber(parameters, "seed", 7), count: capacity },
        uniformBinding: "kernelFrame",
        nodeId,
      },
      {
        kind: "dispatch",
        id: `${nodeId}:clearDeadTail`,
        shader: clearDeadTailWgsl(),
        entryPoint: "main",
        workgroups: [Math.ceil(capacity / SCAN_WORKGROUP_SIZE), 1, 1],
        buffers: [
          { binding: "liveCount", resourceId: liveCount },
          { binding: "aliveFlags", resourceId: alivePair, half: "write" },
        ],
        uniforms: { ...frameUniforms, capacity },
        uniformBinding: "params",
        nodeId,
      },
      ...compaction.passes.map(
        (pass): DispatchPassDescriptor => ({
          kind: "dispatch",
          id: `${nodeId}:${pass.name}`,
          shader: pass.wgsl,
          entryPoint: pass.entryPoint,
          workgroups:
            pass.dispatch === "single" ? [1, 1, 1] : [Math.ceil(capacity / SCAN_WORKGROUP_SIZE), 1, 1],
          buffers: pass.bindings.map((binding) => {
            // flags = the alive attribute's post-kernel WRITE half; scan scratch by
            // name; scatter's in_* reads write halves, out_* lands in READ halves —
            // the §V231 inversion, contained entirely inside this pass list.
            if (binding.name === "flags") return { binding: "flags", resourceId: alivePair, half: "write" as const };
            if (binding.name === "scanned") return { binding: "scanned", resourceId: scanned };
            if (binding.name === "blockSums") return { binding: "blockSums", resourceId: blockSums };
            if (binding.name === "aliveCount") return { binding: "aliveCount", resourceId: liveCount };
            const attribute = binding.name.replace(/^(in|out)_/, "");
            return {
              binding: binding.name,
              resourceId: pointPairId(nodeId, attribute),
              half: binding.name.startsWith("in_") ? ("write" as const) : ("read" as const),
            };
          }),
          uniforms: { capacity },
          uniformBinding: "params",
          nodeId,
        }),
      ),
    ];

    const scratch: ScratchRequest[] = [
      ...attributes.map((attribute) => ({
        kind: "bufferPair" as const,
        key: attribute.name,
        stride: ATTRIBUTE_STRIDES[attribute.type],
        capacity,
        // §V231: compaction lands this frame's data in the READ half; a swap would
        // hand next frame the stale half.
        swap: false,
      })),
      { kind: "buffer", key: "liveCount", stride: 4, capacity: 1 },
      { kind: "buffer", key: "scanned", stride: 4, capacity },
      { kind: "buffer", key: "blockSums", stride: 4, capacity: blockCount(capacity) },
    ];

    return {
      passes,
      scratch,
      pointsets: {
        out: {
          // Consumers bind READ halves: that is where scatter left this frame's
          // survivors. The payload says so; nobody downstream has to know why.
          pairs: Object.fromEntries(
            attributes
              .filter((attribute) => attribute.name !== ALIVE)
              .map((attribute) => [
                attribute.name,
                { pair: pointPairId(nodeId, attribute.name), half: "read" as const },
              ]),
          ),
          capacity,
          topology: "points",
          count: { buffer: liveCount },
        },
      },
    };
  },
};
