import type { CompiledNodeDescription, NodeDefinition } from "../../domain/types/node-definition.ts";
import type { ParameterSchema, ParameterValue } from "../../domain/types/parameters.ts";
import type { DispatchPassDescriptor, DrawPassDescriptor } from "../../runtime/backend/plan.ts";
import {
  ATTRIBUTE_STRIDES,
  validateAttributes,
  type PointAttributeSchema,
} from "../../points/attributes.ts";
import {
  POINT_KERNEL_CONTRACT_VERSION,
  POINT_KERNEL_VALUE_SLOTS,
  generateKernelModule,
  kernelReadsValueSlot,
  pointKernelValueKey,
} from "../../points/codegen.ts";
import { parseTopology } from "../../points/topology.ts";
import { drawArgsWgsl } from "../../points/lifecycle.ts";
import { DEFAULT_POINT_KERNEL, SPRITE_RENDER_WGSL, TEXTURE_TO_ATTRIBUTE_WGSL, pointRayWgsl, spriteRenderWgsl } from "../shaders/points.wgsl.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";
import { missingCompileResource, readCompileInputs } from "./compile-context.ts";
import { readColor, readNumber } from "./parameter-readers.ts";

/**
 * The point family (T121, T122): Point Kernel simulates, Render Points draws.
 *
 * A pointset edge carries a FAMILY of buffers — one ping-pong pair per attribute —
 * not one resource. The id convention below is the contract between producer and
 * consumer: the kernel node's pair for attribute `a` is `points:{nodeId}:{a}`, and a
 * consumer derives the same ids from the input binding's `source.nodeId`. The pair
 * swaps as ONE identity, so T143 carry-over keeps simulation state across unrelated
 * edits exactly as texture feedback survives them (§V22).
 *
 * Chain-compiled for real: `compileGraph` accepts dispatch/draw emission, materializes
 * the bufferPair scratch entries, propagates pointset edges as markers and appends the
 * pair swaps after all consumers (T176). The fixture and Dawn tests cover everything
 * below the compiler; the chain test covers the seam.
 */

import { scratchResourceId } from "../../compiler/resources.ts";
import { storedStaticValue } from "../../domain/parameters/slots.ts";

/**
 * The producer/consumer id contract for a pointset attribute's ping-pong pair. ONE
 * definition: the compiler materializes the producer's bufferPair scratch entries under
 * `scratchResourceId(nodeId, attribute)`, and consumers derive the identical id from
 * the edge's source identity — no second convention to drift.
 */

/**
 * The point schema a node's parameters resolve to (T293) — the `pointSetInfo` the
 * read_points port needs, derived from the DOCUMENT so the composition root can wire
 * the port without re-reading node internals. Undefined for a non-point node or an
 * attributes parameter the schema rejects (the compile diagnostic already said why).
 */
export function pointSetInfoFor(
  node: { type: string; parameters: Readonly<Record<string, unknown>> },
): { attributes: ReadonlyArray<PointAttributeSchema>; capacity: number } | undefined {
  const numberOf = (key: string, fallback: number): number => {
    const value = storedStaticValue(node.parameters[key] as never);
    return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.round(value)) : fallback;
  };
  if (node.type === "pointKernel") {
    const { attributes } = parseAttributes(storedStaticValue(node.parameters["attributes"] as never));
    if (attributes === undefined) return undefined;
    return { attributes, capacity: numberOf("capacity", 4096) };
  }
  if (node.type === "textureToAttribute") {
    return {
      attributes: [
        { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
        { name: "sample", type: "vec4f", default: [0, 0, 0, 0] },
      ],
      capacity: numberOf("count", 4096),
    };
  }
  return undefined;
}

export function pointPairId(nodeId: string, attribute: string): string {
  return scratchResourceId(nodeId, attribute);
}

export const DEFAULT_POINT_ATTRIBUTES: ReadonlyArray<PointAttributeSchema> = [
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "velocity", type: "vec3f", default: [0, 0, 0] },
  { name: "id", type: "u32", semantic: "id", default: [0] },
];

