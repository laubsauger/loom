import { describe, expect, it } from "vitest";

import { compileGraph } from "../../../compiler/index.ts";
import { createNodeRegistry } from "../../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../../../nodes/definitions/index.ts";
import { cameraNode } from "../../../nodes/definitions/scene.ts";
import { createUniformAnimator } from "../../../app/animate-parameters.ts";
import { cameraPayloadMatrix, transformPoint } from "../../../domain/geometry/camera.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";
import type { CameraPayload } from "../../../domain/types/scene.ts";
import type { GraphDocument } from "../../../domain/types/graph.ts";

/**
 * B104/T500 — THE CAMERA LINK, GATED AS A PROPERTY RATHER THAN AS A SITE LIST (§V437).
 *
 * B104 was reported as "any of the camera parameters are not really reflecting in the
 * camera preview or in the output". The chain it accuses has seven joints — the camera
 * node's payload, the name resolution that synthesizes the edge (§V372/§V373),
 * `cameraPayloadMatrix`, the pass uniform, the values-only `updateUniforms` push (§V5),
 * the preview pass and the render pass — and a single dropped joint at any of them looks
 * identical from the outside: a picture that will not move.
 *
 * So this file does not test a fix. It gates the LINK, in the shape §V437 says a
 * requirement must be gated:
 *
 *  - the parameter list comes from `cameraNode.parameters`, and `VARIANTS` must name
 *    EVERY key. A camera parameter added tomorrow fails this file until someone says
 *    what driving it should do — it cannot be silently uncovered;
 *  - the consumer list is ENUMERATED from every definition whose `sourceReferences`
 *    feeds a `camera`-kind port. A fourth camera consumer is covered on the day it is
 *    declared, without editing this test — which is exactly what "a policy that holds
 *    for one consumer and not the next" (§V437) costs when it is not enumerated.
 *
 * The assertions are EXACT, in the idiom `scene-render.gpu.test.ts` already uses: a world
 * point is projected through the SAME matrix the plan carries, and the texel it lands on
 * is asserted to the byte. A camera that moved by a known amount puts a known colour at a
 * known pixel — and, crucially, leaves BACKGROUND at that pixel in the picture from
 * before it moved. That last clause is the one a frozen camera fails: an image that did
 * not change cannot have the object at the new place and nothing at the old.
 */

const SIZE = 64;

const SETTINGS = {
  outputResolution: { width: SIZE, height: SIZE },
  workingFormat: "rgba8unorm",
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
} as never;

const CAPABILITIES = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
} as never;

const registry = createNodeRegistry(allNodeDefinitions).view();

/** The base camera every case starts from. A 32x32 grid spans [-1,1] at z = 0. */
const BASE_CAMERA = { eye: [0, 0, 3] as const, lookAt: [0, 0, 0] as const };

const basePayload: CameraPayload = {
  kind: "camera",
  eye: [0, 0, 3],
  lookAt: [0, 0, 0],
  fovDeg: 55,
  near: 0.1,
  far: 100,
  ortho: false,
  orthoHeight: 2,
};

/**
 * What driving one camera parameter must DO to the picture.
 *
 * `moves` — the probe point lands somewhere else, and the old picture had BACKGROUND
 * there. `clips` — the probe point leaves the frustum entirely, so the pixel that held it
 * becomes background. Every key of `cameraNode.parameters` must appear here (asserted
 * below); the two shapes are what the seven parameters actually do, not a taxonomy.
 */
const VARIANTS: Readonly<
  Record<
    string,
    {
      readonly params: Record<string, unknown>;
      readonly probe: readonly [number, number, number];
      readonly effect: "moves" | "clips";
    }
  >
> = {
  eye: { params: { eye: [0, 0, 1.2] }, probe: [0.5, 0.5, 0], effect: "moves" },
  lookAt: { params: { lookAt: [-0.25, -0.25, 0] }, probe: [0.9, 0.9, 0], effect: "moves" },
  fov: { params: { fov: 25 }, probe: [0.5, 0.5, 0], effect: "moves" },
  ortho: { params: { ortho: true }, probe: [0.9, 0.9, 0], effect: "moves" },
  orthoHeight: { params: { ortho: true, orthoHeight: 1 }, probe: [0.4, 0.4, 0], effect: "moves" },
  // The grid sits exactly 3 away from the eye, so these two planes cut it wholesale.
  near: { params: { near: 3.5 }, probe: [0, 0, 0], effect: "clips" },
  far: { params: { far: 2.5 }, probe: [0, 0, 0], effect: "clips" },
};

/**
 * Exact shades, measured once and pinned (§V147).
 *  - `render` lights a flat grid straight down the view axis: albedo 0.8 x (0.12 ambient
 *    + |N.L| = 1) = 0.896 -> 228, the same number `scene-render.gpu.test.ts` derives.
 *  - the two legacy renderers shade their white surface flat-on at 170.
 * Both clear to black, so BACKGROUND is 0 in every channel.
 */
