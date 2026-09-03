import type { CompiledNodeDescription, NodeDefinition, ScratchRequest } from "../../domain/types/node-definition.ts";
import type { BufferBindingDescriptor, DispatchPassDescriptor } from "../../runtime/backend/plan.ts";
import type { PointAttributeSchema } from "../../points/attributes.ts";
import type { PointRegion } from "../../points/packing.ts";
import {
  ADVANCED_KERNEL_CONTRACT_VERSION,
  KERNEL_PARAM_PREFIX,
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
import { RGBA_TEXTURE } from "./common-ports.ts";
import { codeParametersLast } from "../../domain/parameters/code.ts";
import { readNumber } from "./parameter-readers.ts";
import {
  kernelBodyOf,
  kernelParamCollisions,
  kernelParamSchema,
  kernelParamsFor,
  legacyValueParametersFor,
  parseAttributes,
  pointKernelNoticeDiagnostics,
  pointKernelValueParameters,
  pointKernelValueUniforms,
  pointBufferId,
  structuralParameters,
} from "./points.ts";
import {
  kernelBufferBindings,
  kernelStorage,
  packedPointStorage,
  regionBinding,
  type KernelStoragePlan,
} from "./point-storage.ts";
import { reflectedUniforms } from "./params-reflection.ts";

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

/**
 * The schema this node actually ALLOCATES: the author's, plus the injected lifecycle word.
 * Exported since T1076 because the packed layout is a function of exactly this list, and a
 * reader (a test, a readback) that used the author's list alone would land one region off
 * for every attribute after the first.
 */
export function withFlags(attributes: ReadonlyArray<PointAttributeSchema>): ReadonlyArray<PointAttributeSchema> {
  return [...attributes, { name: FLAGS, type: "u32", default: [1] }];
}

export function liveCountBufferId(nodeId: string): string {
  return pointBufferId(nodeId, "liveCount");
}

export const pointKernelAdvancedNode: NodeDefinition = {
  type: "pointKernelAdvanced",
  version: 1,
  title: "Point Kernel (Advanced)",
  category: "points",
  description:
    "A per-point kernel that may kill points — survivors are compacted deterministically and the live count stays on the GPU.",
  tags: ["points", "particles", "compute", "kernel", "lifecycle", "advanced"],
  inputs: [
    {
      /* T744 — the input this node never had, found by E41: "particles from a video"
         needs a SPAWN decision that can read a texture, and this node took no inputs at
         all, forcing the recycling workaround. Same port, same fieldAt mapping, same
         codegen path as the plain kernel's field (§V349 and the T743 boundary: ONE
         texture-into-points route, never a second). */
      id: "field",
      label: "Field",
      optional: true,
      type: RGBA_TEXTURE,
      description:
        "Optional texture the kernel samples with fieldAt(position) — clip-space xy mapped to uv, exactly as Texture To Attribute maps it. Read with textureLoad, so data fields work on Tier B (§V57). The kernel reads it; the spawn hook does not (a child arrives as its parent's copy — stash what it needs in an attribute).",
    },
  ],
  outputs: [
    {
      id: "out",
      label: "Out",
      type: { kind: "pointset", requires: [{ name: "position", type: "vec3f" }] },
    },
  ],
  /** T1052: code LAST — see `codeParametersLast`. Order within each half is as declared. */
  parameters: codeParametersLast({
    capacity: {
      type: "number",
      label: "Capacity",
      default: 4096,
      min: 1,
      max: 1_000_000,
      range: "bounded",
      step: 1,
      compileTime: true,
      description: "Allocation bound. The live count only ever shrinks from here (v1 kills; spawn is T323).",
    },
    seed: { type: "number", label: "Seed", default: 7, step: 1 },
    attributes: {
      type: "code",
      language: "json",
      label: "Attributes",
      default: "",
      compileTime: true,
      description:
        'JSON schema, e.g. [{"name":"position","type":"vec3f","semantic":"position","default":[0,0,0]}]. Empty = position/velocity/id. "alive" is injected.',
    },
    kernel: {
      type: "code",
      language: "wgsl",
      label: "Kernel",
      default: DEFAULT_POINT_KERNEL,
      compileTime: true,
      description:
        "fn process(p: Point, ctx: PointCtx) -> Point. q.alive = 0u kills; q.spawnCount = n emits n children this frame (capped per parent). Clocks first: ctx.absTime (f32 seconds) and ctx.absFrame (u32 — a texture shader's frameU.absFrame is f32) keep counting across a timeline loop, so reach for these for anything that should simply keep going. ctx.time and ctx.frameIndex are timeline readings and reset to the in point at every lap — take them only when where you are IN the piece is the point, and write \"timeline-anchored\" in a comment when you do. ctx.pointer (vec4f: x, y, buttons) is available to a kernel that names it. YOUR OWN KNOBS (T900): declare a `struct Params { … }` in this text and each field becomes a named, typed, drivable control on this node, read as ctx.params.<name> here AND in the spawn hook — a uniform write, never a rebuild. That replaces ctx.value1..value4, which still work for kernels that already read them. pointRand(pointId, salt) is available, and fieldAt(position) samples the field input when one is wired (T744) — which is what lets a kernel SPAWN where a video moves.",
    },
    group: {
      type: "code",
      language: "wgsl",
      label: "Group",
      default: "",
      compileTime: true,
      description:
        "T300: WGSL predicate over (p, ctx). Only matching points run the kernel — non-members pass through ALIVE and unchanged. Empty = all.",
    },
    spawn: {
      type: "code",
      language: "wgsl",
      label: "Spawn Hook",
      default: "",
      compileTime: true,
      description:
        "T339: fn spawn(child: Point, ctx: PointCtx) -> Point. Runs once on each NEWBORN, which arrives as its parent's copy — shape its attributes here. No alive/spawnCount: lifecycle belongs to the kernel. Empty = children stay copies. Same ctx as the kernel: ctx.absTime is the clock that does not restart at a loop, so newborns after a lap do not repeat the phases of the ones before it (T489), and ctx.params carries the kernel's declared struct Params (T900) — one declaration, both passes.",
    },
    // T479/T900: the legacy slots stay in the STATIC schema for type-only contexts; a placed
    // node's slots come from `parametersFor` below — parse forever, emit never.
    ...pointKernelValueParameters(["kernel", "group", "spawn"]),
  }),
  /**
   * T900: same reflection, same reflector, same split as the plain kernel — this node's
   * controls are its kernel's own `struct Params`, and the spawn hook reads them through the
   * SAME declaration (one declaration site, two generated modules). Reflected fields are
   * uniform writes (§V5); `kernel`, `attributes`, `group` and `spawn` stay `compileTime`.
   */
  parametersFor(stored) {
    const own = structuralParameters(pointKernelAdvancedNode.parameters);
    // T1052: code LAST — kernel, group, spawn and the attribute schema sort below the knobs.
    return codeParametersLast({
      ...own,
      ...kernelParamSchema(kernelParamsFor(stored).fields, new Set(Object.keys(own))),
      ...legacyValueParametersFor(["kernel", "group", "spawn"], stored),
    });
  },
  stateful: { reset: true, deterministicReplay: true, checkpoint: false, randomAccess: false },
  contractVersion: ADVANCED_KERNEL_CONTRACT_VERSION,
  compile(context): CompiledNodeDescription {
    const { nodeId, parameters, inputs } = readCompileInputs(context);
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
    /* T900/§V588: the 8-storage-buffer budget used to be checked HERE, by an arithmetic copy
       of what codegen was about to build — and the PLAIN kernel had no check at all, so a
       five-attribute schema there built ten bindings and the pipeline failed silently (B33).
       The check now lives once, in `generateKernelModule`, against the binding list it
       actually emits (§V349), and reaches this node as a `node.points.kernel` diagnostic. */

    const kernelSource = typeof parameters["kernel"] === "string" ? parameters["kernel"] : DEFAULT_POINT_KERNEL;
    /* T900: the kernel's `struct Params`, reflected once and shared by BOTH generated modules
       (the kernel and the spawn hook) — one declaration site, so "spawn with the speed the
       slider says" reads the same knob the kernel does. */
    const params = kernelParamsFor({ kernel: kernelSource });
    const collisions = kernelParamCollisions(
      nodeId,
      params.fields,
      new Set(Object.keys(structuralParameters(pointKernelAdvancedNode.parameters))),
    );
    if (collisions.length > 0) return { passes: [], diagnostics: collisions };
    const names = attributes.map((attribute) => attribute.name);
    const groupSource = typeof parameters["group"] === "string" ? parameters["group"] : "";
    /* T744: the SAME field path the plain kernel rides — one route into the point
       pipeline, one fieldAt, one refusal message (§V349). */
    const fieldTexture = inputs["field"];
    /* T1076: ONE packed pair for the whole schema, flags included. §V231: compaction lands
       this frame's data in the READ half, so that is the half the payload names and the
       half `swap: false` preserves. */
    const storage = packedPointStorage(nodeId, attributes, capacity, "read", { swap: false });
    if (!storage.ok) {
      return {
        passes: [],
        diagnostics: storage.errors.map((message) => ({
          severity: "error" as const,
          code: "node.points.capacity",
          message: `Node "${nodeId}": ${message}`,
          nodeId,
        })),
      };
    }
    /* The KERNEL reads pre-frame values from the read half and writes to the write half;
       the lifecycle passes below invert that (§V231), which is why they map their own. */
    const kernelPlan = kernelStorage({ own: storage, touched: names, written: names });

    const module = generateKernelModule({
      attributes,
      reads: names,
      writes: names,
      storage: kernelPlan.storage,
      kernel: kernelBodyOf(kernelSource),
      lifecycle: { flagsAttribute: FLAGS },
      ...(groupSource.trim() === "" ? {} : { group: groupSource }),
      ...(fieldTexture === undefined ? {} : { field: true }),
      ...(params.fields.length === 0 ? {} : { params }),
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

    const compaction = generateCompactionModule(attributes, capacity, storage.layout, "aliveBit");
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

    const spawn = generateSpawnModule(attributes, storage.layout, {
      idAttribute: idAttribute.name,
      flagsAttribute: FLAGS,
    });

    // T339: the optional second pass. Zero cost when unused — no pass, no bindings,
    // the pass list byte-identical to the hookless one (T300's property, kept).
    const hookSource = typeof parameters["spawn"] === "string" ? parameters["spawn"].trim() : "";
    let hookModule: ReturnType<typeof generateSpawnHookModule> | undefined;
    let hookPlan: KernelStoragePlan | undefined;
    const shapedNames = names.filter((name) => name !== FLAGS);
    if (hookSource !== "") {
      hookPlan = kernelStorage({
        own: storage,
        touched: shapedNames,
        written: shapedNames,
        // T339: the hook edits the READ halves in place, where the copy passes left the
        // newborns — so its reads and writes are ONE `read_write` binding (T1076).
        inPlace: "read",
      });
      hookModule = generateSpawnHookModule({
        attributes,
        flagsAttribute: FLAGS,
        storage: hookPlan.storage,
        hook: hookSource,
        ...(params.fields.length === 0 ? {} : { params }),
      });
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
    const scanned = pointBufferId(nodeId, "scanned");
    const blockSums = pointBufferId(nodeId, "blockSums");
    const spawnScanned = pointBufferId(nodeId, "spawnScanned");
    const spawnBlockSums = pointBufferId(nodeId, "spawnBlockSums");
    /** T1076: the region of a named attribute inside this node's packed pair. */
    const region = (name: string): PointRegion => {
      const found = storage.layout.byName.get(name);
      if (found === undefined) throw new Error(`Node "${nodeId}": no packed region for attribute "${name}".`);
      return found;
    };
    const frameUniforms = { timeSeconds: 0, deltaSeconds: 0, frameIndex: 0 };
    /**
     * T510/§V182 — THE LIFECYCLE PASSES RESERVE `firstRun` TOO, and this line is the one
     * that was missing.
     *
     * `TailParams` and `SpawnParams` both DECLARE `firstRun: u32` (`lifecycle.ts`), and the
     * guards that read it are the two that matter: `clearDeadTail` takes the full capacity
     * as live on a fresh buffer rather than the zero-initialised count (else the whole
     * population is marked dead on its first frame), and `spawnFinalize` starts newborn ids
     * at capacity rather than reusing the first generation's (§V73). Both were declared and
     * neither was reserved, so the PLAN said the pass carried four members while its shader
     * declared five, and `catalogue-chain`'s set-equality has been red at HEAD.
     *
     * The record is a NAME RESERVATION, never the value: `firstRun` is computed PER DISPATCH
     * at render time from `pendingBufferClear ∪ freshStorage` and a plan record is written at
     * compile and on parameter change (§V5/§V21) — it structurally cannot know. The backend
     * publishes it by name onto every dispatch, exactly as it does the T172 frame fields and
     * the absolute pair (§V182, one publisher). Reserving it here does not make that write
     * redundant; it stops the next reader concluding the write is over-broad and SCOPING it,
     * which would pin `firstRun` at 0 for ever — silently, in both guards (§V495/§V514).
     *
     * NOT folded into `frameUniforms`: the SPAWN HOOK spreads that and declares no
     * `firstRun` at all (§V507 — a newborn on frame 900 is not a fresh buffer), and the same
     * gate is exact in BOTH directions, so a record naming a member the shader does not
     * declare fails just as loudly as one missing a member it does.
     */
    const lifecycleFrameParams = { ...frameUniforms, firstRun: 0 };

    /**
     * One binding-name→resource mapping for every lifecycle pass. The SPAWN scans run
     * the SHARED scan WGSL (binding names scanned/blockSums), pointed at the spawn
     * buffers — same implementation, different resources, which is exactly why the
     * second scan cannot drift from the first.
     */
    const lifecycleBinding = (passName: string, name: string): BufferBindingDescriptor => {
      const spawnScan = passName.startsWith("spawnScan");
      if (name === "scanned") return { binding: name, resourceId: spawnScan ? spawnScanned : scanned };
      if (name === "blockSums") return { binding: name, resourceId: spawnScan ? spawnBlockSums : blockSums };
      if (name === "spawnScanned") return { binding: name, resourceId: spawnScanned };
      if (name === "spawnBlockSums") return { binding: name, resourceId: spawnBlockSums };
      if (name === "aliveCount" || name === "counts") return { binding: name, resourceId: counts };
      // Scatter and spawn copies read this frame's data from WRITE halves and land
      // results in READ halves — the §V231 inversion, contained in this pass list.
      // Exception: spawnIdentity WRITES out_id/out_flags into read halves too.
      const half = name.startsWith("in_") ? ("write" as const) : ("read" as const);
      /* T1076: `in_points`/`out_points` are the WHOLE packed buffer — the pass addresses
         every attribute's region by offset, which is what collapsed the chunked scatter
         (⌈n/2⌉ dispatches) and the per-attribute spawn copies (n dispatches) into one
         dispatch each. Everything else is a REGION: a u32 attribute bound alone reads as
         `array<u32>` with no change to the shared scan WGSL at all. */
      if (name === "in_points" || name === "out_points") {
        return { binding: name, resourceId: storage.resourceId, half };
      }
      // `flags` is read where this frame's flags word was written — the write half.
      if (name === "flags") return regionBinding(name, storage.resourceId, "write", region(FLAGS));
      return regionBinding(name, storage.resourceId, half, region(name.replace(/^(in|out)_/, "")));
    };

    const passes: DispatchPassDescriptor[] = [
      {
        kind: "dispatch",
        id: `${nodeId}:kernel`,
        shader: module.wgsl,
        entryPoint: "main",
        workgroups: [Math.ceil(capacity / module.workgroupSize), 1, 1],
        buffers: kernelBufferBindings(module.buffers, kernelPlan, counts),
        /* T744: a texture binding, not a storage buffer — the §V588 attribute budget is
           untouched, which is why this input was always affordable. */
        ...(module.usesField && fieldTexture !== undefined
          ? { textures: [{ binding: "fieldTexture", resourceId: fieldTexture.resource, sampled: "unfiltered" as const }] }
          : {}),
        // T367: the pointer entry exists exactly when the generated block declares it —
        // the backend fills it per frame from the shared block's own value (§V182).
        uniforms: {
          ...frameUniforms,
          seed: readNumber(parameters, "seed", 7),
          count: capacity,
          ...(module.usesPointer ? { pointer: [0, 0, 0, 0] } : {}),
        // T510: reserved exactly when the module declared it — the backend overwrites it
        // every dispatch (1u only when this pass's storage was just created or cleared).
        ...(module.usesFirstRun ? { firstRun: 0 } : {}),
          // T479: mirrored per declared slot, same hazard as the pointer above.
          ...pointKernelValueUniforms(module.usesValues, parameters),
          // T900: the reflected params, mirrored by name exactly as the module declared them.
          ...reflectedUniforms(module.usesParams, parameters, KERNEL_PARAM_PREFIX),
          // T489 (B97): the absolute pair, same mirroring rule as the pointer above.
          ...(module.usesAbsClock ? { absTimeSeconds: 0, absFrameIndex: 0 } : {}),
        },
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
          // T1076: the flags REGION of the packed write half — `array<u32>` at an offset,
          // so `clearDeadTailWgsl` is byte-identical to what it was.
          regionBinding("aliveFlags", storage.resourceId, "write", region(FLAGS)),
        ],
        uniforms: { ...lifecycleFrameParams, capacity },
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
              ? { ...lifecycleFrameParams, capacity }
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
              // In place, on the READ halves — where the copy passes left the newborns
              // and where consumers bind (§V231).
              buffers: kernelBufferBindings(hookModule.buffers, hookPlan as KernelStoragePlan, counts),
              uniforms: {
                ...frameUniforms,
                seed: readNumber(parameters, "seed", 7),
                count: capacity,
                ...(hookModule.usesPointer ? { pointer: [0, 0, 0, 0] } : {}),
                // T479: the hook's own slots, mirrored from the same parameters.
                ...pointKernelValueUniforms(hookModule.usesValues, parameters),
                ...reflectedUniforms(hookModule.usesParams, parameters, KERNEL_PARAM_PREFIX),
                // T489 (B97): the hook's own absolute pair, mirrored the same way.
                ...(hookModule.usesAbsClock ? { absTimeSeconds: 0, absFrameIndex: 0 } : {}),
              },
              uniformBinding: "kernelFrame",
              nodeId,
            },
          ]
        : []),
    ];

    const scratch: ScratchRequest[] = [
      storage.scratch,
      // The counts buffer (u32 × 4): live count, id cursor, cumulative dropped
      // births, this frame's raw birth total. Slot 0 is what consumers read.
      { kind: "buffer", key: "liveCount", stride: 4, capacity: 4 },
      { kind: "buffer", key: "scanned", stride: 4, capacity },
      { kind: "buffer", key: "blockSums", stride: 4, capacity: blockCount(capacity) },
      { kind: "buffer", key: "spawnScanned", stride: 4, capacity },
      { kind: "buffer", key: "spawnBlockSums", stride: 4, capacity: blockCount(capacity) },
    ];

    // T587: the kernel's notices AND the spawn hook's, on one node. The hook is scanned
    // separately because it is separate text with its own declaration — a kernel that
    // declared itself timeline-anchored does not excuse the hook beside it (§V464(c)).
    const notices = [...module.notices, ...(hookModule?.ok === true ? hookModule.notices : [])];

    return {
      passes,
      scratch,
      ...(notices.length === 0 ? {} : { diagnostics: pointKernelNoticeDiagnostics(nodeId, notices) }),
      pointsets: {
        out: {
          // Consumers bind READ halves: that is where scatter left this frame's
          // survivors. The payload says so; nobody downstream has to know why.
          pairs: Object.fromEntries(
            Object.entries(storage.pairs).filter(([name]) => name !== FLAGS),
          ),
          capacity,
          topology: "points",
          count: { buffer: counts },
        },
      },
    };
  },
};
