import type { CompiledNodeDescription, NodeDefinition, ScratchRequest } from "../../domain/types/node-definition.ts";
import type { DispatchPassDescriptor } from "../../runtime/backend/plan.ts";
import type { PointAttributeSchema } from "../../points/attributes.ts";
import { ATTRIBUTE_STRIDES } from "../../points/attributes.ts";
import {
  ADVANCED_KERNEL_CONTRACT_VERSION,
  generateKernelModule,
  generateSpawnHookModule,
} from "../../points/codegen.ts";
import {
  SCAN_WORKGROUP_SIZE,
  blockCount,
  clearDeadTailWgsl,
  generateCompactionModule,
  generateSpawnModule,
} from "../../points/lifecycle.ts";
import { DEFAULT_POINT_KERNEL } from "../shaders/points.wgsl.ts";
import { readCompileInputs } from "./compile-context.ts";
import { readNumber } from "./parameter-readers.ts";
import { parseAttributes, pointPairId } from "./points.ts";

/**
 * The ADVANCED kernel (T322/T323): a per-point kernel that may CHANGE COUNTS — the
 * second kernel node of the T302 split, shaped by TD deprecating its combined Create
 * POP. Kills AND spawns: `q.alive = 0u` kills; `q.spawnCount = n` emits n children
 * this frame (capped per parent per frame; a runaway emitter saturates COUNTABLY —
 * the counts buffer keeps a cumulative dropped-births tally — instead of hanging).
 *
 * The whole lifecycle is deterministic scan compaction (T119/T120, §V74 — never
 * atomics): the kernel writes ONE packed flags word (exposed to kernels as separate
 * `alive`/`spawnCount` fields — the packing never reaches user code), a glue pass
 * zeroes the stale tail, the alive scan counts survivors, the SAME generated scan
 * with a different extraction counts births, scatter packs survivors, chunked copy
 * passes append children as COPIES of their parents — fresh ids from a monotone
 * GPU-resident cursor (§V73; a 32-bit hash would birthday-collide within seconds),
 * differentiation next frame via pointRand(id, salt) (§V74). The spawn(parent) hook
 * is deferred — see the budget note on ADVANCED_KERNEL_CONTRACT_VERSION.
 *
 * THE INVERSION (§V231): scatter cannot land in the half the kernel just wrote (that
 * is its input), so compacted data lands in the READ half, the pairs declare
 * `swap: false`, and the edge map names `half: "read"` — consumers bind what the
 * payload says and cannot tell this producer from an ordinary one. The live count
 * travels as `count: { buffer }`; capacity stays the allocation bound.
 */

const FLAGS = "flags";

