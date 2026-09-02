import { createHash } from "node:crypto";

import { createUniformAnimator } from "../../app/animate-parameters.ts";
import { compileGraph } from "../../compiler/compile.ts";
import type { CompiledGraph } from "../../compiler/types.ts";
import type { ParameterResolution } from "../../compiler/validate.ts";
import { createGraphStore } from "../../domain/graph/store.ts";
import { createDomainBus } from "../../domain/commands/index.ts";
import type { GraphPatchOperation } from "../../domain/types/patch.ts";
import { createValueGraphSession } from "../../domain/channels/value-graph.ts";
import { effectiveParameterSchema } from "../../domain/parameters/resolve.ts";
import type { GraphDocument, ProjectSettings } from "../../domain/types/graph.ts";
import type { FrameEvaluationInput } from "../../domain/types/frame.ts";
import type { InvocationContext } from "../../domain/types/commands.ts";
import type { CookPolicy, ShaderloomBackend } from "../../runtime/backend/backend-types.ts";
import { createVgpuBackend } from "../../runtime/backend/vgpu/vgpu-backend.ts";
import { nodeGpuHost } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import type { NodeRegistryView } from "../../nodes/registry/registry.ts";

/**
 * The cook oracle (T249, §V157, §V147).
 *
 * The gate is built BEFORE the feature: every example is rendered under
 * `cookPolicy: "always"` and again under `"auto"`, through the SAME scripted edit
 * sequence, and the two runs must be byte-identical at EVERY frame index — not only
 * the last, because a one-frame lag (THE signature cooking failure) self-corrects by
 * the final frame and an end-state comparison would wave it through. Today the two
 * policies are the same code path and the oracle trivially holds; the moment T254's
 * gating lands under "auto", this is the thing that decides whether it may ship.
 *
 * The script hits every invalidation class the spec names: a parameter edit, an
 * animated-parameter flip, a rewire, a bypass, a feedback pulse, a mode switch, a
 * rename — each applied through the real bus at a fixed frame, so the run is a
 * deterministic little SESSION, not a static render. The fuzz variant draws extra
 * edits from a seeded generator, same seed in both runs.
 */

export interface ScriptedEdit {
  readonly frame: number;
  readonly label: string;
  /** Bus operations to apply, or a backend action (the feedback pulse). */
  readonly operations?: ReadonlyArray<GraphPatchOperation>;
  readonly backend?: (backend: ShaderloomBackend, plan: CompiledGraph) => void;
}

const ACTOR: InvocationContext = {
  actor: { kind: "human", id: "cook-oracle" },
  projectId: "cook-oracle",
  capabilities: [],
};

/**
 * A deterministic script derived from the document itself, so one generator covers
 * every example: targets are picked by sorted scan, and a step whose shape the graph
 * lacks (no feedback pair, no second number param) is simply skipped — identically in
 * both runs, which is all the oracle needs.
 */
