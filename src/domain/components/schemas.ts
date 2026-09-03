import { z } from "zod";
import type { GraphComponentDefinition } from "../types/components.ts";
import type { ParameterDefinition } from "../types/parameters.ts";
import { graphDocumentSchema, parameterValueSchema } from "../types/schemas.ts";

/**
 * The serialized surface of a component (T128, §V10).
 *
 * Same rule as everywhere else: zod guards the file boundary only, the live types stay in
 * the .ts contract. A component definition is the one thing in the project that is both
 * authored by a user and INSTALLED from elsewhere, so it is exactly the shape that has to
 * survive a version it was not written for.
 */

export const COMPONENT_SCHEMA_VERSION = 1;

const parameterBase = {
  label: z.string(),
  group: z.string().optional(),
  description: z.string().optional(),
  animatable: z.boolean().optional(),
  compileTime: z.boolean().optional(),
};

/**
 * §B111's declaration, on the numeric arms (T856, §V802).
 *
 * It was MISSING, and the failure was invisible: zod strips an unnamed key silently, so
 * `graphComponentDefinitionSchema.safeParse` ACCEPTED a definition carrying `range` and
 * returned one without it. `load.ts` installs `parsed.data` — the stripped copy — and a
 * save writes from the live catalogue, so opening `AudioLevel.loom.json` and saving it
 * back DROPPED `range: "floor"` from the file while reporting `changed === false`.
 *
 * Absent means `bounded` (the documented default), so the loss is not inert: a published
 * knob declared `floor` — max is travel, not a limit — silently became one that CLAMPS at
 * its travel. That is §T823's defect returning through the load path instead of the
 * slider, and §T848's assertion (c) is what found it.
 *
 * `component-sync` was asking whether the schema ACCEPTS the definition and passing.
 * Acceptance is not survival, which is why §V802 gates the round trip instead.
 */
const numericRange = z.enum(["bounded", "cyclic", "floor", "soft"]).optional();

export const parameterDefinitionSchema = z.discriminatedUnion("type", [
  z.object({
    ...parameterBase,
    type: z.literal("number"),
    default: z.number(),
    min: z.number().optional(),
    max: z.number().optional(),
    range: numericRange,
    step: z.number().optional(),
    scale: z.enum(["linear", "log"]).optional(),
    unit: z.enum(["px", "percent", "degrees", "radians", "seconds", "hz"]).optional(),
    precision: z.number().optional(),
  }),
  z.object({ ...parameterBase, type: z.literal("boolean"), default: z.boolean() }),
  z.object({
    ...parameterBase,
    type: z.literal("enum"),
    default: z.string(),
    options: z.array(z.object({ value: z.string(), label: z.string() })),
  }),
  z.object({
    ...parameterBase,
    type: z.literal("color"),
    default: z.tuple([z.number(), z.number(), z.number(), z.number()]),
    space: z.enum(["linear", "display"]),
  }),
  z.object({
    ...parameterBase,
    type: z.literal("vector"),
    size: z.union([z.literal(2), z.literal(3), z.literal(4)]),
    default: z.array(z.number()),
    min: z.number().optional(),
    max: z.number().optional(),
    range: numericRange,
    step: z.number().optional(),
  }),
  z.object({
    ...parameterBase,
    type: z.literal("string"),
    default: z.string(),
    multiline: z.boolean().optional(),
  }),
  // T856 follow-up. The arm was MISSING, and unlike §B111's stripped `range` this one
  // was not a lost key but a lost COMPONENT: a discriminated union with no arm for
  // `code` fails the whole parse, so `parseComponentDefinition` refused the definition
  // outright and `load.ts` dropped it from the library. Nine code parameters ship today
  // (customWgsl, midiIn, the point kernels), and `component.publishParameter` takes any
  // `ParameterDefinition`, so publishing one produced a component that would not load.
  z.object({
    ...parameterBase,
    type: z.literal("code"),
    language: z.enum(["wgsl", "json"]),
    default: z.string(),
  }),
  z.object({
    ...parameterBase,
    type: z.literal("asset"),
    kind: z.enum(["image", "video", "audio", "gltf", "binary"]),
  }),
  z.object({
    ...parameterBase,
    type: z.literal("curve"),
    default: z.array(z.object({ x: z.number(), y: z.number() })),
  }),
  z.object({
    ...parameterBase,
    type: z.literal("stops"),
    default: z.array(
      z.object({
        position: z.number(),
        color: z.tuple([z.number(), z.number(), z.number(), z.number()]),
      }),
    ),
    space: z.enum(["linear", "display"]),
    maxStops: z.number().int().positive().optional(),
  }),
  // A pulse has no `default` — it fires, it does not hold (§V124). It carries the bus
  // command it fires instead, which is data and therefore survives a round trip.
  z.object({
    ...parameterBase,
    type: z.literal("pulse"),
    fires: z.string().min(1),
    input: z.record(z.unknown()).optional(),
  }),
]);

