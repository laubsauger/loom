import type { NodeDefinition, CompiledNodeDescription } from "../../domain/types/node-definition.ts";
import type { EffectPassDescriptor } from "../../runtime/backend/plan.ts";
import { SHADER_SOURCE_PARAMETER } from "../../domain/commands/apply-patch.ts";
import { codeParametersLast } from "../../domain/parameters/code.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";
import { missingCompileResource, readCompileInputs } from "./compile-context.ts";
import { declaredNames, resolveSharedModules, SHARED_WGSL_MODULES } from "../shaders/shared-modules.ts";
import {
  declaresUniformBlock,
  reflectParamsStruct,
  reflectedParamCollisions,
  reflectedParamSchema,
  reflectedUniforms,
  remember,
  type ReflectedField,
} from "./params-reflection.ts";
import type { ParameterDefinition, ParameterSchema } from "../../domain/types/parameters.ts";
import type { RuntimeDiagnostic } from "../../domain/types/diagnostics.ts";
import {
  VIEW_CAMERA_FIELDS,
  VIEW_CAMERA_FIELD_NAMES,
  viewCameraDeclaration,
} from "../../domain/geometry/view-camera.ts";
import {
  CUSTOM_WGSL_DEFAULT_SOURCE,
  CUSTOM_WGSL_SAMPLER_BINDING,
  CUSTOM_WGSL_SHARED_BINDING,
  CUSTOM_WGSL_TEXTURE_BINDING,
  CUSTOM_WGSL_UNIFORM_BINDING,
} from "../shaders/custom-wgsl-default.wgsl.ts";
import { wgsl } from "../../runtime/backend/wgsl.ts";

/**
 * CustomWGSL — the user-authored fragment effect (T15, T166; §I custom WGSL node contract).
 *
 * One texture input, one texture output, resolution and format inherited from that input
 * — a filter has nowhere else sensible to get either from. Its shader text lives under
 * the conventional `source` string parameter: `SHADER_SOURCE_PARAMETER`, exported by
 * track B from `src/domain/commands/apply-patch.ts`, is the single source of truth for
 * that key name, so this manifest and the bus's `setShaderSource` patch op can never
 * drift apart. `source` is `compileTime: true` — editing it changes the shader
 * structurally and must force a rebuild, never a uniform-only update (§V5).
 *
 * WHAT A KERNEL RECEIVES (B7/T166). Four bindings, all matched by NAME:
 *
 *   `inputSampler` / `inputTexture` — the connected input.
 *   `frameU: SharedFrame`           — time, deltaTime, frameIndex, randomSeed,
 *                                     resolution, pointer, straight from
 *                                     `FrameEvaluationInput` (§V44). The ONLY clock a
 *                                     kernel can reach.
 *   `params: Params`                — this node's own parameters. `amount` today.
 *
 * Previously this node emitted neither `uniformBinding` nor `sharedBinding`, so the last
 * two arrived as nothing at all while the shipped default source cheerfully declared a
 * `Params` block for them. Both are wired now.
 *
 * DECLARED, THEN BOUND — never bound blindly. The runtime binds by name and refuses a
 * value with no matching declaration in the shader, so a kernel that does not declare
 * `params` (E2's Gray-Scott kernel is exactly that: all its constants are compile-time
 * `const`s) must not be handed one. `declaresUniformBlock` reads the source for the
 * declaration and the pass carries only what the source asked for. That check is a
 * deterministic scan of the text, not a WGSL parser: a full parse belongs with real
 * introspection — feeding a user-DECLARED struct's own fields — which is compiler work.
 */

/**
 * T900: `declaresUniformBlock` and `reflectParamsStruct` MOVED to `params-reflection.ts` when
 * the point kernels came onto this same reflection (§T900's "reuse, do not fork"). They are
 * re-exported here because this node's own tests read them off the node they document, and
 * because there must be exactly ONE reflector: a second copy would be two answers to "what
 * does `lightColor: vec4f` mean?" (§V349).
 */
export { declaresUniformBlock, reflectParamsStruct } from "./params-reflection.ts";

/** The always-present source editor — shared by the static fallback schema and the reflected one. */
const SOURCE_PARAM: ParameterDefinition = {
  type: "code",
  language: "wgsl",
  label: "Source",
  default: CUSTOM_WGSL_DEFAULT_SOURCE,
  compileTime: true,
  // T1210: the shipped default already declares the block, so this says what the block IS
  // rather than asking anybody to remember to write one — the point kernels' `kernel`
  // description has carried the same sentence since T900, and this node had none at all.
  description:
    "The fragment shader. YOUR OWN KNOBS: the source this node ships with ALREADY declares a `struct Params`, with a `// @default <literal>` and a describing comment per field — keep the block and add to it. Every field becomes a named, typed, drivable control on this node (`orbitSpeed: f32` a number, `lightColor: vec4f` a colour picker), read in the shader as params.<name>. A shader with no such block has no knobs at all. Time arrives only through the shared `frameU` block (§V44). WANT TO FLY AROUND IN IT? Declare `viewEye: vec3f`, `viewTarget: vec3f`, `viewFov: f32` and `viewOverride: f32` in the same block and build your ray from them behind `if (params.viewOverride > 0.5)`. That is the VIEW-CAMERA CONTRACT: the viewer then offers this node a viewport you can orbit, rendered into a target nothing else reads — your own picture, your own camera and your export are untouched.",
};

