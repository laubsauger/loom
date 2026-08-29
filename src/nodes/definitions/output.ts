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
 * No `resolutionPolicy`/`formatPolicy`: those describe how a node resolves its own output
 * ports, and Output has none — its render target is the project's designated output
 * surface, assigned by whatever owns `ProjectSettings`, not by a per-node policy here.
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