export function parseAttributes(raw: unknown): { attributes?: ReadonlyArray<PointAttributeSchema>; error?: string } {
  if (typeof raw !== "string" || raw.trim() === "") return { attributes: DEFAULT_POINT_ATTRIBUTES };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { error: `attributes is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!Array.isArray(parsed)) return { error: "attributes must be a JSON array of { name, type, semantic?, default }" };
  const attributes = parsed as PointAttributeSchema[];
  const check = validateAttributes(attributes);
  if (!check.ok) return { error: check.errors.join("; ") };
  // The output PORT advertises `position: vec3f` (that is what makes it wirable into a
  // renderer under §V13's provides ⊇ requires rule), so every schema must honor it —
  // a port type is a static promise a dynamic parameter is not allowed to break.
  const position = attributes.find((attribute) => attribute.name === "position");
  if (position === undefined || position.type !== "vec3f") {
    return { error: 'the schema must include { name: "position", type: "vec3f" } — the output port promises it' };
  }
  return { attributes };
}

/** Buffer-pair descriptors a plan needs for one kernel node. Tests and the (future) compiler share it. */
export function pointKernelResources(
  nodeId: string,
  attributes: ReadonlyArray<PointAttributeSchema>,
  capacity: number,
): ReadonlyArray<{ kind: "bufferPair"; id: string; stride: number; capacity: number }> {
  return attributes.map((attribute) => ({
    kind: "bufferPair" as const,
    id: pointPairId(nodeId, attribute.name),
    stride: ATTRIBUTE_STRIDES[attribute.type],
    capacity,
  }));
}

/**
 * T479 — the VALUE-GRAPH slots, defined ONCE for both kernel nodes (§V109: two nodes
 * wording the same idea differently is two answers to one question).
 *
 * Each slot is an ordinary drivable number. That is the whole design decision: the
 * channel NAME (`lfo1`, `mouse1:x`) lives in a `driven` binding on the parameter, which
 * rename already rewrites (§V128 kind 2, B40's fix) and which liveness, the reference
 * lines and the dangling-name diagnostics already understand. A name written inside the
 * kernel's WGSL would be a fifth reference currency that all five of those consumers
 * would have to learn — and wiring four of five is exactly how B40 happened.
 *
 * NOT `compileTime`: a slot changing is a uniform write, never a rebuild (§V5) — which is
 * the entire point, since the kernel text is compileTime and the slot is how live values
 * get past that.
 *
 * `inactiveWhen` asks the SAME reader codegen asks (`kernelReadsValueSlot`), so the
 * inspector shows exactly the slots this kernel reads and NAMES why the others are
 * inactive — never a knob that is present and does nothing (§V220/§V360).
 */
export function pointKernelValueParameters(sourceKeys: ReadonlyArray<string>): ParameterSchema {
  const entries = Array.from({ length: POINT_KERNEL_VALUE_SLOTS }, (_unused, index) => {
    const slot = index + 1;
    const key = pointKernelValueKey(slot);
    return [
      key,
      {
        type: "number" as const,
        label: `Value ${slot}`,
        default: 0,
        description:
          `Reaches the kernel as ctx.value${slot}. Put it in Driven mode and an LFO, the mouse or an ` +
          `audio channel changes what the kernel DOES, not just what it is scaled by (T479).`,
        inactiveWhen: (values: Readonly<Record<string, ParameterValue>>) =>
          kernelReadsValueSlot(slot, ...sourceKeys.map((sourceKey) => String(values[sourceKey] ?? "")))
            ? null
            : `This kernel does not read ctx.value${slot}.`,
      },
    ] as const;
  });
  return Object.fromEntries(entries);
}

/**
 * T479: the uniform mirror, defined beside the schema it must match. vgpu writes uniform
 * values BY NAME into the reflected layout, so a member with no value silently reads zero
 * and a value with no member is silently dropped — the hazard `KernelModule.usesPointer`
 * documents, now with four more names to keep in step.
 */
export function pointKernelValueUniforms(
  slots: ReadonlyArray<number>,
  parameters: Readonly<Record<string, ParameterValue>>,
): Record<string, number> {
  return Object.fromEntries(
    slots.map((slot) => [pointKernelValueKey(slot), readNumber(parameters, pointKernelValueKey(slot), 0)]),
  );
}

export const pointKernelNode: NodeDefinition = {
  type: "pointKernel",
  version: 1,
  title: "Point Kernel",
  category: "points",
  description:
    "Runs a per-point WGSL kernel over a GPU point set every frame. The POP-style custom operator.",
  tags: ["points", "particles", "compute", "simulation"],
  inputs: [
    {
      // T401 (B57): the PROCESSOR port. Optional, so every existing kernel-as-source
      // graph keeps compiling byte-identically (§V309); connected, the kernel reads the
      // upstream pointset's attributes instead of its own last frame — torus in,
      // displaced torus out, the SOP-chain shape the catalogue was missing.
      id: "in",
      label: "Points In",
      optional: true,
      type: { kind: "pointset", requires: [{ name: "position", type: "vec3f" }] },
      description:
        "Optional upstream point set. Attributes the schema shares with it are read from upstream; the rest keep this node's own state.",
    },
    {
      // T477: the advection FIELD — sparks carried by a fluid, the 2D↔3D crossing.
      // Optional and use-detected: an unwired field costs nothing, and a kernel that
      // calls fieldAt with nothing wired is refused by name (§V288/§V309).
      id: "field",
      label: "Field",
      optional: true,
      type: RGBA_TEXTURE,
      description:
        "Optional texture the kernel samples with fieldAt(position) — clip-space xy mapped to uv, exactly as Texture To Attribute maps it. Read with textureLoad, so data fields work on Tier B (§V57).",
    },
  ],
  outputs: [
    {
      id: "out",
      label: "Points",
      // The producer's `requires` is its PROVIDES list (§V13): consumers may demand any
      // subset. Position is guaranteed by schema validation above; everything else in a
      // custom schema rides along without appearing here.
      type: { kind: "pointset", requires: [{ name: "position", type: "vec3f" }] },
      description: "The simulated point set. position:vec3f is guaranteed; other attributes follow the schema.",
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
      description: "Allocated point slots. Changing it reallocates and resets the system.",
    },
    seed: {
      type: "number",
      label: "Seed",
      default: 7,
      step: 1,
      description: "Feeds pointRand(seed, pointId, frame) — same seed, same motion (§V74).",
    },
    attributes: {
      type: "code",
      language: "json",
      label: "Attributes",
      default: "",
      compileTime: true,
      description: 'JSON schema, e.g. [{"name":"position","type":"vec3f","semantic":"position","default":[0,0,0]}]. Empty = position/velocity/id.',
    },
    kernel: {
      type: "code",
      language: "wgsl",
      label: "Kernel",
      default: DEFAULT_POINT_KERNEL,
      compileTime: true,
      description:
        "fn process(p: Point, ctx: PointCtx) -> Point. ctx carries index, count, time, delta, frameIndex — plus pointer (vec4f: x, y, buttons), dim (cols, rows, i, j — the grid off the incoming edge, T472), value1..value4 (this node's drivable Value parameters, T479) and absTime/absFrame (the clock that keeps growing across a timeline loop, where time and frameIndex wrap — T489) for a kernel that names them. pointRand(pointId, salt) is available, and fieldAt(position) samples the field input when one is wired (T477).",
    },
    group: {
      type: "code",
      language: "wgsl",
      label: "Group",
      default: "",
      compileTime: true,
      description:
        "T300: WGSL predicate over (p, ctx) — e.g. p.position.y > 0.0. Only matching points run the kernel; the rest pass through unchanged. Empty = all.",
    },
    // T479: the live channel. Both texts are scanned, because a group predicate reads the
    // same ctx the kernel does.
    ...pointKernelValueParameters(["kernel", "group"]),
  },
  stateful: { reset: true, deterministicReplay: true, checkpoint: false, randomAccess: false },
  contractVersion: POINT_KERNEL_CONTRACT_VERSION,
  compile(context): CompiledNodeDescription {
    const { nodeId, parameters, inputs } = readCompileInputs(context);

    const capacity = Math.max(1, Math.round(readNumber(parameters, "capacity", 4096)));
    const { attributes, error } = parseAttributes(parameters["attributes"]);
    if (attributes === undefined) {
      return {
        passes: [],
        diagnostics: [
          { severity: "error", code: "node.points.attributes", message: `Node "${nodeId}": ${error}`, nodeId },
        ],
      };
    }

    /*
     * T401 (B57): the incoming pointset, when the processor port is wired.
     *
     * The chain contract, decided here and pinned by test:
     *  - CAPACITY must MATCH the node's own, refused by name otherwise — never adopted
     *    silently. The parameter also sizes this node's pairs and its dispatch, so a
     *    silent adoption would make the inspector's number a lie, and a three-node
     *    chain would truncate or over-read wherever the numbers first disagreed.
     *  - a COUNTED upstream (GPU live count) is refused: this kernel processes a fixed
     *    capacity, and splatting the dead tail through `process()` would resurrect it.
     *  - a shared attribute with a DIFFERENT (or undeclared) type is refused. Falling
     *    back to this node's own state would quietly feed defaults where the user
     *    wired data — the silent-wrong §V288 exists to prevent.
     * Every refusal names what the incoming pointset DOES carry, because the whole
     * error class here is a typo'd or absent attribute.
     */
    const incoming = inputs["in"]?.pointset;
    const refuse = (message: string, suggestion?: string): CompiledNodeDescription => ({
      passes: [],
      diagnostics: [
        {
          severity: "error" as const,
          code: "node.points.input",
          message: `Node "${nodeId}": ${message}`,
          nodeId,
          ...(suggestion === undefined ? {} : { suggestion }),
        },
      ],
    });
    if (incoming !== undefined) {
      const carried = Object.entries(incoming.pairs)
        .map(([name, entry]) => `${name}: ${entry.type ?? "untyped"}`)
        .sort()
        .join(", ");
      if (incoming.count !== undefined) {
        return refuse(
          `the incoming pointset carries a GPU live count, and this kernel processes a fixed capacity — running process() over the dead tail would resurrect it (carries: ${carried}).`,
          "Chain after a static producer, or do this work inside the advanced kernel itself.",
        );
      }
      if (incoming.capacity !== capacity) {
        return refuse(
          `capacity ${capacity} does not match the incoming pointset's ${incoming.capacity} (carries: ${carried}).`,
          `Set capacity to ${incoming.capacity}.`,
        );
      }
      for (const attribute of attributes) {
        const upstream = incoming.pairs[attribute.name];
        if (upstream === undefined) continue; // starts from this node's own state, by design
        if (upstream.type !== attribute.type) {
          return refuse(
            `attribute "${attribute.name}" is ${upstream.type ?? "untyped"} on the incoming pointset but ${attribute.type} in this kernel's schema (carries: ${carried}).`,
            "Match the attribute's type, or rename one of the two.",
          );
        }
      }
    }

    const kernelSource = typeof parameters["kernel"] === "string" ? parameters["kernel"] : DEFAULT_POINT_KERNEL;
    const names = attributes.map((attribute) => attribute.name);
    const groupSource = typeof parameters["group"] === "string" ? parameters["group"] : "";
    /* T472 (B85): `ctx.dim` comes off the EDGE, never off a parameter of this node. The
       topology string has ridden the pointset edge since T296 — the dimensions were
       already travelling, they were simply unreachable from inside a kernel, which is why
       E20 retyped `64u` into its WGSL beside the `cols: 64` the user can actually see. A
       non-grid (or absent) topology supplies nothing, and codegen refuses by name only if
       the kernel asks (§V288/§V309: costing nothing when unused is the whole point). */
    const incomingTopology = parseTopology(incoming?.topology);
    const fieldTexture = inputs["field"];
    const module = generateKernelModule({
      attributes,
      reads: names,
      writes: names,
      kernel: kernelSource,
      ...(groupSource.trim() === "" ? {} : { group: groupSource }),
      ...(incomingTopology?.kind === "grid"
        ? { dim: { cols: incomingTopology.cols, rows: incomingTopology.rows } }
        : {}),
      ...(fieldTexture === undefined ? {} : { field: true }),
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

    const pass: DispatchPassDescriptor = {
      kind: "dispatch",
      id: `${nodeId}:kernel`,
      shader: module.wgsl,
      entryPoint: "main",
      workgroups: [Math.ceil(capacity / module.workgroupSize), 1, 1],
      buffers: module.buffers.map((binding) => {
        // T401: a shared attribute READS the upstream pair (the half holding this
        // frame's data, per the edge map) instead of this node's own last frame —
        // that is the entire processor mechanism, and codegen never knows. Binding
        // the upstream pair also makes this pass one of its consumers, so the §V22
        // swap lands after it (T297). Writes stay on this node's own pairs.
        const upstream = binding.role === "in" ? incoming?.pairs[binding.attribute] : undefined;
        if (upstream !== undefined) {
          return { binding: binding.variable, resourceId: upstream.pair, half: upstream.half };
        }
        return {
          binding: binding.variable,
          resourceId: pointPairId(nodeId, binding.attribute),
          // The generated module reads pre-frame values from `in_*` and writes post-frame
          // values to `out_*`; the pair's swap (after all consumers, §V22) makes this
          // frame's writes next frame's reads.
          half: binding.role === "in" ? ("read" as const) : ("write" as const),
        };
      }),
      uniforms: {
        timeSeconds: 0,
        deltaSeconds: 0,
        frameIndex: 0,
        seed: readNumber(parameters, "seed", 7),
        count: capacity,
        // T367: present exactly when the generated block declares it. The backend
        // overwrites it every frame from the SAME value the shared block gets (§V182);
        // this entry only reserves the name, because vgpu matches uniforms by name.
        ...(module.usesPointer ? { pointer: [0, 0, 0, 0] } : {}),
        // T479: one entry per slot the module declared, and the value is the RESOLVED
        // parameter — a driven slot arrives already channel-resolved, so the per-frame
        // recompile-and-diff path (T259/§V5) pushes it like any other uniform, with no
        // new machinery at all.
        ...pointKernelValueUniforms(module.usesValues, parameters),
        // T489 (B97): the absolute pair, reserved exactly when the module declared it —
        // same by-name mirroring hazard as the pointer above. The backend overwrites both
        // every frame from the numbers the shared block gets, so a kernel and a shader
        // cannot disagree about how long the show has run (§V182).
        ...(module.usesAbsClock ? { absTimeSeconds: 0, absFrameIndex: 0 } : {}),
      },
      // T477: exactly when the module declared the texture (§V288's mirror hazard —
      // vgpu binds by name, and a declared texture with no binding fails loudly).
      ...(module.usesField && fieldTexture !== undefined
        ? { textures: [{ binding: "fieldTexture", resourceId: fieldTexture.resource, sampled: "unfiltered" as const }] }
        : {}),
      uniformBinding: "kernelFrame",
      nodeId,
    };

    return {
      passes: [pass],
      // Structural declaration for the compiler's scratch handler once it learns
      // bufferPair entries (see module doc). Shape mirrors pointKernelResources().
      scratch: pointKernelResources(nodeId, attributes, capacity).map((resource) => ({
        key: resource.id.split(":").slice(2).join(":"),
        kind: "bufferPair" as const,
        stride: resource.stride,
        capacity: resource.capacity,
      })),
      // T296: the resolved edge payload. The kernel WRITES every declared attribute,
      // so every pair in the map is its own (§V197's "if you write it, you own it").
      pointsets: {
        out: {
          pairs: {
            // T401, §V197's narrowing verbatim: an attribute the incoming pointset
            // carries that this kernel's schema does NOT declare is UNMODIFIED — it
            // passes downstream BY REFERENCE, still the upstream's pair. The kernel
            // owns only what it writes; capacities are equal by the refusal above, so
            // the reference is coherent, and T297's binder-scan swap ownership makes
            // whoever binds it a consumer.
            ...Object.fromEntries(
              Object.entries(incoming?.pairs ?? {}).filter(
                ([name]) => !attributes.some((attribute) => attribute.name === name),
              ),
            ),
            ...Object.fromEntries(
              attributes.map((attribute) => [
                attribute.name,
                // §V168 through §V231: the kernel writes every pair this frame, so the
                // payload names each write half. `type` rides along for mapped
                // parameters (T286) — a consumer swizzles from it, never from a guess.
                { pair: pointPairId(nodeId, attribute.name), half: "write" as const, type: attribute.type },
              ]),
            ),
          },
          capacity,
          // Displacing positions never changes CONNECTIVITY: a torus grid through a
          // kernel is still a grid, so the upstream topology rides through (T401).
          topology: incoming?.topology ?? "points",
        },
      },
    };
  },
};


