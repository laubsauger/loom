import type { NodeDefinition, CompiledNodeDescription } from "../../domain/types/node-definition.ts";
import type { EffectPassDescriptor } from "../../runtime/backend/plan.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";
import { missingCompileResource, readCompileInputs } from "./compile-context.ts";
import { SINK_TAG } from "./sink.ts";
import { outputDisplayShader } from "../shaders/output-passthrough.wgsl.ts";
import { TONE_MAP_OPTIONS, isToneMapOperator, sinkDisplayTransform } from "../../domain/color/display.ts";
import type { ToneMapOperator } from "../../domain/color/display.ts";

/**
 * Output — the viewer sink (T15; TD "Out" family).
 *
 * One texture input, no outputs. A branch that reaches an Output node is an ACTIVE SINK
 * the compiler must keep even with zero downstream consumers (§V25) — declared explicitly
 * via the `sink` tag (see `./sink.ts`), never inferred from "has no outputs": a dangling,
 * unconnected filter node also has no outputs wired up, and that one IS meant to be
 * pruned. Inferring from port shape would conflate the two.
 *
 * RESOLUTION AND FORMAT (B6/T165, §V21, §V50, §V51). Output HAS no output ports, but it
 * does have a render target, and the compiler sizes that target with the same propagation
 * every other node goes through (the sink's target is materialized under the reserved
 * `$target` port). Declaring no policy therefore did not mean "the project decides" — it
 * meant "fall through to the primary input", which is how E5 came to present a 2048x2048
 * surface for a 1280x720 project. The policy below is the node's own doc made executable:
 * the target IS the project's designated output surface, so it says `{ kind: "project" }`
 * for both size and format.
 *
 * A per-instance override still wins, deliberately: `resolveNodeResolution` /
 * `resolveNodeFormat` put the instance override ahead of the definition policy, and §V50
 * says the user may override any node. Rendering the final image at a different size from
 * the project (a downscaled preview surface, an oversampled still for export) is a real
 * thing to want. What changes is only the DEFAULT — the project, not whatever happens to
 * be plugged in.
 *
 * COLOUR (T375, B47, §V56, §V70a). This is the node the project's `displayTransform`
 * belongs to, and until T375 nothing read it: the sink passed linear light straight to a
 * canvas the compositor treats as sRGB, so the viewer was measurably darker than every
 * other view of the same texture. `sinkDisplayTransform` decides, the compiler asks the
 * same module to publish this target's `space`, and every downstream consumer reads that
 * declaration rather than guessing (§V57).
 *
 * TONE MAP (T474, §V56, §V186b). §V56 said "encode + tonemap ONLY @ output|display node"
 * from the start and only the encode half was ever built, while the default working format
 * is `rgba16float`. A final value above 1 hard-clipped at `encodeDisplay` with no roll-off
 * available anywhere. (E4 Bloom is NOT an instance: measured, its composite arrives here at
 * 0.9692 linear and no pixel exceeds 1 — the over-range values live between `level` and
 * `add`, not at the sink.) The `toneMap` parameter below is the missing half — and
 * it is the node's ONLY parameter, because the rule this node's own doc states is that any
 * other transform belongs to a visible upstream node. There is no exposure knob here; a
 * gain is a Level node, which is what E4 already uses.
 *
 * The curve is `compileTime` (§V5, §V141): it selects shader TEXT, exactly as Composite's
 * blend operation does. That also makes "`none` moves nobody's pixels" structural rather
 * than numerical — the shader string for `none` is the identical constant it always was.
 */
export const outputNode: NodeDefinition = {
  type: "output",
  version: 1,
  title: "Output",
  category: "output",
  description: "Presents its input as the viewable/exportable render target.",
  // First-class field, read by the compiler's active-sink trace (§V25). The SINK_TAG
  // below predates it and is kept for the isSinkNode() helper; `sink` is what prunes on.
  sink: true,
  tags: [SINK_TAG],
  inputs: [{ id: "input", label: "Input", type: RGBA_TEXTURE }],
  outputs: [],
  parameters: {
    toneMap: {
      type: "enum",
      label: "Tone map",
      default: "none",
      options: [...TONE_MAP_OPTIONS],
      // §V141: this selects the SHADER, not a per-pixel branch on a value that changes
      // approximately never — and it keeps `none` byte-identical to every frame this app
      // has ever rendered, since the shader text is unchanged rather than merely equivalent.
      compileTime: true,
      description:
        "Rolls HDR values off instead of clipping them. `none` clamps above 1 (today's behaviour). Reinhard is x/(1+x) per channel — never clips, no shoulder, flattens contrast. Filmic is Narkowicz's fit of the ACES RRT+ODT: a toe and a shoulder, more contrast, and NOT the ACES pipeline — there is no AP1 transform and no output device transform. Runs on linear light, before the sRGB encode; off entirely when the project's display transform is `none` or the target carries `data`.",
    },
  },
  // The project surface, not the input (B6/T165). An instance override still takes
  // precedence over both (§V50, §V51) — see the module doc.
  resolutionPolicy: { kind: "project" },
  formatPolicy: { kind: "project" },
  compile(context): CompiledNodeDescription {
    const { nodeId, inputs, target, format, space, colorPolicy, parameters } = readCompileInputs(context);
    const source = inputs["input"];
    if (source === undefined || target === undefined) {
      const what = source === undefined ? 'input port "input"' : "its render target";
      return { passes: [], diagnostics: [missingCompileResource(nodeId, what)] };
    }

    const requested: ToneMapOperator = isToneMapOperator(parameters["toneMap"])
      ? parameters["toneMap"]
      : "none";
    const transform = sinkDisplayTransform(colorPolicy, format, space, requested);
    const pass: EffectPassDescriptor = {
      kind: "effect",
      // The curve is part of the structure, so it belongs in the key that decides whether
      // the pipeline is rebuilt (§V5) — Composite's `${nodeId}:${blend}:${n}` precedent.
      // SUFFIXED ONLY WHEN THERE IS A CURVE, deliberately: `none` keeps the id it has
      // always had, so upgrading moves no existing project's structural key any more than
      // it moves its pixels. The three ids are still distinct, which is all §V5 asks.
      id: transform.toneMap === "none" ? `${nodeId}:present` : `${nodeId}:present:${transform.toneMap}`,
      shader: outputDisplayShader(transform),
      target,
      textures: [{ binding: "inputTexture", resourceId: source.resource }],
      samplers: [{ binding: "inputSampler", resourceId: source.sampler }],
      nodeId,
      label: "Output",
    };
    // §V288: a parameter the pixels do not honour must say so, not sit there looking
    // applied. Both cases are legitimate settings, not mistakes, so this is INFO — but a
    // user who set a curve and saw no change deserves to be told which switch outranked it.
    if (requested !== "none" && transform.toneMap === "none") {
      const why =
        space === "data"
          ? "the target carries `data`, which never converts (§V56)"
          : 'the project\'s display transform is "none", which means raw values out';
      return {
        passes: [pass],
        diagnostics: [
          {
            severity: "info",
            code: "output.toneMapInactive",
            message: `Output "${nodeId}" asks for the ${requested} tone map and is not applying it: ${why}.`,
            nodeId,
          },
        ],
      };
    }
    return { passes: [pass] };
  },
};