/**
 * The keys this node owns outright, which reflection may not take (T1059).
 *
 * `source` is the whole node: it is the CODE parameter the shader editor is mounted on. A
 * shader declaring `source: f32` in its own `struct Params` used to overwrite `SOURCE_PARAM`
 * with a number — the key survived and its code-ness did not, so the editor DISAPPEARED off
 * the node, with no error and no way back short of editing the file by hand. Somebody writing
 * a perfectly ordinary shader lost the box they wrote it in.
 *
 * §V908 — DERIVED FROM THE MANIFEST, WITH THE YIELD ENUMERATED, and that asymmetry is the
 * whole point of the shape. T1059 landed this as `new Set([SHADER_SOURCE_PARAMETER])`: a
 * hand-listed set of one, stating a CATEGORY ("the keys this node owns") as a MEMBER, which
 * is §V316's shape and §B45's. Adding a second node-owned parameter to the manifest would
 * not have added it here, and the reward for forgetting would have been T1059 again — silent,
 * because reflection overwrites without complaint. Derived, a forgotten yield is instead a
 * loud refusal on somebody's shader, which a reviewer resolves by naming it below.
 *
 * `amount` is the one yield. It is the historical static fallback rather than something this
 * node owns per-instance: E43/E45's §V147 identity is that a shader declaring `amount: f32`
 * reflects one control named Amount, and taking that name away would change what those
 * examples render.
 */
const CUSTOM_WGSL_YIELDED_KEYS: ReadonlySet<string> = new Set(["amount"]);

/**
 * The node's own parameters, as one object — the SEED reflection is spread onto AND the set
 * of names it may not take. `point-kernel-advanced.ts` has taken its `ownKeys` off its own
 * manifest this way since T900; this is the same move, and having one derivation feed both
 * halves is what makes "seeded but not reserved" unspellable rather than merely unlikely.
 *
 * Computed per call rather than hoisted, because it reads the manifest off `customWgslNode`
 * — declared below. Two entries filtered next to a WGSL scan costs nothing.
 */
function customWgslOwnParameters(): ParameterSchema {
  return Object.fromEntries(
    Object.entries(customWgslNode.parameters).filter(([key]) => !CUSTOM_WGSL_YIELDED_KEYS.has(key)),
  );
}

/** Exported for `custom-wgsl.test.ts`, which derives the owned set from the manifest the same way. */
export { CUSTOM_WGSL_YIELDED_KEYS };

/** The diagnostic this node refuses a name-stealing field under (§V288). */
const CUSTOM_WGSL_PARAM_CODE = "node.customWgsl.params";
/** T1286: a `// @use` line that names nothing, or that collides with the source's own. */
const CUSTOM_WGSL_MODULE_CODE = "node.customWgsl.module";
/** §T1311b(a): a half-declared view camera — the refuse-by-name code. */
const CUSTOM_WGSL_VIEW_CAMERA_CODE = "node.customWgsl.viewCamera";

/** The fields a source declares as controls — none at all unless it asks for the block. */
function reflectedFields(source: string): readonly ReflectedField[] {
  return declaresUniformBlock(source, CUSTOM_WGSL_UNIFORM_BINDING) ? reflectParamsStruct(source) : [];
}

/**
 * The schema a customWgsl node carries, reflected from its own `source` (T880).
 *
 * T1052: the reflected knobs sort ABOVE the editor they were read out of — the source pane
 * is the last thing on the node, so the controls the reflection exists to give you are not
 * below a screenful of WGSL. `codeParametersLast` is the manifest saying so; the inspector
 * still renders plain manifest order.
 *
 * T1059: `reflectedParamSchema` is the SAME guard the point kernels have had since T900, not a
 * second one — a field named after a key this node owns is dropped here and refused by name at
 * compile. The editor is seeded first and the reflection cannot reach it either way, so the way
 * out of a colliding shader is always still on the node.
 *
 * ⚑ T1177 — MEMOISED, AND WHAT IT BUYS IS OBJECT IDENTITY, NOT ARITHMETIC. §T1172 memoised
 * every SCAN under this (`declaresUniformBlock`, `reflectParamsStruct`), so what was left
 * here was three spreads — cheap, and it minted A FRESH `ParameterDefinition` PER KNOB PER
 * CALL. That is what a `React.memo` on a parameter row compares, so with it the inspector's
 * every row was a guaranteed miss and E55's two `customWgsl` nodes — 33 rows each — could
 * not be skipped no matter what else was stabilised.
 *
 * Same key, same cache, same rule as `params-reflection.ts`'s own memos (its docblock is
 * the reasoning, and this uses its `remember`): the key IS the bytes, so an edited source is
 * a different key and a hit can only be an answer about what was asked. ⚠ The value is
 * SHARED — a caller that mutated a returned schema would poison every other reader. That was
 * already the contract for `definition.parameters`, which is one object for the whole
 * process; this makes the reflected half behave the same way rather than differently.
 */