/**
 * §V316 PIN — the arm list against the TS union, so the `code` hole cannot come back.
 *
 * The one-arm fix above only resets the clock: nothing in the language ties a
 * `z.discriminatedUnion` to the type it stands for, which is why ten arms sat against an
 * eleven-member union with a green `tsc`. `satisfies z.ZodType<ParameterDefinition>` is
 * not the pin — zod widens optionals to `T | undefined` and `exactOptionalPropertyTypes`
 * rejects that, the same friction `parseComponentDefinition` documents below — so the
 * pin is on the DISCRIMINATOR SET, which is the axis the bug was on.
 *
 * Adding a twelfth `ParameterDefinition` member makes `_armsAreExhaustive` an object
 * type and `= true` stops compiling, naming the missing arm in the error text.
 */
type SchemaArmType = z.infer<typeof parameterDefinitionSchema>["type"];
type ArmCoverage =
  [Exclude<ParameterDefinition["type"], SchemaArmType>] extends [never]
    ? [Exclude<SchemaArmType, ParameterDefinition["type"]>] extends [never]
      ? true
      : { armWithNoParameterDefinitionMember: Exclude<SchemaArmType, ParameterDefinition["type"]> }
    : { parameterDefinitionMemberWithNoArm: Exclude<ParameterDefinition["type"], SchemaArmType> };
const _armsAreExhaustive: ArmCoverage = true;
void _armsAreExhaustive;

export const exposedPortSchema = z.object({
  externalId: z.string().min(1),
  label: z.string(),
  nodeId: z.string().min(1),
  portId: z.string().min(1),
});

export const publishedParameterSchema = z.object({
  key: z.string().min(1),
  definition: parameterDefinitionSchema,
  // Several targets is the normal case, not the exception (§V80).
  targets: z.array(z.object({ nodeId: z.string().min(1), key: z.string().min(1) })),
});

export const componentMigrationSchema = z.object({
  fromVersion: z.number().int().positive(),
  toVersion: z.number().int().positive(),
  description: z.string(),
});

export const capabilityRequirementSchema = z.object({
  feature: z.string(),
  reason: z.string(),
});

export const graphComponentDefinitionSchema = z.object({
  // No "@": it separates id from version in the node type, so an id containing one would
  // make an instance's type ambiguous.
  componentId: z.string().min(1).refine((id) => !id.includes("@"), {
    message: 'A componentId may not contain "@".',
  }),
  version: z.number().int().positive(),
  name: z.string().min(1),
  description: z.string().optional(),
  graph: graphDocumentSchema,
  inputs: z.array(exposedPortSchema),
  outputs: z.array(exposedPortSchema),
  parameters: z.array(publishedParameterSchema),
  capabilities: z.array(capabilityRequirementSchema).optional(),
  migrations: z.array(componentMigrationSchema).optional(),
});

/** An instance's own state. `version` is the pin; a newer definition never moves it (§V84). */
export const componentInstanceStateSchema = z.object({
  componentId: z.string().min(1),
  version: z.number().int().positive(),
  parameters: z.record(parameterValueSchema),
  overrides: z.record(parameterValueSchema).optional(),
});

/** A component library as it is saved beside a project or shipped as a package. */
export const componentLibrarySchema = z.object({
  schemaVersion: z.number().int().positive(),
  components: z.array(graphComponentDefinitionSchema),
});

export type ParsedComponentDefinition = z.infer<typeof graphComponentDefinitionSchema>;
export type ParsedComponentLibrary = z.infer<typeof componentLibrarySchema>;

export type ComponentParseResult =
  | { ok: true; definition: GraphComponentDefinition }
  | { ok: false; issues: readonly string[] };

/**
 * Validated parse.
 *
 * The cast is the standard friction between zod's `T | undefined` optionals and
 * `exactOptionalPropertyTypes`: zod omits absent keys at runtime, it only widens them in
 * the type. Everything the cast asserts has just been checked by the schema above.
 */
export function parseComponentDefinition(value: unknown): ComponentParseResult {
  const parsed = graphComponentDefinitionSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    };
  }
  return { ok: true, definition: parsed.data as GraphComponentDefinition };
}

export function serializeComponentLibrary(
  definitions: readonly GraphComponentDefinition[],
): ParsedComponentLibrary {
  // T977 follow-up — CANONICAL ORDER AT THE FUNNEL, because two callers disagreed:
  // the example generator hands this its registration order while the app's save hands
  // it `components.all()` (sorted), and §V802's load→save byte gate caught the drift
  // the moment a document carried two components. Sorting HERE makes every writer
  // agree, whatever order its caller collected in.
  const ordered = [...definitions].sort(
    (a, b) => a.componentId.localeCompare(b.componentId) || a.version - b.version,
  );
  return {
    schemaVersion: COMPONENT_SCHEMA_VERSION,
    components: ordered as ParsedComponentLibrary["components"],
  };
}