/**
 * T322: everything a renderer needs to draw a COUNTED edge (a producer whose live
 * count is GPU-resident): one tiny dispatch converting the count into indirect draw
 * arguments with the renderer's own per-instance vertex count baked in, the argument
 * buffer, and the `instances: { indirect }` value. Undefined for a static edge — the
 * caller keeps its literal count and this feature costs nothing.
 */

/**
 * T333: resolves a draw-time group predicate against the TYPED edge payload (§V308).
 *
 * The predicate references attributes as `p.<name>`; every referenced attribute is
 * bound on demand — WHICH dissolves the narrowness that originally excluded renderers
 * from T300: with types on the edge, a renderer's predicate language equals the
 * kernel's over stored attributes, no longer just "whatever this renderer binds".
 * Failures are §V288-shaped: by name, saying what the pointset provides.
 */
export function resolveGroupPredicate(
  nodeId: string,
  expression: string,
  pointset:
    | { pairs: Readonly<Record<string, { pair: string; half: "read" | "write"; type?: string }>> }
    | undefined,
):
  | {
      expression: string;
      binds: ReadonlyArray<{ attribute: string; type: string; pair: string; half: "read" | "write" }>;
    }
  | { refusal: CompiledNodeDescription } {
  const refuse = (message: string, suggestion?: string): { refusal: CompiledNodeDescription } => ({
    refusal: {
      passes: [],
      diagnostics: [
        {
          severity: "error",
          code: "node.points.group",
          message: `Node "${nodeId}": ${message}`,
          nodeId,
          ...(suggestion === undefined ? {} : { suggestion }),
        },
      ],
    },
  });
  const referenced = [...new Set([...expression.matchAll(/\bp\.([A-Za-z_]\w*)/g)].map((m) => m[1] as string))].sort();
  if (referenced.length === 0) {
    return refuse(
      `the group predicate references no attribute — write it over p.<attribute>, e.g. p.position.y > 0.0.`,
    );
  }
  const available = Object.keys(pointset?.pairs ?? {}).sort();
  const binds: Array<{ attribute: string; type: string; pair: string; half: "read" | "write" }> = [];
  for (const attribute of referenced) {
    const entry = pointset?.pairs[attribute];
    if (entry === undefined) {
      return refuse(
        `the group predicate reads "p.${attribute}", which the incoming pointset does not carry.`,
        available.length > 0 ? `It provides: ${available.join(", ")}.` : "Connect a producer first.",
      );
    }
    if (entry.type === undefined) {
      return refuse(`the group predicate reads "p.${attribute}", but the edge does not declare its type.`);
    }
    binds.push({ attribute, type: entry.type, pair: entry.pair, half: entry.half });
  }
  return { expression, binds };
}

