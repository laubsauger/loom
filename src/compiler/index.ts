/**
 * The graph compiler (§P track E, T24-T33).
 *
 * Turns a `GraphDocument` into a `LogicalExecutionPlan` the backend can build, plus the
 * structured diagnostics the problems tab and the agent tools read. Headless and pure:
 * nothing here touches the DOM, React or the GPU.
 */
export { compileGraph } from "./compile.ts";
export { CompilerDiagnosticCode, compilerDiagnostic, hasError } from "./diagnostics.ts";
export type { CompilerDiagnosticCodeValue, DiagnosticDetails } from "./diagnostics.ts";

export {
  COMPONENT_ID_SEPARATOR,
  componentPathOf,
  flattenComponents,
  flattenedNodeId,
  redirectSink,
  withSourcePath,
} from "./flatten.ts";
export type { ComponentSource, FlatEndpoint, FlattenRequest, FlattenedGraph } from "./flatten.ts";

export {
  resolveNodeParameters,
  resolveParameterValues,
  validateGraph,
  validateRequiredInputs,
  isTemporalOutput,
} from "./validate.ts";
export type { ParameterResolution, ResolvedNode, ValidatedGraph } from "./validate.ts";

export { orderNodes } from "./topology.ts";
export type { TopologyResult } from "./topology.ts";

export { isDeclaredSink, pruneToActiveSinks, resolveSinks } from "./prune.ts";
export type { PruneResult, SinkResolution } from "./prune.ts";

export { effectiveMaxResolution, resolveNodeResolution } from "./resolution.ts";
export type { ResolutionInputs, ResolutionOutcome, ResolutionRequest, ResolutionSource } from "./resolution.ts";

export { isDepthFormat, resolveNodeFormat } from "./format.ts";
export type { FormatInputs, FormatOutcome, FormatRequest, FormatSource } from "./format.ts";

export { colorSpaceForFormat, resolveColorSpace } from "./color-space.ts";
export type { ColorSpace, ColorSpaceOutcome, ColorSpaceRequest } from "./color-space.ts";

export { SHARED_SAMPLER_ID, pingPongResourceId, swapPassId, targetResourceId } from "./resources.ts";

export {
  classifyEdit,
  diffPlans,
  downstreamOf,
  feedbackToReset,
  isUniformOnlyChange,
  targetsToRecreate,
} from "./recompile.ts";
export type { ClassifyContext, GraphEdit, PlanDiff, RecompileDecision, RecompileWork } from "./recompile.ts";

export { asCompilerContext, outputKey } from "./types.ts";
export type {
  ActiveSink,
  CompileEdge,
  CompileRequest,
  CompiledGraph,
  CompiledInputBinding,
  CompiledOutputBinding,
  CompilerNodeContext,
  FeedbackPair,
  PlanEntrySignature,
  ResolvedOutput,
  SinkKind,
} from "./types.ts";
