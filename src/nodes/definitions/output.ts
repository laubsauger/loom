import type { NodeDefinition, CompiledNodeDescription } from "../../domain/types/node-definition.ts";
import type { EffectPassDescriptor } from "../../runtime/backend/plan.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";
import { missingCompileResource, readCompileInputs } from "./compile-context.ts";
import { SINK_TAG } from "./sink.ts";
import { OUTPUT_PASSTHROUGH_WGSL } from "../shaders/output-passthrough.wgsl.ts";

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
  parameters: {},
  // The project surface, not the input (B6/T165). An instance override still takes
  // precedence over both (§V50, §V51) — see the module doc.
  resolutionPolicy: { kind: "project" },
  formatPolicy: { kind: "project" },
  compile(context): CompiledNodeDescription {
    const { nodeId, inputs, target } = readCompileInputs(context);
    const source = inputs["input"];
    if (source === undefined || target === undefined) {
      const what = source === undefined ? 'input port "input"' : "its render target";
      return { passes: [], diagnostics: [missingCompileResource(nodeId, what)] };
    }

    const pass: EffectPassDescriptor = {
      kind: "effect",
      id: `${nodeId}:present`,
      shader: OUTPUT_PASSTHROUGH_WGSL,
      target,
      textures: [{ binding: "inputTexture", resourceId: source.resource }],
      samplers: [{ binding: "inputSampler", resourceId: source.sampler }],
      nodeId,
      label: "Output",
    };
    return { passes: [pass] };
  },
};