export function scriptFor(graph: GraphDocument, registry: NodeRegistryView): ScriptedEdit[] {
  const script: ScriptedEdit[] = [];
  const nodeIds = Object.keys(graph.nodes).sort();

  interface NumberTarget {
    nodeId: string;
    key: string;
    min: number;
    max: number;
  }
  const numberTargets: NumberTarget[] = [];
  for (const nodeId of nodeIds) {
    const node = graph.nodes[nodeId];
    if (node === undefined) continue;
    const definition = registry.get(node.type);
    if (definition === undefined) continue;
    // T903: the funnel — the oracle animates a PLACED node's parameters, so a reflected
    // control is as animatable as a declared one and must appear in the target list.
    for (const [key, parameter] of Object.entries(effectiveParameterSchema(definition, node.parameters))) {
      if (parameter.type !== "number") continue;
      numberTargets.push({
        nodeId,
        key,
        min: parameter.min ?? 0,
        max: parameter.max ?? Math.max(1, parameter.default * 2),
      });
    }
  }

  const first = numberTargets[0];
  if (first !== undefined) {
    script.push({
      frame: 10,
      label: `param ${first.nodeId}.${first.key}`,
      operations: [
        {
          op: "setParameters",
          nodeId: first.nodeId,
          parameters: { [first.key]: (first.min + first.max) / 2 },
        },
      ],
    });
  }

  const speed =
    numberTargets.find((target) => target.key === "speed") ?? numberTargets[1] ?? first;
  if (speed !== undefined) {
    script.push({
      frame: 20,
      label: `speed ${speed.nodeId}.${speed.key} 0→1`,
      operations: [
        { op: "setParameters", nodeId: speed.nodeId, parameters: { [speed.key]: speed.min } },
      ],
    });
    script.push({
      frame: 25,
      label: `speed ${speed.nodeId}.${speed.key} back`,
      operations: [
        {
          op: "setParameters",
          nodeId: speed.nodeId,
          parameters: { [speed.key]: Math.min(speed.max, speed.min + 1) },
        },
      ],
    });
  }

  const edgeIds = Object.keys(graph.edges).sort();
  const rewire = edgeIds[0];
  const rewired = rewire === undefined ? undefined : graph.edges[rewire];
  if (rewire !== undefined && rewired !== undefined) {
    script.push({
      frame: 30,
      label: `disconnect ${rewire}`,
      operations: [{ op: "disconnect", edgeIds: [rewire] }],
    });
    script.push({
      frame: 35,
      label: `reconnect ${rewire}`,
      operations: [
        {
          op: "connect",
          source: { nodeId: rewired.source.nodeId, portId: rewired.source.portId },
          target: { nodeId: rewired.target.nodeId, portId: rewired.target.portId },
        },
      ],
    });
  }

  // Bypass something mid-chain: the first node with both inputs and outputs.
  const bypassable = nodeIds.find((nodeId) => {
    const node = graph.nodes[nodeId];
    const definition = node === undefined ? undefined : registry.get(node.type);
    return (
      definition !== undefined && definition.inputs.length > 0 && definition.outputs.length > 0
    );
  });
  if (bypassable !== undefined) {
    script.push({
      frame: 40,
      label: `bypass ${bypassable}`,
      operations: [{ op: "setNodeUi", nodeId: bypassable, ui: { bypassed: true } }],
    });
    script.push({
      frame: 45,
      label: `unbypass ${bypassable}`,
      operations: [{ op: "setNodeUi", nodeId: bypassable, ui: { bypassed: false } }],
    });
  }

  script.push({
    frame: 50,
    label: "feedback pulse",
    backend: (backend, plan) => {
      const pair = plan.feedback[0];
      if (pair !== undefined) backend.resetTemporalHistory([pair.resourceId]);
    },
  });

  if (first !== undefined) {
    script.push({
      frame: 60,
      label: `mode switch ${first.nodeId}.${first.key} → expression`,
      operations: [
        {
          op: "setParameters",
          nodeId: first.nodeId,
          parameters: {
            [first.key]: {
              mode: "expression",
              bindings: {
                expression: { kind: "expression", source: "time * 0.5" },
                static: { kind: "static", value: (first.min + first.max) / 2 },
              },
            },
          },
        },
      ],
    });
  }

  const renameTarget = nodeIds[0];
  if (renameTarget !== undefined) {
    script.push({
      frame: 70,
      label: `rename ${renameTarget}`,
      operations: [{ op: "setNodeLabel", nodeId: renameTarget, label: "oracleRenamed" }],
    });
  }

  return script;
}

/** mulberry32 — the deterministic generator for the fuzz variant. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seeded random parameter edits — the bus-fuzzed variant of the script. */
export function fuzzScript(
  graph: GraphDocument,
  registry: NodeRegistryView,
  seed: number,
  edits: number,
  frames: number,
): ScriptedEdit[] {
  const random = mulberry32(seed);
  const targets: Array<{ nodeId: string; key: string; min: number; max: number }> = [];
  for (const nodeId of Object.keys(graph.nodes).sort()) {
    const node = graph.nodes[nodeId];
    const definition = node === undefined ? undefined : registry.get(node.type);
    if (definition === undefined) continue;
    // T903: the funnel, for the same reason as `numberTargets` above.
    for (const [key, parameter] of Object.entries(effectiveParameterSchema(definition, node?.parameters ?? {}))) {
      if (parameter.type !== "number") continue;
      targets.push({ nodeId, key, min: parameter.min ?? 0, max: parameter.max ?? 1 });
    }
  }
  if (targets.length === 0) return [];

  const script: ScriptedEdit[] = [];
  for (let index = 0; index < edits; index += 1) {
    const target = targets[Math.floor(random() * targets.length)];
    if (target === undefined) continue;
    const frame = 1 + Math.floor(random() * (frames - 2));
    const value = target.min + random() * (target.max - target.min);
    script.push({
      frame,
      label: `fuzz ${target.nodeId}.${target.key}@${frame}`,
      operations: [
        { op: "setParameters", nodeId: target.nodeId, parameters: { [target.key]: value } },
      ],
    });
  }
  return script.sort((a, b) => a.frame - b.frame);
}

