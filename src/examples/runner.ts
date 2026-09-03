import { compileGraph } from "../compiler/index.ts";
import type { CompiledGraph } from "../compiler/index.ts";
import { loadProject } from "../domain/project/index.ts";
import { createComponentSystem } from "../domain/components/registry.ts";
import type { ComponentRegistryView } from "../domain/components/index.ts";
import type { UnknownNodePlaceholder } from "../domain/project/index.ts";
import type { BackendCapabilities, FrameInputs } from "../domain/types/backend.ts";
import type { RuntimeDiagnostic } from "../domain/types/diagnostics.ts";
import type { ProjectDocument } from "../domain/types/graph.ts";
import type { NodeRegistryView } from "../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import { createVgpuBackend } from "../runtime/backend/index.ts";
import { readExecutionPlan, planUniformValues } from "../runtime/backend/plan.ts";
import type { PlanReadResult } from "../runtime/backend/plan.ts";
import { sharedUniformsFromFrame } from "../runtime/backend/shared-uniforms.ts";
import { mockGpuHost } from "../runtime/backend/vgpu/mock-gpu-host.ts";
import type { ExampleFile } from "./catalogue.ts";

/**
 * Loading, compiling and stepping an example (T157).
 *
 * §V88 is why `loadProject` appears here rather than a fixture: the example goes through
 * the SAME loader a user's file goes through, from the same bytes, with the same registry
 * the app builds. §V89 is why this is a gate and not a report — a broken example means the
 * format regressed, a manifest changed incompatibly, or the compiler broke, and each of
 * those is a release blocker.
 *
 * The registry is the WHOLE catalogue (`allNodeDefinitions`). Assembling a subset here
 * would let an example that uses a node the app never registers still pass.
 */

/** Tier B baseline (§C "decided"): the weakest device an example is allowed to need. */
export const TIER_B_CAPABILITIES: BackendCapabilities = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
};

export function exampleRegistry(): NodeRegistryView {
  return createNodeRegistry(allNodeDefinitions).view();
}

export interface RunExampleResult {
  readonly fileName: string;
  /** Diagnostics from `loadProject`: migrations, unknown parameters, clamping. */
  readonly loadDiagnostics: readonly RuntimeDiagnostic[];
  /** Undefined when the file did not parse at all; `reason` then says why. */
  readonly document: ProjectDocument | undefined;
  readonly reason: string | undefined;
  /** True when the loaded document differs from the file: something migrated or clamped. */
  readonly changed: boolean;
  /** Node types this build does not have (§V10). An example must never produce one. */
  readonly placeholders: readonly UnknownNodePlaceholder[];
  readonly plan: CompiledGraph | undefined;
  readonly read: PlanReadResult | undefined;
  /** T956: the file's own embedded component library, for harness renders. */
  readonly components?: ComponentRegistryView;
  /**
   * The COMPONENT-AWARE node registry this example was compiled with — handed back
   * together with `components` because the two are one object and a caller that takes
   * only `document` and re-derives a bare `exampleRegistry()` compiles a DIFFERENT
   * graph than the one this function validated.
   *
   * §V854 (T1066 — the orchestrator assigns): the cook oracle did exactly
   * that. E47 and E51 instantiate library components, the bare registry has no
   * `component:...` type, so both examples
   * compiled to `compiler/unknown-node-type` + a severed output edge — E51 to ZERO
   * passes, E47 to one — and the oracle digested an untouched black target, identical
   * at every frame. Its policy claim was vacuous for those two; only the non-vacuity
   * guard could see it, and it did.
   *
   * `components` is the half the COMPILE needs; this `nodes` view is the half every
   * OTHER reader needs — enumerate a graph's parameters or ports through a bare view
   * and a component instance is simply not a node. Both, or neither.
   */
  readonly nodes?: NodeRegistryView;
}

/** Load + compile one example. Never throws: a failure is a result the gate can name. */
export function runExample(file: ExampleFile): RunExampleResult {
  /* T956: an example may EMBED library components (the hologram instances DepthPoints),
     so loading goes through the component-aware pair — the file's own componentLibrary
     registers into `components`, and the compile flattens the instances. An example
     with no library pays nothing. */
  const { components, nodes: registry } = createComponentSystem(exampleRegistry());
  const loaded = loadProject(file.text, { nodes: registry, components });

  if (!loaded.ok) {
    return {
      fileName: file.fileName,
      loadDiagnostics: loaded.diagnostics,
      document: undefined,
      reason: loaded.reason,
      changed: false,
      placeholders: [],
      plan: undefined,
      read: undefined,
    };
  }

  const plan = compileGraph({
    graph: loaded.document.graph,
    settings: loaded.document.settings,
    registry,
    capabilities: TIER_B_CAPABILITIES,
    components: components.view(),
  });

  return {
    fileName: file.fileName,
    loadDiagnostics: loaded.diagnostics,
    document: loaded.document,
    reason: undefined,
    changed: loaded.changed,
    placeholders: loaded.placeholders,
    plan,
    read: readExecutionPlan(plan),
    components: components.view(),
    nodes: registry,
  };
}