/**
 * T364/T369: resolves a map on the COMPOUND HEAD `color` against the TYPED edge payload.
 *
 * ONE definition, because there are now two renderers that honour it (§V109): a refusal
 * worded differently on `renderPoints` and on `renderInstances` is two answers to the
 * same question, and the map's whole promise is that the same binding means the same
 * thing wherever a colour is drawn. Every failure is §V288-shaped — by name, saying what
 * the pointset actually provides — and there is no silent fall-back to the retained
 * static, which is the failure a per-point colour cannot show you (the picture stays
 * plausible; it is simply the wrong colour).
 *
 * `pointsPort` is the node's own pointset input id: §V306's `port` names WHICH pointset
 * when a node has several, and naming one that is not this node's is a mistake said out
 * loud rather than ignored.
 */
export function resolveColorMap(
  nodeId: string,
  binding: { attribute: string; channel?: string; port?: string } | undefined,
  pointset:
    | { pairs: Readonly<Record<string, { pair: string; half: "read" | "write"; type?: string }>> }
    | undefined,
  pointsPort: string,
  label: string = "color",
):
  | { map: { pair: string; half: "read" | "write" } | undefined }
  | { refusal: CompiledNodeDescription } {
  if (binding === undefined) return { map: undefined };
  const refuse = (message: string, suggestion?: string): { refusal: CompiledNodeDescription } => ({
    refusal: {
      passes: [],
      diagnostics: [
        {
          severity: "error",
          code: "node.parameter.map",
          message: `Node "${nodeId}": ${message}`,
          nodeId,
          ...(suggestion === undefined ? {} : { suggestion }),
        },
      ],
    },
  });
  if (binding.port !== undefined && binding.port !== pointsPort) {
    return refuse(`${label} maps port "${binding.port}", but the only pointset input is "${pointsPort}".`);
  }
  if (binding.channel !== undefined) {
    return refuse(
      `${label} maps the whole compound; a channel belongs on a component slot ("${label}.r"), not the head.`,
    );
  }
  const available = Object.keys(pointset?.pairs ?? {}).sort();
  const entry = pointset?.pairs[binding.attribute];
  if (entry === undefined) {
    return refuse(
      `${label} maps attribute "${binding.attribute}", which the incoming pointset does not carry.`,
      available.length > 0 ? `It provides: ${available.join(", ")}.` : "Connect a producer first.",
    );
  }
  if (entry.type === undefined) {
    return refuse(
      `${label} maps "${binding.attribute}", but the edge does not declare its type; the producer predates typed pairs.`,
    );
  }
  if (entry.type !== "vec4f") {
    return refuse(
      `${label} needs a vec4f attribute to map the whole compound; "${binding.attribute}" is ${entry.type}.`,
    );
  }
  return { map: { pair: entry.pair, half: entry.half } };
}