export interface OracleRunRequest {
  readonly graph: GraphDocument;
  readonly settings: ProjectSettings;
  readonly registry: NodeRegistryView;
  readonly policy: CookPolicy;
  readonly script: ReadonlyArray<ScriptedEdit>;
  readonly frames: number;
}

/**
 * One full run: seed a real store+bus with the example, then per frame apply the due
 * edits through the bus, recompile when the revision moved, render, and read the
 * output back. Returns one sha256 per frame — the whole picture, every frame.
 */
export async function renderUnderPolicy(request: OracleRunRequest): Promise<string[]> {
  const store = createGraphStore({ initialGraph: request.graph });
  const { bus } = createDomainBus({ store, registry: request.registry });
  const backend = createVgpuBackend({ host: nodeGpuHost() });
  const digests: string[] = [];
  /*
   * T633: the oracle evaluates the VALUE GRAPH, exactly as the live session and
   * `renderHeadless({ animate: true })` do. Without a resolver every driven parameter
   * fell back to its static value and a value-graph-only example hashed all frames
   * identical — E33's first build did exactly that, and the oracle could not tell "no
   * animation" from "animation the oracle cannot see", which is the one distinction it
   * exists to make.
   */
  const valueSession = createValueGraphSession(request.registry);
  const animator = createUniformAnimator();

  try {
    await backend.initialize({});
    backend.setCookPolicy(request.policy);

    const compileNow = (resolution?: ParameterResolution) =>
      compileGraph({
        graph: store.view.getGraph(),
        settings: request.settings,
        registry: request.registry,
        capabilities: {
          tier: "B",
          features: [],
          formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
          timestampQuery: false,
          limits: { maxTextureDimension2D: 8192 },
        },
        ...(resolution === undefined ? {} : { resolution }),
      });

    let plan = compileNow();
    let compiled = await backend.compile(plan);
    const outputId = (): string => {
      // T408 follow-up: "$target" is not unique — ANY sink owns one, and E14 is the
      // first example with two (its analyze meter and its output). Alphabetical find()
      // returned the METER's target, so the oracle digested a static side texture and
      // read every frame as identical — a reader-that-cannot-see, inside the oracle
      // itself. The document's `output` node is the picture; prefer it by type.
      const graph = store.view.getGraph();
      const sinkOutput =
        plan.outputs.find(
          (output) => output.portId === "$target" && graph.nodes[output.nodeId]?.type === "output",
        ) ?? plan.outputs.find((output) => output.portId === "$target");
      return sinkOutput?.resourceId ?? plan.outputs[0]?.resourceId ?? "";
    };

    for (let frameIndex = 0; frameIndex < request.frames; frameIndex += 1) {
      let edited = false;
      for (const edit of request.script) {
        if (edit.frame !== frameIndex) continue;
        if (edit.operations !== undefined) {
          const result = await bus.execute(
            "graph.applyPatch",
            { baseRevision: store.view.getRevision(), operations: [...edit.operations] },
            ACTOR,
          );
          if (result.status !== "applied") {
            throw new Error(`Oracle edit "${edit.label}" was ${result.status}: ${result.diagnostics.map((d) => d.message).join("; ")}`);
          }
          edited = true;
        }
        edit.backend?.(backend, plan);
      }
      if (edited) {
        plan = compileNow();
        compiled = await backend.compile(plan);
        // The per-frame push below diffs against the newest structural plan (§V5) —
        // reset together with it, as the live frame loop does.
        animator.reset();
      }

      const frame: FrameEvaluationInput & {
        mode: "offline";
        randomSeed: number;
      } = {
        timeSeconds: frameIndex / 60,
        deltaSeconds: frameIndex === 0 ? 0 : 1 / 60,
        frameIndex,
        mode: "offline",
        randomSeed: request.settings.randomSeed,
      };

      // T340's order, exactly as renderHeadless keeps it: channels advance, the
      // per-frame plan re-resolves, and only changed VALUES are pushed (§V5).
      const evaluated = valueSession.evaluate(store.view.getGraph(), frame);
      const next = compileNow({ frame, channels: evaluated.resolver });
      animator.push(backend, plan, next);

      backend.render(compiled, {
        frame,
        pointer: { x: 0, y: 0, buttons: 0 },
        resolution: [request.settings.outputResolution.width, request.settings.outputResolution.height],
      });

      const image = await backend.readOutput(outputId());
      digests.push(createHash("sha256").update(image.bytes).digest("hex"));
    }
  } finally {
    backend.dispose();
  }
  return digests;
}