const OBJECT: Readonly<Record<string, number>> = {
  render: 228,
  renderSurface: 170,
  renderInstances: 170,
};
const BACKGROUND = 0;

/** Every node that names a camera through a reference parameter (§V372/§V373). */
function cameraConsumers(): ReadonlyArray<string> {
  const found: string[] = [];
  for (const definition of allNodeDefinitions) {
    for (const reference of definition.sourceReferences ?? []) {
      const port = definition.inputs.find((input) => input.id === reference.input);
      if (port?.type.kind === "camera" && !found.includes(definition.type)) found.push(definition.type);
    }
  }
  return found.sort();
}

const node = (id: string, type: string, parameters: Record<string, unknown>, label: string) => ({
  id,
  type,
  definitionVersion: 1,
  position: { x: 0, y: 0 },
  parameters,
  label,
});

function graphFor(consumer: string, cameraParams: Record<string, unknown>): GraphDocument {
  const shared = [
    node("grid", "pointGrid", { cols: 32, rows: 32 }, "grid1"),
    node("cam", "camera", { ...BASE_CAMERA, ...cameraParams }, "cam1"),
    node("out", "output", {}, "out1"),
  ];
  const edges: Record<string, unknown> = {
    e2: { id: "e2", source: { nodeId: "shot", portId: "out" }, target: { nodeId: "out", portId: "input" } },
  };
  const nodes =
    consumer === "render"
      ? [
          ...shared,
          node("geo", "geometry", { mode: "surface" }, "geo1"),
          node("sun", "light", { kind: "directional", direction: [0, 0, -1], intensity: 1 }, "sun1"),
          node("shot", "render", { scenes: "geo1", camera: "cam1", lights: "sun1" }, "shot1"),
        ]
      : [...shared, node("shot", consumer, { camera: "cam1" }, "shot1")];
  edges["e1"] =
    consumer === "render"
      ? { id: "e1", source: { nodeId: "grid", portId: "out" }, target: { nodeId: "geo", portId: "points" } }
      : { id: "e1", source: { nodeId: "grid", portId: "out" }, target: { nodeId: "shot", portId: "points" } };
  return {
    revision: 1,
    nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])),
    edges,
    groups: {},
  } as never;
}

/** The camera node alone, previewing itself — symptom (1) of B104. */
function previewGraph(cameraParams: Record<string, unknown>): GraphDocument {
  return {
    revision: 1,
    nodes: { cam: node("cam", "camera", { ...BASE_CAMERA, ...cameraParams }, "cam1") },
    edges: {},
    groups: {},
  } as never;
}

const FRAME = {
  frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "offline", randomSeed: 7 },
  pointer: { x: 0, y: 0, buttons: 0 },
  resolution: [SIZE, SIZE] as [number, number],
} as never;