export function countedDrawSupport(
  nodeId: string,
  pointset: { count?: { buffer: string } } | undefined,
  options: {
    vertexCount: number;
    maxInstances: number;
    /** T478: distinct key per draw when ONE node owns several counted draws (a render
     *  with two counted geometries) — the scratch id is `scratch:{nodeId}:{key}`. */
    argsKey?: string;
  },
):
  | {
      instances: { indirect: string };
      argsPass: DispatchPassDescriptor;
      scratch: { kind: "buffer"; key: string; stride: number; capacity: number; usage: "indirect" };
    }
  | undefined {
  const count = pointset?.count;
  if (count === undefined) return undefined;
  const argsKey = options.argsKey ?? "drawArgs";
  const argsId = pointPairId(nodeId, argsKey);
  return {
    instances: { indirect: argsId },
    argsPass: {
      kind: "dispatch",
      id: `${nodeId}:${argsKey}`,
      shader: drawArgsWgsl(),
      entryPoint: "main",
      workgroups: [1, 1, 1],
      buffers: [
        { binding: "liveCount", resourceId: count.buffer },
        { binding: "drawArgs", resourceId: argsId },
      ],
      uniforms: { vertexCount: options.vertexCount, maxInstances: options.maxInstances },
      uniformBinding: "params",
      nodeId,
    },
    scratch: { kind: "buffer", key: argsKey, stride: 4, capacity: 4, usage: "indirect" },
  };
}