const schemasBySource = new Map<string, ParameterSchema>();

function reflectedSchema(source: string): ParameterSchema {
  const hit = schemasBySource.get(source);
  if (hit !== undefined) return hit;
  const own = customWgslOwnParameters();
  return remember(
    schemasBySource,
    source,
    codeParametersLast({
      ...own,
      ...reflectedParamSchema(reflectedFields(source), new Set(Object.keys(own))),
    }),
  );
}

export const customWgslNode: NodeDefinition = {
  type: "customWgsl",
  version: 1,
  title: "Custom WGSL",
  category: "shader",
  description: "A user-authored WGSL fragment effect (v1 contract, §I).",
  inputs: [{ id: "input", label: "Input", type: RGBA_TEXTURE }],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  /**
   * The STATIC fallback (T880): what a fresh drop and the type-only contexts (palette, help)
   * see — the source editor and the historical `amount`. A placed node's real controls come
   * from `parametersFor` below, reflected from its own shader.
   */
  parameters: codeParametersLast({
    [SHADER_SOURCE_PARAMETER]: SOURCE_PARAM,
    amount: {
      type: "number",
      label: "Amount",
      default: 1,
      min: 0,
      max: 1,
      range: "bounded",
      description: "Reaches the kernel as `params.amount`. Whatever your shader makes of it.",
    },
  }),
  /**
   * PER-INSTANCE reflection (T880, §V805): the node's controls ARE its shader's `struct
   * Params`. Declare `orbitSpeed: f32` or `lightColor: vec4f` and the knob appears — named,
   * typed, drivable and publishable — so a shader stops being a one-scalar black box. The
   * static schema above stays the fallback where there is no stored source to read.
   */
  parametersFor(stored) {
    const raw = stored[SHADER_SOURCE_PARAMETER];
    return reflectedSchema(typeof raw === "string" ? raw : CUSTOM_WGSL_DEFAULT_SOURCE);
  },
  resolutionPolicy: { kind: "inherit", input: "input" },
  formatPolicy: { kind: "inherit", input: "input" },
  compile(context): CompiledNodeDescription {
    const { nodeId, outputs, inputs, parameters } = readCompileInputs(context);
    const target = outputs["out"];
    const source = inputs["input"];
    if (target === undefined || source === undefined) {
      const what = target === undefined ? 'output port "out"' : 'input port "input"';
      return { passes: [], diagnostics: [missingCompileResource(nodeId, what)] };
    }

    const sourceValue = parameters[SHADER_SOURCE_PARAMETER];
    const shader = typeof sourceValue === "string" ? sourceValue : CUSTOM_WGSL_DEFAULT_SOURCE;
    const fields = reflectedFields(shader);

    /* T1059: a field that would take one of this node's own keys is refused BY NAME, the same
       way the point kernels refuse one (§V349). `parametersFor` has already dropped it from the
       schema so the editor survives — but a control that is silently absent is exactly the
       §V288 bug, and the shader is not going to do what its author wrote either way, because
       `source` in `params` would be handed the default 0 rather than their WGSL text. */
    const collisions = reflectedParamCollisions(
      nodeId,
      fields,
      new Set(Object.keys(customWgslOwnParameters())),
      CUSTOM_WGSL_PARAM_CODE,
    );
    if (collisions.length > 0) return { passes: [], diagnostics: collisions };

    /*
     * §T1311b(a) — THE VIEW-CAMERA CONTRACT, refused BY NAME when it is half-written.
     *
     * A shader that declares NONE of the four fields is the ordinary case and says nothing
     * here: most of the catalogue is 2D and has no camera to fly. A shader that declares
     * SOME of them is the author having MEANT to opt in, and it is the §V288 shape — the
     * viewer would offer no viewport and nothing would say why, so the missing or mistyped
     * fields are named. A WARNING and not an error: the piece itself renders perfectly
     * well without a viewport, and blanking somebody's picture over a camera typo would be
     * a worse failure than the one being reported.
     */
    const viewDiagnostics: RuntimeDiagnostic[] = [];
    const view = viewCameraDeclaration(fields);
    if (view.kind === "partial") {
      viewDiagnostics.push({
        severity: "warning",
        code: CUSTOM_WGSL_VIEW_CAMERA_CODE,
        message: `Node "${nodeId}": no view camera — ${view.reason}`,
        nodeId,
        suggestion:
          `Declare ${VIEW_CAMERA_FIELD_NAMES.map((name) => `\`${name}: ${VIEW_CAMERA_FIELDS[name]}\``).join(", ")} ` +
          "and branch on `params.viewOverride > 0.5` where the ray is built.",
      });
    }

    /*
     * T1286 — `// @use <name>` pulls named shared WGSL in front of this source.
     *
     * Resolved HERE rather than anywhere upstream, because the source string is opaque to
     * the compiler and that is load-bearing: everything above still sees one string, the
     * reflected controls are still read from what the author wrote, and the shared-uniform
     * contract is untouched (a module may not read `frameU`, see `shared-modules.ts`). What
     * the pass carries is the expansion.
     *
     * Both failure modes are refused BY NAME rather than tolerated, and they are different
     * bugs. A missing module means the author asked for code that does not exist and the
     * shader would compile without it — §V288's silent absence, and the worst outcome here,
     * because a Worley that is not there just makes a flat picture. A collision means the
     * module and the source both declare a name, and WGSL would take one of them: whichever
     * it takes, half the author's reading of their own file is wrong.
     */
    const shared = resolveSharedModules(shader);
    if (shared.missing.length > 0) {
      return {
        passes: [],
        diagnostics: shared.missing.map((name) => ({
          severity: "error" as const,
          code: CUSTOM_WGSL_MODULE_CODE,
          message:
            `Node "${nodeId}": \`// @use ${name}\` names a shared WGSL module that does not exist.`,
          nodeId,
          suggestion: `Shared modules: ${Object.keys(SHARED_WGSL_MODULES).join(", ")}.`,
        })),
      };
    }
    if (shared.names.length > 0) {
      const own = new Set(declaredNames(shader));
      const clashes = shared.names.flatMap((name) =>
        declaredNames(SHARED_WGSL_MODULES[name]!.source)
          .filter((declared) => own.has(declared))
          .map((declared) => ({ module: name, declared })),
      );
      if (clashes.length > 0) {
        return {
          passes: [],
          diagnostics: clashes.map(({ module, declared }) => ({
            severity: "error" as const,
            code: CUSTOM_WGSL_MODULE_CODE,
            message:
              `Node "${nodeId}": this source declares "${declared}", which the shared module ` +
              `"${module}" also declares — one of the two would be silently shadowed.`,
            nodeId,
            suggestion: `Rename yours, or drop \`// @use ${module}\` and keep your own.`,
          })),
        };
      }
    }
    /* ⚑ THE ONE PLACE A DOCUMENT'S OWN WGSL BECOMES A PASS (§T1335b). Both halves are
       stable strings from the store, so the tag's per-site trie hits on every frame the user
       is not typing — and on the frame they ARE typing, the key changes with the bytes,
       which is the invalidation rather than a policy about it. */
    const expanded = wgsl`${shared.prelude}${shader}`;

    // Bind EXACTLY the fields the shader's own `struct Params` declares (T880), each shaped to
    // its WGSL type. vgpu refuses a value with no matching field, and E43/E45's §V147 identity
    // depends on `amount` being the only thing bound to their kernels — so the set is read from
    // the source, never assumed. The values come from `parameters`, resolved against the SAME
    // reflected schema (the compiler resolves through `parametersFor`), so a driven or bound
    // control lands here.
    const uniforms: Record<string, number | readonly number[]> = reflectedUniforms(fields, parameters);

    const pass: EffectPassDescriptor = {
      kind: "effect",
      id: `${nodeId}:custom`,
      shader: expanded,
      target,
      textures: [{ binding: CUSTOM_WGSL_TEXTURE_BINDING, resourceId: source.resource }],
      samplers: [{ binding: CUSTOM_WGSL_SAMPLER_BINDING, resourceId: source.sampler }],
      ...(Object.keys(uniforms).length > 0
        ? { uniformBinding: CUSTOM_WGSL_UNIFORM_BINDING, uniforms }
        : {}),
      ...(declaresUniformBlock(expanded, CUSTOM_WGSL_SHARED_BINDING)
        ? { sharedBinding: CUSTOM_WGSL_SHARED_BINDING }
        : {}),
      nodeId,
      label: "Custom WGSL",
    };
    return viewDiagnostics.length === 0 ? { passes: [pass] } : { passes: [pass], diagnostics: viewDiagnostics };
  },
};