function planFor(graph: GraphDocument, sinks?: ReadonlyArray<{ nodeId: string; portId: string }>) {
  const plan = compileGraph({
    graph,
    settings: SETTINGS,
    registry,
    capabilities: CAPABILITIES,
    ...(sinks === undefined ? {} : { sinks: sinks.map((sink) => ({ ...sink, kind: "preview" as const })) }),
  } as never);
  expect(plan.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
  return plan;
}

async function renderOnce(graph: GraphDocument, outputId: string): Promise<Uint8Array> {
  const backend = createVgpuBackend({ host: nodeGpuHost() });
  try {
    await backend.initialize({});
    const handle = await backend.compile(planFor(graph));
    backend.render(handle, FRAME);
    return (await backend.readOutput(outputId)).bytes;
  } finally {
    backend.dispose();
  }
}

/** The pixel a world point projects to under a camera matrix, and its red channel. */
function probeAt(matrix: Float32Array, world: readonly [number, number, number]) {
  const clip = transformPoint(matrix, world);
  const x = Math.round(((clip[0] / clip[3]) * 0.5 + 0.5) * SIZE);
  const y = Math.round((0.5 - (clip[1] / clip[3]) * 0.5) * SIZE);
  const inside = x >= 0 && y >= 0 && x < SIZE && y < SIZE;
  return { x, y, inside, at: (y * SIZE + x) * 4 };
}

const payloadWith = (params: Record<string, unknown>): CameraPayload => ({
  ...basePayload,
  ...(params["eye"] === undefined ? {} : { eye: params["eye"] as CameraPayload["eye"] }),
  ...(params["lookAt"] === undefined ? {} : { lookAt: params["lookAt"] as CameraPayload["lookAt"] }),
  ...(params["fov"] === undefined ? {} : { fovDeg: params["fov"] as number }),
  ...(params["near"] === undefined ? {} : { near: params["near"] as number }),
  ...(params["far"] === undefined ? {} : { far: params["far"] as number }),
  ...(params["ortho"] === undefined ? {} : { ortho: params["ortho"] as boolean }),
  ...(params["orthoHeight"] === undefined ? {} : { orthoHeight: params["orthoHeight"] as number }),
});

describe("the camera link, as a property (B104/T500, §V437, §V372, §V147)", () => {
  it("covers EVERY declared camera parameter and EVERY declared camera consumer", () => {
    // §V437's mechanism, not its moral: a parameter with no variant is a gap this file
    // must announce, and a consumer list that has quietly emptied is a green vacuum.
    expect(Object.keys(VARIANTS).sort()).toEqual(Object.keys(cameraNode.parameters).sort());
    expect(cameraConsumers()).toEqual(["render", "renderInstances", "renderSurface"]);
    for (const consumer of cameraConsumers()) expect(OBJECT[consumer]).toBeTypeOf("number");
  });

  it("a consumer's own copy of a camera parameter says it is inactive while a camera is named (§V146)", () => {
    // The other half of "the camera parameters are not reflecting in the output", and
    // the half no pixel can catch: `renderSurface` and `renderInstances` keep INLINE
    // eye/look/FOV for the unnamed case, and a NAMED camera replaces them wholesale
    // (T457). Editing one of those rows while a camera is named is a silent no-op —
    // exactly the shape §V146 exists to stop. Enumerated, so a fourth consumer that
    // ships its own inline camera is covered on the day it declares one.
    const cameraKeys = new Set(Object.keys(cameraNode.parameters));
    let checked = 0;
    for (const definition of allNodeDefinitions) {
      const reference = (definition.sourceReferences ?? []).find(
        (entry) => definition.inputs.find((input) => input.id === entry.input)?.type.kind === "camera",
      );
      if (reference === undefined) continue;
      for (const [key, parameter] of Object.entries(definition.parameters)) {
        // Its own duplicate of something the camera node owns — `camera` itself is the
        // reference, not a duplicate.
        if (key === reference.parameter || !cameraKeys.has(key)) continue;
        checked += 1;
        const named = { [reference.parameter]: "cam1" } as never;
        const unnamed = { [reference.parameter]: "" } as never;
        expect(
          { node: definition.type, key, named: parameter.inactiveWhen?.(named) ?? null },
          `${definition.type}.${key} is ignored while a camera is named, and does not say so`,
        ).toEqual({ node: definition.type, key, named: expect.any(String) });
        expect(
          { node: definition.type, key, unnamed: parameter.inactiveWhen?.(unnamed) ?? null },
          `${definition.type}.${key} claims to be inactive with NO camera named`,
        ).toEqual({ node: definition.type, key, unnamed: null });
      }
    }
    // A vacuum here would mean the enumeration stopped finding anything (§V449).
    expect(checked).toBeGreaterThanOrEqual(10);
  });

  it("every camera parameter moves the picture, in every camera consumer, to the byte", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const baseMatrix = cameraPayloadMatrix(basePayload, 1);
    for (const consumer of cameraConsumers()) {
      const object = OBJECT[consumer];
      if (object === undefined) throw new Error(`No pinned object shade for consumer "${consumer}".`);
      const base = await renderOnce(graphFor(consumer, {}), "target:shot:out");

      for (const [parameter, variant] of Object.entries(VARIANTS)) {
        const before = probeAt(baseMatrix, variant.probe);
        // The probe must be ON the object before the camera moves, or the case proves
        // nothing about the move (§V449's "guard that it actually went backwards").
        expect(
          { parameter, consumer, at: [before.x, before.y], value: base[before.at] },
          `probe for "${parameter}" is not on the object in the base view`,
        ).toEqual({ parameter, consumer, at: [before.x, before.y], value: object });

        const after = probeAt(cameraPayloadMatrix(payloadWith(variant.params), 1), variant.probe);
        const image = await renderOnce(graphFor(consumer, variant.params), "target:shot:out");

        if (variant.effect === "clips") {
          // The plane cut the geometry: the very texel that held it is background now.
          expect(
            { parameter, consumer, value: image[before.at] },
            `driving "${parameter}" did not clip the geometry`,
          ).toEqual({ parameter, consumer, value: BACKGROUND });
          continue;
        }

        // It MOVED — by a known amount, since `after` is the CPU's own projection.
        expect({ parameter, consumer, moved: after.at !== before.at }).toEqual({
          parameter,
          consumer,
          moved: true,
        });
        expect(after.inside, `probe for "${parameter}" left the frame; pick a nearer variant`).toBe(true);
        // (a) the object is at the place the matrix says it now is, and
        // (b) the picture from BEFORE the move has nothing there. A frozen camera —
        //     B104's whole symptom — passes (a) only by accident and fails (b) always.
        expect(
          { parameter, consumer, moved: image[after.at], stale: base[after.at] },
          `driving "${parameter}" did not move the picture in "${consumer}"`,
        ).toEqual({ parameter, consumer, moved: object, stale: BACKGROUND });
      }
    }
  }, 600_000);

  it("every camera parameter reaches the camera node's OWN preview", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const sinks = [{ nodeId: "cam", portId: "out" }];
    const previewId = "preview:scene:cam:out";

    const baseImage = await (async () => {
      const backend = createVgpuBackend({ host: nodeGpuHost() });
      try {
        await backend.initialize({});
        const handle = await backend.compile(planFor(previewGraph({}), sinks));
        backend.render(handle, FRAME);
        return (await backend.readOutput(previewId)).bytes;
      } finally {
        backend.dispose();
      }
    })();

    for (const [parameter, variant] of Object.entries(VARIANTS)) {
      const plan = planFor(previewGraph(variant.params), sinks);
      const pass = plan.passes.find((entry) => entry.id === "cam#scenePreview:out") as
        | { uniforms?: Record<string, unknown> }
        | undefined;
      // The uniform IS the matrix — exactly, float for float, computed independently
      // here. This is the joint between the payload and the pass (§V5: a camera change
      // is a uniform write), and it is asserted as a value rather than as a difference.
      expect(pass?.uniforms?.["viewProjection"], `preview uniform for "${parameter}"`).toEqual(
        Array.from(cameraPayloadMatrix(payloadWith(variant.params), 1)),
      );

      const backend = createVgpuBackend({ host: nodeGpuHost() });
      let image: Uint8Array;
      try {
        await backend.initialize({});
        const handle = await backend.compile(plan);
        backend.render(handle, FRAME);
        image = (await backend.readOutput(previewId)).bytes;
      } finally {
        backend.dispose();
      }
      // And the pass CONSUMES it: the uniform being right while the tile never repaints
      // is precisely half of what B104 reported.
      expect(
        { parameter, same: image.every((byte, index) => byte === baseImage[index]) },
        `the camera preview ignored "${parameter}"`,
      ).toEqual({ parameter, same: false });
    }
  }, 600_000);

  it("a camera change is a UNIFORM WRITE, never a rebuild — and the pixels are identical (§V5)", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    // The app's own path (`use-frame-loop.ts`): the structural plan is compiled once and
    // every later parameter edit is pushed through `updateUniforms`. If the camera lived
    // in the PLAN rather than in the uniform, this would freeze at the first build — the
    // failure mode B104 describes exactly.
    const basePlan = planFor(graphFor("render", {}));
    for (const [parameter, variant] of Object.entries(VARIANTS)) {
      const nextPlan = planFor(graphFor("render", variant.params));
      const fresh = await renderOnce(graphFor("render", variant.params), "target:shot:out");

      const backend = createVgpuBackend({ host: nodeGpuHost() });
      try {
        await backend.initialize({});
        const handle = await backend.compile(basePlan);
        backend.render(handle, FRAME);
        const written = createUniformAnimator().push(backend, basePlan, nextPlan);
        // `null` means the animator refused: the two plans are not values-only variations
        // of each other, so a camera edit would have cost a rebuild (§V5 broken).
        expect({ parameter, written }, `the camera edit "${parameter}" was not uniform-only`).toEqual({
          parameter,
          written: 1,
        });
        backend.render(handle, FRAME);
        const pushed = (await backend.readOutput("target:shot:out")).bytes;
        expect(
          { parameter, identical: pushed.every((byte, index) => byte === fresh[index]) },
          `the uniform push and a full recompile disagree for "${parameter}"`,
        ).toEqual({ parameter, identical: true });
      } finally {
        backend.dispose();
      }

      /*
       * The OTHER route to the same seam. `use-graph-compile.ts` only reports
       * `valuesOnly` when nothing else moved (a preview sink opening is enough to clear
       * it), so a camera edit also arrives at `backend.compile()` with a STRUCTURALLY
       * IDENTICAL plan — which the backend serves by reusing the program and syncing its
       * uniform blocks (§V5). A camera frozen there is the same bug through the other
       * door, so it is measured through the other door too.
       */
      const reused = createVgpuBackend({ host: nodeGpuHost() });
      try {
        await reused.initialize({});
        const first = await reused.compile(basePlan);
        reused.render(first, FRAME);
        void (await reused.readOutput("target:shot:out"));
        const second = await reused.compile(nextPlan);
        reused.render(second, FRAME);
        const again = (await reused.readOutput("target:shot:out")).bytes;
        expect(
          { parameter, identical: again.every((byte, index) => byte === fresh[index]) },
          `a structurally identical recompile kept the OLD camera for "${parameter}"`,
        ).toEqual({ parameter, identical: true });
      } finally {
        reused.dispose();
      }
    }
  }, 600_000);
});