export const renderPointsNode: NodeDefinition = {
  type: "renderPoints",
  version: 1,
  title: "Render Points",
  category: "points",
  description: "Draws a point set as soft billboarded sprites into a texture. TD-style POP render.",
  tags: ["points", "particles", "sprites", "render"],
  inputs: [
    {
      id: "points",
      label: "Points",
      type: { kind: "pointset", requires: [{ name: "position", type: "vec3f" }] },
      description: "Needs a vec3f position attribute; everything else rides along.",
    },
  ],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  parameters: {
    count: {
      type: "number",
      label: "Count",
      default: 4096,
      min: 1,
      max: 1_000_000,
      step: 1,
      compileTime: true,
      description: "Instances drawn. Matches the producer's capacity until pointset edges carry it.",
    },
    sizePixels: {
      type: "number",
      label: "Size",
      default: 4,
      min: 0.5,
      max: 256,
      unit: "px",
      description: "Sprite diameter in output pixels.",
    },
    color: { type: "color", label: "Color", default: [1, 1, 1, 1], space: "display" },
    blend: {
      type: "enum",
      label: "Blend",
      default: "additive",
      options: [
        { value: "additive", label: "Additive" },
        { value: "alpha", label: "Alpha" },
      ],
      compileTime: true,
    },
    accumulate: {
      type: "boolean",
      label: "Accumulate",
      default: false,
      compileTime: true,
      description: "Skip the clear each frame — sprites pile up into trails (T180).",
    },
    group: {
      type: "string",
      label: "Group",
      default: "",
      compileTime: true,
      description:
        "T333: draw only matching points — a WGSL predicate over p.<attribute>, e.g. p.position.y > 0.0. Referenced attributes bind on demand from the edge. Empty = all.",
    },
  },
  resolutionPolicy: { kind: "project" },
  formatPolicy: { kind: "project" },
  compile(context): CompiledNodeDescription {
    const { nodeId, outputs, inputs, parameters, parameterMaps } = readCompileInputs(context);
    const target = outputs["out"];
    const points = inputs["points"];
    if (target === undefined || points === undefined) {
      const what = target === undefined ? 'output port "out"' : 'input port "points"';
      return { passes: [], diagnostics: [missingCompileResource(nodeId, what)] };
    }
    if (points.source === undefined) {
      return {
        passes: [],
        diagnostics: [
          {
            severity: "error",
            code: "node.points.source",
            message: `Node "${nodeId}": the points input carries no producer identity; per-attribute buffers cannot be located.`,
            nodeId,
          },
        ],
      };
    }

    const blend = parameters["blend"] === "alpha" ? ("alpha" as const) : ("additive" as const);

    // T286/T364 (§V288): map-mode parameters resolve against the EDGE — attribute
    // present, type coherent — or fail by name, saying what the pointset provides.
    // Never a silent fall-back to the retained static.
    const refuseMap = (message: string, suggestion?: string): CompiledNodeDescription => ({
      passes: [],
      diagnostics: [
        {
          severity: "error",
          code: "node.parameter.map",
          message: `Node "${nodeId}": ${message}`,
          nodeId,
          ...(suggestion === undefined ? {} : { suggestion }),
        },
      ],
    });
    type MapEntry = { pair: string; half: "read" | "write"; type?: string };
    const lookupMap = (
      key: string,
      binding: { attribute: string; channel?: string; port?: string },
    ): { entry: MapEntry; type: string } | CompiledNodeDescription => {
      // §V306: `port` names the pointset input when there are several; this node has
      // exactly one, so a port that is not it is a mistake said out loud.
      if (binding.port !== undefined && binding.port !== "points") {
        return refuseMap(`${key} maps port "${binding.port}", but the only pointset input is "points".`);
      }
      const available = Object.keys(points.pointset?.pairs ?? {}).sort();
      const entry = points.pointset?.pairs[binding.attribute];
      if (entry === undefined) {
        return refuseMap(
          `${key} maps attribute "${binding.attribute}", which the incoming pointset does not carry.`,
          available.length > 0 ? `It provides: ${available.join(", ")}.` : "Connect a producer first.",
        );
      }
      if (entry.type === undefined) {
        return refuseMap(
          `${key} maps "${binding.attribute}", but the edge does not declare its type; the producer predates typed pairs.`,
        );
      }
      return { entry, type: entry.type };
    };
    const isRefusal = (value: { entry: MapEntry } | CompiledNodeDescription): value is CompiledNodeDescription =>
      "passes" in value;

    // T333: the draw-time group. Excluded instances collapse to zero-area quads.
    const groupSource = typeof parameters["group"] === "string" ? parameters["group"].trim() : "";
    let groupPredicate:
      | { expression: string; binds: ReadonlyArray<{ attribute: string; type: string; pair: string; half: "read" | "write" }> }
      | undefined;
    if (groupSource !== "") {
      const resolvedGroup = resolveGroupPredicate(nodeId, groupSource, points.pointset);
      if ("refusal" in resolvedGroup) return resolvedGroup.refusal;
      groupPredicate = resolvedGroup;
    }

    // T369 (§V288, and §V109's "one answer"): renderInstances names a map it cannot
    // honour, so this renderer must too — a map on any OTHER key here (a `blend`, a
    // component slot like `color.r`) was silently ignored before, which is precisely the
    // parameter that looks mapped and is not.
    const unhonoured = Object.keys(parameterMaps)
      .filter((key) => key !== "color" && key !== "sizePixels")
      .sort();
    if (unhonoured.length > 0) {
      return {
        passes: [],
        diagnostics: unhonoured.map((key) => ({
          severity: "error" as const,
          code: "node.parameter.map",
          message: `Node "${nodeId}": ${key} is in map mode, but renderPoints maps only "color" and "sizePixels".`,
          nodeId,
          suggestion: "Switch it back to Constant, or drive it through the value graph instead.",
        })),
      };
    }

    const sizeMap = parameterMaps["sizePixels"];
    let mappedSize: { entry: MapEntry; type: string; channel?: string } | undefined;
    if (sizeMap !== undefined) {
      const found = lookupMap("sizePixels", sizeMap);
      if (isRefusal(found)) return found;
      const vectorChannels: Record<string, readonly string[]> = {
        vec2f: ["x", "y"],
        vec3f: ["x", "y", "z"],
        vec4f: ["x", "y", "z", "w"],
      };
      if (found.type === "f32") {
        if (sizeMap.channel !== undefined) {
          return refuseMap(`sizePixels maps f32 attribute "${sizeMap.attribute}" with a channel; an f32 has none.`);
        }
        mappedSize = found;
      } else if (vectorChannels[found.type] !== undefined) {
        const channels = vectorChannels[found.type] as readonly string[];
        if (sizeMap.channel === undefined || !channels.includes(sizeMap.channel)) {
          return refuseMap(
            `sizePixels maps ${found.type} attribute "${sizeMap.attribute}" and needs a channel (${channels.join("/")}).`,
          );
        }
        mappedSize = { ...found, channel: sizeMap.channel };
      } else {
        return refuseMap(
          `sizePixels cannot map "${sizeMap.attribute}" of type "${found.type}"; a size needs f32 or a float vector channel.`,
        );
      }
    }

    // T364 (§V195 as amended): a map on the COMPOUND HEAD, type-matched — a vec4f
    // attribute drives the whole colour. LINEAR by convention: attributes are data
    // (§V56/§V57); nothing display-decodes a per-point value. T369 moved the resolution
    // to `resolveColorMap` so renderInstances refuses in the SAME words (§V109).
    const resolvedColor = resolveColorMap(nodeId, parameterMaps["color"], points.pointset, "points");
    if ("refusal" in resolvedColor) return resolvedColor.refusal;
    const mappedColor = resolvedColor.map;
    // T322: a counted edge draws INDIRECTLY — the live count is GPU-resident, so a
    // tiny pass converts it to draw arguments and the draw reads them. A static edge
    // keeps the literal count (edge capacity clamped by the param).
    const counted = countedDrawSupport(nodeId, points.pointset, {
      vertexCount: 6,
      maxInstances: Math.max(1, Math.round(readNumber(parameters, "count", 4096))),
    });
    const pass: DrawPassDescriptor = {
      kind: "draw",
      id: `${nodeId}:sprites`,
      shader:
        mappedSize === undefined && mappedColor === undefined && groupPredicate === undefined
          ? SPRITE_RENDER_WGSL
          : spriteRenderWgsl({
              ...(mappedSize === undefined
                ? {}
                : {
                    sizeMap: {
                      type: mappedSize.type,
                      ...(mappedSize.channel === undefined ? {} : { channel: mappedSize.channel }),
                    },
                  }),
              ...(mappedColor === undefined ? {} : { colorMap: true }),
              ...(groupPredicate === undefined
                ? {}
                : {
                    group: {
                      expression: groupPredicate.expression,
                      binds: groupPredicate.binds.map(({ attribute, type }) => ({ attribute, type })),
                    },
                  }),
            }),
      target,
      topology: "triangle-list",
      // T296: instances = the EDGE's capacity, clamped by the count param — the user
      // no longer keeps two numbers in sync by hand.
      instances:
        counted?.instances ??
        Math.max(
          1,
          Math.min(
            Math.round(readNumber(parameters, "count", 4096)),
            points.pointset?.capacity ?? Math.round(readNumber(parameters, "count", 4096)),
          ),
        ),
      vertexCount: 6,
      buffers: [
        // The producer's position pair via the edge map, WRITE half: THIS frame's
        // positions (§V168) — whoever owns the pair (§V197, by-reference reads).
        {
          binding: "positions",
          resourceId: points.pointset?.pairs["position"]?.pair ?? pointPairId(points.source.nodeId, "position"),
          half: points.pointset?.pairs["position"]?.half ?? "write",
        },
        ...(mappedSize === undefined
          ? []
          : [{ binding: "mapSizes", resourceId: mappedSize.entry.pair, half: mappedSize.entry.half }]),
        ...(mappedColor === undefined
          ? []
          : [{ binding: "mapColors", resourceId: mappedColor.pair, half: mappedColor.half }]),
        ...(groupPredicate === undefined
          ? []
          : groupPredicate.binds.map((bind) => ({
              binding: `group_${bind.attribute}`,
              resourceId: bind.pair,
              half: bind.half,
            }))),
      ],
      // Mapped values LEAVE the uniform block entirely — the struct and the record
      // must keep matching exactly (the catalogue sweep pins that). Both mapped, the
      // block vanishes with the struct.
      ...(mappedSize !== undefined && mappedColor !== undefined
        ? {}
        : {
            uniforms: {
              ...(mappedColor === undefined ? { color: readColor(parameters, "color", [1, 1, 1, 1]) } : {}),
              ...(mappedSize === undefined ? { sizePixels: readNumber(parameters, "sizePixels", 4) } : {}),
            },
            uniformBinding: "params",
          }),
      sharedBinding: "frameU",
      blend,
      clear: parameters["accumulate"] !== true,
      nodeId,
    };
    return counted === undefined
      ? { passes: [pass] }
      : { passes: [counted.argsPass, pass], scratch: [counted.scratch] };
  },
};