function withFlags(attributes: ReadonlyArray<PointAttributeSchema>): ReadonlyArray<PointAttributeSchema> {
  return [...attributes, { name: FLAGS, type: "u32", default: [1] }];
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
      description: "fn process(p: Point, ctx: PointCtx) -> Point. q.alive = 0u kills; q.spawnCount = n emits n children this frame (capped per parent). pointRand(pointId, salt) is available.",
    },
    group: {
      type: "string",
      label: "Group",
      default: "",
      compileTime: true,
      description:
        "T300: WGSL predicate over (p, ctx). Only matching points run the kernel — non-members pass through ALIVE and unchanged. Empty = all.",
    },
    spawn: {
      type: "string",
      label: "Spawn Hook",
      default: "",
      multiline: true,
      compileTime: true,
      description:
        "T339: fn spawn(child: Point, ctx: PointCtx) -> Point. Runs once on each NEWBORN, which arrives as its parent's copy — shape its attributes here. No alive/spawnCount: lifecycle belongs to the kernel. Empty = children stay copies.",
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
    for (const reserved of [FLAGS, "alive", "spawnCount"]) {
      if (parsed.attributes.some((attribute) => attribute.name === reserved)) {
        return {
          passes: [],
          diagnostics: [
            {
              severity: "error",
              code: "node.points.attributes",
              message: `Node "${nodeId}": "${reserved}" belongs to the injected lifecycle contract; the schema must not declare it.`,
              nodeId,
            },
          ],
        };
      }
    }
    // T323: spawning mints identity — children need fresh ids or §V73's guarantee dies
    // at the first birth. The u32 id-semantic attribute is therefore REQUIRED here.
    const idAttribute = parsed.attributes.find(
      (attribute) => attribute.semantic === "id" && attribute.type === "u32",
    );
    if (idAttribute === undefined) {
      return {
        passes: [],
        diagnostics: [
          {
            severity: "error",
            code: "node.points.attributes",
            message: `Node "${nodeId}": the advanced kernel requires a u32 attribute with semantic "id" — spawning mints identity (§V73). The default schema carries one.`,
            nodeId,
          },
        ],
      };
    }
    const attributes = withFlags(parsed.attributes);
    // Baseline WebGPU allows 8 storage buffers per stage (§V24). The kernel binds an
    // in/out pair per attribute, the packed flags word out-only, and the counts
    // buffer: 2·(n−1) + 1 + 1. Beyond that the pipeline FAILS SILENTLY (B33) —
    // refuse loudly instead. The named ways past 8 are documented on
    // ADVANCED_KERNEL_CONTRACT_VERSION.
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
    const groupSource = typeof parameters["group"] === "string" ? parameters["group"] : "";
    const module = generateKernelModule({
      attributes,
      reads: names,
      writes: names,
      kernel: kernelSource,
      lifecycle: { flagsAttribute: FLAGS },
      ...(groupSource.trim() === "" ? {} : { group: groupSource }),
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

    const compaction = generateCompactionModule(attributes, capacity, "aliveBit");
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

    const spawn = generateSpawnModule(attributes, {
      idAttribute: idAttribute.name,
      flagsAttribute: FLAGS,
    });

    // T339: the optional second pass. Zero cost when unused — no pass, no bindings,
    // the pass list byte-identical to the hookless one (T300's property, kept).
    const hookSource = typeof parameters["spawn"] === "string" ? parameters["spawn"].trim() : "";
    let hookModule: ReturnType<typeof generateSpawnHookModule> | undefined;
    if (hookSource !== "") {
      hookModule = generateSpawnHookModule({ attributes, flagsAttribute: FLAGS, hook: hookSource });
      if (!hookModule.ok) {
        return {
          passes: [],
          diagnostics: hookModule.errors.map((message) => ({
            severity: "error" as const,
            code: "node.points.spawn",
            message: `Node "${nodeId}": ${message}`,
            nodeId,
          })),
        };
      }
    }

    const counts = liveCountBufferId(nodeId);
    const scanned = pointPairId(nodeId, "scanned");
    const blockSums = pointPairId(nodeId, "blockSums");
    const spawnScanned = pointPairId(nodeId, "spawnScanned");
    const spawnBlockSums = pointPairId(nodeId, "spawnBlockSums");
    const flagsPair = pointPairId(nodeId, FLAGS);
    const frameUniforms = { timeSeconds: 0, deltaSeconds: 0, frameIndex: 0 };

    /**
     * One binding-name→resource mapping for every lifecycle pass. The SPAWN scans run
     * the SHARED scan WGSL (binding names scanned/blockSums), pointed at the spawn
     * buffers — same implementation, different resources, which is exactly why the
     * second scan cannot drift from the first.
     */
    const lifecycleBinding = (
      passName: string,
      name: string,
    ): { binding: string; resourceId: string; half?: "read" | "write" } => {
      const spawnScan = passName.startsWith("spawnScan");
      if (name === "flags") return { binding: name, resourceId: flagsPair, half: "write" };
      if (name === "scanned") return { binding: name, resourceId: spawnScan ? spawnScanned : scanned };
      if (name === "blockSums") return { binding: name, resourceId: spawnScan ? spawnBlockSums : blockSums };
      if (name === "spawnScanned") return { binding: name, resourceId: spawnScanned };
      if (name === "spawnBlockSums") return { binding: name, resourceId: spawnBlockSums };
      if (name === "aliveCount" || name === "counts") return { binding: name, resourceId: counts };
      const attribute = name.replace(/^(in|out)_/, "");
      // Scatter and spawn copies read this frame's data from WRITE halves and land
      // results in READ halves — the §V231 inversion, contained in this pass list.
      // Exception: spawnIdentity WRITES out_id/out_flags into read halves too.
      return {
        binding: name,
        resourceId: pointPairId(nodeId, attribute),
        half: name.startsWith("in_") ? "write" : "read",
      };
    };

    const passes: DispatchPassDescriptor[] = [
      {
        kind: "dispatch",
        id: `${nodeId}:kernel`,
        shader: module.wgsl,
        entryPoint: "main",
        workgroups: [Math.ceil(capacity / module.workgroupSize), 1, 1],
        buffers: module.buffers.map((binding) =>
          binding.role === "live"
            ? { binding: binding.variable, resourceId: counts }
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
          { binding: "liveCount", resourceId: counts },
          { binding: "aliveFlags", resourceId: flagsPair, half: "write" },
        ],
        uniforms: { ...frameUniforms, capacity },
        uniformBinding: "params",
        nodeId,
      },
      ...[...compaction.passes, ...spawn.passes].map(
        (pass): DispatchPassDescriptor => ({
          kind: "dispatch",
          id: `${nodeId}:${pass.name}`,
          shader: pass.wgsl,
          entryPoint: pass.entryPoint,
          workgroups:
            pass.dispatch === "single" ? [1, 1, 1] : [Math.ceil(capacity / SCAN_WORKGROUP_SIZE), 1, 1],
          buffers: pass.bindings.map((binding) => lifecycleBinding(pass.name, binding.name)),
          uniforms:
            pass.name.startsWith("spawnCopy") || pass.name === "spawnIdentity" || pass.name === "spawnFinalize"
              ? { ...frameUniforms, capacity }
              : { capacity },
          uniformBinding: "params",
          nodeId,
        }),
      ),
      ...(hookModule?.ok === true
        ? [
            {
              kind: "dispatch" as const,
              id: `${nodeId}:spawnHook`,
              shader: hookModule.wgsl,
              entryPoint: "main",
              workgroups: [Math.ceil(capacity / hookModule.workgroupSize), 1, 1] as [number, number, number],
              buffers: hookModule.buffers.map((binding) =>
                binding.role === "live"
                  ? { binding: binding.variable, resourceId: counts }
                  : // In place, on the READ halves — where the copy passes left the
                    // newborns and where consumers bind (§V231).
                    { binding: binding.variable, resourceId: pointPairId(nodeId, binding.attribute), half: "read" as const },
              ),
              uniforms: { ...frameUniforms, seed: readNumber(parameters, "seed", 7), count: capacity },
              uniformBinding: "kernelFrame",
              nodeId,
            },
          ]
        : []),
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
      // The counts buffer (u32 × 4): live count, id cursor, cumulative dropped
      // births, this frame's raw birth total. Slot 0 is what consumers read.
      { kind: "buffer", key: "liveCount", stride: 4, capacity: 4 },
      { kind: "buffer", key: "scanned", stride: 4, capacity },
      { kind: "buffer", key: "blockSums", stride: 4, capacity: blockCount(capacity) },
      { kind: "buffer", key: "spawnScanned", stride: 4, capacity },
      { kind: "buffer", key: "spawnBlockSums", stride: 4, capacity: blockCount(capacity) },
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
              .filter((attribute) => attribute.name !== FLAGS)
              .map((attribute) => [
                attribute.name,
                { pair: pointPairId(nodeId, attribute.name), half: "read" as const, type: attribute.type },
              ]),
          ),
          capacity,
          topology: "points",
          count: { buffer: counts },
        },
      },
    };
  },
};
