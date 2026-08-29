import type { NodeDefinition } from "../../domain/types/node-definition.ts";
import { solidNode } from "./solid.ts";
import { customWgslNode } from "./custom-wgsl.ts";
import { outputNode } from "./output.ts";

export { solidNode } from "./solid.ts";
export { customWgslNode } from "./custom-wgsl.ts";
export { outputNode } from "./output.ts";
export { isSinkNode, SINK_TAG } from "./sink.ts";
export { RGBA_TEXTURE } from "./common-ports.ts";
export type { NodeCompileInputs } from "./compile-context.ts";
export { readCompileInputs, missingCompileResource } from "./compile-context.ts";

/** The Phase 0 spike catalogue (T15). Track K's node catalogue (T70, T40) adds to this. */
export const spikeNodeDefinitions: readonly NodeDefinition[] = [solidNode, customWgslNode, outputNode];