/**
 * TextureToAttribute (T124): the TOP→POP bridge — sample a texture per point, write the
 * result as a point attribute. The first pointset consumer outside the family itself,
 * and what makes the two graphs ONE instrument: a Noise TOP driving particle colour,
 * a displacement field steering a sim.
 *
 * Ownership rule for pointset transforms: this node owns FRESH pairs for everything it
 * outputs (position copied through, `sample` written from the texture), because
 * downstream consumers derive pair ids from THEIR source's node id — a pointset node
 * that modified upstream pairs in place would break that derivation and alias state
 * across nodes.
 */
export const textureToAttributeNode: NodeDefinition = {
  type: "textureToAttribute",
  version: 1,
  title: "Texture To Attribute",
  category: "points",
  description: "Samples a texture at each point's position and writes it as a point attribute.",
  tags: ["points", "bridge", "texture", "sample"],
  inputs: [
    {
      id: "points",
      label: "Points",
      type: { kind: "pointset", requires: [{ name: "position", type: "vec3f" }] },
    },
    {
      id: "texture",
      label: "Texture",
      type: RGBA_TEXTURE,
      description: "Read with textureLoad — data fields (r32float displacement) work on baseline Tier B (§V57).",
    },
  ],
  outputs: [
    {
      id: "out",
      label: "Points",
      // Provides position (copied) plus the sampled value.
      type: {
        kind: "pointset",
        requires: [
          { name: "position", type: "vec3f" },
          { name: "sample", type: "vec4f" },
        ],
      },
    },
  ],
  parameters: {
    count: {
      type: "number",
      label: "Count",
      default: 4096,
      min: 1,
      max: 1_000_000,
      step: 1,
      compileTime: true,
      description: "Matches the producer's capacity until pointset edges carry it.",
    },
  },
  resolutionPolicy: { kind: "project" },
  formatPolicy: { kind: "project" },
  compile(context): CompiledNodeDescription {
    const { nodeId, inputs } = readCompileInputs(context);
    const points = inputs["points"];
    const texture = inputs["texture"];
    if (points === undefined || texture === undefined) {
      const what = points === undefined ? 'input port "points"' : 'input port "texture"';
      return { passes: [], diagnostics: [missingCompileResource(nodeId, what)] };
    }
    if (points.source === undefined) {
      return {
        passes: [],
        diagnostics: [
          {
            severity: "error",
            code: "node.points.source",
            message: `Node "${nodeId}": the points input carries no producer identity; per-attribute buffers cannot be located.`,
            nodeId,
          },
        ],
      };
    }

    // T296/§V197: capacity comes off the EDGE, and position passes BY REFERENCE — this
    // node writes only `sample`, so `sample` is the only pair it owns. The old
    // copy-everything shape existed purely for the id-derivation convention the edge
    // map replaces; its per-frame memcpy is simply gone.
    const upstream = points.pointset;
    const upstreamPosition = upstream?.pairs["position"];
    if (upstream === undefined || upstreamPosition === undefined) {
      return {
        passes: [],
        diagnostics: [
          {
            severity: "error",
            code: "node.points.edge",
            message: `Node "${nodeId}": the points edge carries no resolved position pair (producer predates T296?).`,
            nodeId,
          },
        ],
      };
    }
    const count = upstream.capacity;
    const pass: DispatchPassDescriptor = {
      kind: "dispatch",
      id: `${nodeId}:bridge`,
      shader: TEXTURE_TO_ATTRIBUTE_WGSL,
      entryPoint: "main",
      workgroups: [Math.ceil(count / 64), 1, 1],
      buffers: [
        // The producer's pair, WRITE half: this frame's positions, in plan order (§V168).
        { binding: "in_position", resourceId: upstreamPosition.pair, half: upstreamPosition.half },
        { binding: "out_sample", resourceId: pointPairId(nodeId, "sample"), half: "write" },
      ],
      textures: [{ binding: "sourceTexture", resourceId: texture.resource, sampled: "unfiltered" }],
      uniforms: { count },
      uniformBinding: "bridgeFrame",
      nodeId,
    };

    return {
      passes: [pass],
      scratch: [
        { key: "sample", kind: "bufferPair", stride: ATTRIBUTE_STRIDES["vec4f"], capacity: count },
      ],
      pointsets: {
        out: {
          pairs: { ...upstream.pairs, sample: { pair: pointPairId(nodeId, "sample"), half: "write" as const, type: "vec4f" } },
          capacity: count,
          ...(upstream.topology === undefined ? {} : { topology: upstream.topology }),
        },
      },
    };
  },
};

/**
 * T483 — the Ray POP: every point casts a ray against a HEIGHT FIELD and the hit comes
 * back as attributes, ready for the next kernel — GPU-resident per point, the owner's
 * "Ray POP not the SOP". Why a heightfield and not mesh intersection is argued on the
 * shader (`pointRayWgsl`); the short form: a displaced grid has no closed-form
 * intersection, brute force is P×2C, and a marched field is steps×P with the cost on a
 * parameter. Rays default straight down (rain onto terrain); a pointset carrying a
 * vec3f `direction` attribute aims each ray itself.
 */