/** `runExample`, with the two "this cannot have happened" cases turned into a throw. */
export function requireExample(file: ExampleFile): {
  document: ProjectDocument;
  plan: CompiledGraph;
  result: RunExampleResult;
} {
  const result = runExample(file);
  if (result.document === undefined || result.plan === undefined) {
    throw new Error(`${file.fileName} did not load: ${result.reason ?? "unknown reason"}`);
  }
  return { document: result.document, plan: result.plan, result };
}

export function errorsOf(diagnostics: readonly RuntimeDiagnostic[]): string[] {
  return diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code}: ${d.message}`);
}

/** Every diagnostic, formatted. The gate asserts this is empty — see `runner.test.ts`. */
export function messagesOf(diagnostics: readonly RuntimeDiagnostic[]): string[] {
  return diagnostics
    .filter((d) => d.severity !== "info")
    .map((d) => `${d.severity} ${d.code}: ${d.message}`);
}

/**
 * The fixed frame sequence every determinism check replays (§V45, §V89).
 *
 * `mode: "offline"` with an exact `deltaSeconds` is the whole point: a wall-clock delta
 * would make the sequence depend on how fast the machine ran it, which is precisely what
 * is being ruled out. `randomSeed` comes from the project, so an example that re-seeds
 * itself changes its own frames and nothing else does.
 */
export function frameSequence(document: ProjectDocument, frameCount: number): readonly FrameInputs[] {
  const resolution: readonly [number, number] = [
    document.settings.outputResolution.width,
    document.settings.outputResolution.height,
  ];
  return Array.from({ length: frameCount }, (_unused, frameIndex) => ({
    frame: {
      timeSeconds: frameIndex / 60,
      deltaSeconds: 1 / 60,
      frameIndex,
      mode: "offline" as const,
      randomSeed: document.settings.randomSeed,
    },
    pointer: { x: 0, y: 0, buttons: 0 },
    resolution,
  }));
}

/**
 * Everything that reaches the GPU for one frame, as a comparable string.
 *
 * A plan's per-pass uniforms are compile-time constants (§V21), so they are captured once
 * and are the same for every frame. What varies per frame is the shared frame block, which
 * is the ONLY route time takes into a shader (§V44). Digesting the two together gives a
 * sequence that changes if either the plan or the frame contract changes, and is identical
 * across runs if neither does.
 *
 * This describes GPU STATE, not an image. Nothing here is a pixel — see `renderTrace`.
 */
export function frameStateDigest(plan: CompiledGraph, inputs: FrameInputs): string {
  const uniforms = [...planUniformValues(plan.passes).entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return JSON.stringify({
    shared: sharedUniformsFromFrame(inputs),
    passes: plan.passes.map((pass) => [pass.kind, pass.id]),
    uniforms,
  });
}

/** Command-level counters after each frame of a replay, plus anything the backend said. */
export interface RenderTrace {
  /** One snapshot per rendered frame, taken after that frame was submitted. */
  readonly snapshots: readonly Readonly<Record<string, number>>[];
  readonly framesSubmitted: number;
  readonly diagnostics: readonly string[];
}

/**
 * Builds and steps an example's plan on the mock device (`vgpu/mock`, via the backend
 * adapter — §V3 keeps the vgpu import over there, not here).
 *
 * WHAT THIS PROVES: that the backend can actually construct every resource, shader module
 * and pipeline the plan names, and that stepping a fixed frame sequence issues the same
 * COMMANDS every time. That is a real gate — it is what catches a plan the compiler is
 * happy with and the backend cannot build, and it is how §V8 (no allocation inside the
 * frame loop) is observable at all.
 *
 * WHAT THIS DOES NOT PROVE: pixels. The mock device executes no shaders, so a readback
 * comes back as zeroes and comparing images here would be a test that looks like it checks
 * rendering and does not. Pixel-level parity is the Dawn headless track's gate (§V47), not
 * this one.
 */
export async function renderTrace(
  plan: CompiledGraph,
  document: ProjectDocument,
  frameCount: number,
): Promise<RenderTrace> {
  const host = mockGpuHost();
  const backend = createVgpuBackend({ host });
  const diagnostics: string[] = [];
  backend.onDiagnostic((d) => {
    if (d.severity !== "info") diagnostics.push(`${d.severity} ${d.code}: ${d.message}`);
  });

  try {
    // §V47: no canvas. Headless is the default path for an example, not a fallback.
    await backend.initialize({});
    const compiled = await backend.compile(plan);
    const snapshots: Record<string, number>[] = [];
    for (const inputs of frameSequence(document, frameCount)) {
      backend.render(compiled, inputs);
      snapshots.push({ ...host.instrumentation?.calls });
    }
    return { snapshots, framesSubmitted: backend.status.framesSubmitted, diagnostics };
  } finally {
    backend.dispose();
  }
}
