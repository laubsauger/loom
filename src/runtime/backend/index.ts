/**
 * The GPU backend module — the sole vgpu boundary (§I.backend, §V3).
 *
 * Nothing outside `src/runtime/backend/vgpu/**` imports vgpu; the rest of the app depends
 * only on `RenderBackend` (frozen contract) and the additions in `backend-types.ts`.
 */
export type {
  BackendStatus,
  BuildStats,
  FrameLoopControl,
  FrameLoopSettings,
  MediaSource,
  MediaSourceFrame,
  PresentableCanvas,
  PresentationHandle,
  PresentationOptions,
  PresentationReport,
  PreviewHostHandle,
  ShaderCompileResult,
  ShaderloomBackend,
  UniformUpdate,
} from "./backend-types.ts";

export {
  BackendDiagnosticCode,
  backendDiagnostic,
  createDiagnosticHub,
  describeError,
} from "./diagnostics.ts";
export type {
  BackendDiagnosticCodeValue,
  DiagnosticHub,
  DiagnosticListener,
} from "./diagnostics.ts";

export { FrameEncodingViolation, createFrameGuard } from "./frame-guard.ts";
export type { FrameGuard } from "./frame-guard.ts";

export {
  planStructureSignature,
  planUniformValues,
  readExecutionPlan,
} from "./plan.ts";
export type {
  EffectPassDescriptor,
  PassDescriptor,
  PingPongResourceDescriptor,
  PlanReadResult,
  ResourceDescriptor,
  SamplerBindingDescriptor,
  SamplerResourceDescriptor,
  SwapPassDescriptor,
  TargetResourceDescriptor,
  TextureBindingDescriptor,
  UniformValue,
  UniformValues,
} from "./plan.ts";

export {
  SHARED_UNIFORMS_WGSL,
  initialSharedUniforms,
  sharedUniformsFromFrame,
} from "./shared-uniforms.ts";
export type { SharedUniformValues } from "./shared-uniforms.ts";

export { createVgpuBackend } from "./vgpu/vgpu-backend.ts";
export type { VgpuBackend, VgpuBackendOptions } from "./vgpu/vgpu-backend.ts";
export { browserGpuHost } from "./vgpu/gpu-host.ts";
export type { DeviceLossInfo, GpuHost, GpuSession } from "./vgpu/gpu-host.ts";
export { meetsBaseline } from "./vgpu/capabilities.ts";