export const pointRayNode: NodeDefinition = {
  type: "pointRay",
  version: 1,
  title: "Ray",
  category: "points",
  description:
    "Casts one ray per point against a height-field texture and writes hit, hitPosition, hitNormal and hitDistance as attributes. Cost = steps × points, every frame.",
  tags: ["points", "ray", "raycast", "collision", "heightfield"],
  inputs: [
    {
      id: "points",
      label: "Points",
      type: { kind: "pointset", requires: [{ name: "position", type: "vec3f" }] },
      description: "Ray origins. A vec3f `direction` attribute, when carried, aims each ray; otherwise the Direction parameter aims all of them.",
    },
    {
      id: "field",
      label: "Field",
      type: RGBA_TEXTURE,
      description:
        "The height field: R is height (y = r × Height Scale + Height Offset) over world x,z ∈ [−Extent, +Extent]. Read with textureLoad — r32float data fields work on Tier B (§V57).",
    },
  ],
  outputs: [
    {
      id: "out",
      label: "Points",
      type: {
        kind: "pointset",
        requires: [
          { name: "position", type: "vec3f" },
          { name: "hit", type: "f32" },
          { name: "hitPosition", type: "vec3f" },
          { name: "hitNormal", type: "vec3f" },
          { name: "hitDistance", type: "f32" },
        ],
      },
      description: "The same points, plus what each ray found. hit is 1 or 0; a miss carries the ray's end and the full distance.",
    },
  ],
  parameters: {
    steps: {
      type: "number",
      label: "Steps",
      default: 32,
      min: 1,
      max: 256,
      step: 1,
      compileTime: true,
      description: "March samples per ray. THE cost knob: steps × points texture reads per frame.",
    },
    maxDistance: { type: "number", label: "Max Distance", default: 8, min: 0.01, description: "Ray length in world units." },
    direction: {
      type: "vector",
      size: 3,
      label: "Direction",
      default: [0, -1, 0],
      description: "Every ray's direction — unless the incoming points carry a vec3f `direction` attribute, which wins.",
    },
    extent: {
      type: "number",
      label: "Extent",
      default: 4,
      min: 0.01,
      description: "The field spans world x,z ∈ [−extent, +extent]. Explicit, like the shadow volume (V426): nothing knows your scene's bounds.",
    },
    heightScale: { type: "number", label: "Height Scale", default: 1, description: "y = texel.r × scale + offset." },
    heightOffset: { type: "number", label: "Height Offset", default: 0 },
  },
  resolutionPolicy: { kind: "project" },
  formatPolicy: { kind: "project" },
  compile(context): CompiledNodeDescription {
    const { nodeId, inputs, parameters } = readCompileInputs(context);
    const points = inputs["points"];
    const field = inputs["field"];
    if (points === undefined || field === undefined) {
      const what = points === undefined ? 'input port "points"' : 'input port "field"';
      return { passes: [], diagnostics: [missingCompileResource(nodeId, what)] };
    }
    const upstream = points.pointset;
    const position = upstream?.pairs["position"];
    if (upstream === undefined || position === undefined) {
      return {
        passes: [],
        diagnostics: [
          {
            severity: "error",
            code: "node.points.edge",
            message: `Node "${nodeId}": the points edge carries no resolved position pair (producer predates T296?).`,
            nodeId,
          },
        ],
      };
    }
    if (upstream.count !== undefined) {
      return {
        passes: [],
        diagnostics: [
          {
            severity: "error",
            code: "node.points.input",
            message: `Node "${nodeId}": the incoming pointset carries a GPU live count; this ray pass runs a fixed capacity and would cast from the dead tail.`,
            nodeId,
            suggestion: "Ray a static set, or run the query inside the advanced kernel.",
          },
        ],
      };
    }
    // The direction ATTRIBUTE wins when the edge carries one of the right type; a wrong
    // type refuses rather than quietly falling back to the parameter (§V288).
    const carried = upstream.pairs["direction"];
    if (carried !== undefined && carried.type !== "vec3f") {
      return {
        passes: [],
        diagnostics: [
          {
            severity: "error",
            code: "node.points.input",
            message: `Node "${nodeId}": the incoming \`direction\` attribute is ${carried.type ?? "untyped"}, and a ray needs vec3f — falling back to the parameter would silently ignore wired data.`,
            nodeId,
          },
        ],
      };
    }
    const count = upstream.capacity;
    const steps = Math.max(1, Math.min(256, Math.round(readNumber(parameters, "steps", 32))));
    const direction = ((): readonly [number, number, number] => {
      const raw = parameters["direction"];
      const list = Array.isArray(raw) ? raw : [0, -1, 0];
      return [Number(list[0] ?? 0), Number(list[1] ?? -1), Number(list[2] ?? 0)];
    })();
    const pass: DispatchPassDescriptor = {
      kind: "dispatch",
      id: `${nodeId}:ray`,
      shader: pointRayWgsl({ steps, directionAttribute: carried !== undefined }),
      entryPoint: "main",
      workgroups: [Math.ceil(count / 64), 1, 1],
      buffers: [
        { binding: "in_position", resourceId: position.pair, half: position.half },
        ...(carried === undefined
          ? []
          : [{ binding: "in_direction", resourceId: carried.pair, half: carried.half }]),
        { binding: "out_hit", resourceId: pointPairId(nodeId, "hit"), half: "write" },
        { binding: "out_hitPosition", resourceId: pointPairId(nodeId, "hitPosition"), half: "write" },
        { binding: "out_hitNormal", resourceId: pointPairId(nodeId, "hitNormal"), half: "write" },
        { binding: "out_hitDistance", resourceId: pointPairId(nodeId, "hitDistance"), half: "write" },
      ],
      textures: [{ binding: "fieldTexture", resourceId: field.resource, sampled: "unfiltered" }],
      uniforms: {
        count,
        extent: Math.max(0.01, readNumber(parameters, "extent", 4)),
        heightScale: readNumber(parameters, "heightScale", 1),
        heightOffset: readNumber(parameters, "heightOffset", 0),
        maxDistance: Math.max(0.01, readNumber(parameters, "maxDistance", 8)),
        direction: [direction[0], direction[1], direction[2], 0],
      },
      uniformBinding: "rayFrame",
      nodeId,
    };

    return {
      passes: [pass],
      scratch: [
        { key: "hit", kind: "bufferPair", stride: ATTRIBUTE_STRIDES["f32"], capacity: count },
        { key: "hitPosition", kind: "bufferPair", stride: ATTRIBUTE_STRIDES["vec3f"], capacity: count },
        { key: "hitNormal", kind: "bufferPair", stride: ATTRIBUTE_STRIDES["vec3f"], capacity: count },
        { key: "hitDistance", kind: "bufferPair", stride: ATTRIBUTE_STRIDES["f32"], capacity: count },
      ],
      pointsets: {
        out: {
          pairs: {
            ...upstream.pairs,
            hit: { pair: pointPairId(nodeId, "hit"), half: "write" as const, type: "f32" },
            hitPosition: { pair: pointPairId(nodeId, "hitPosition"), half: "write" as const, type: "vec3f" },
            hitNormal: { pair: pointPairId(nodeId, "hitNormal"), half: "write" as const, type: "vec3f" },
            hitDistance: { pair: pointPairId(nodeId, "hitDistance"), half: "write" as const, type: "f32" },
          },
          capacity: count,
          ...(upstream.topology === undefined ? {} : { topology: upstream.topology }),
        },
      },
    };
  },
};

/**
 * Exported separately from `coreNodeDefinitions` until the compiler accepts
 * dispatch/draw emission and bufferPair scratch (see module doc).
 */
export const pointNodeDefinitions: readonly NodeDefinition[] = [
  pointKernelNode,
  pointRayNode,
  textureToAttributeNode,
  renderPointsNode,
];


