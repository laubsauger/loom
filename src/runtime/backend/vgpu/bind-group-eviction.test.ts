import v8 from "node:v8";
import vm from "node:vm";

import { describe, expect, it } from "vitest";
import { effect } from "vgpu";

import { mockGpuHost } from "./mock-gpu-host.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";
import { fixturePlan } from "./plan-fixture.ts";
import { createPreviewSystem } from "../../previews/system.ts";
import { DEFAULT_PREVIEW_VIEW } from "../../previews/types.ts";
import type { PreviewRequest } from "../../previews/types.ts";
import type { PassDescriptor } from "../plan.ts";
import type { FrameEvaluationInput } from "../../../domain/types/frame.ts";

/**
 * T1180 — GPUBindGroup OBJECTS MUST NOT ACCUMULATE OVER A SESSION.
 *
 * §T1174 measured the leak with a closed-loop camera: cycle N does byte-identical work to
 * cycle 1, so cycle 1 is the control for cycle N in the same run on the same machine. Its
 * observable was `createBindGroup` CALLS, and that is the wrong one for the fix — a rebuilt
 * program mints new bind groups either way. What leaks is the RETAINED set: entries the
 * gpu's one bind-group cache can never reach again.
 *
 * So this measures reachability. Every GPUBindGroup the mock returns is held only by a
 * WeakRef; after a forced GC the survivors are exactly the ones vgpu's cache still holds.
 * The mock's own descriptor arrays are dropped first — it retains every descriptor it was
 * ever handed, and that harness-only growth is what sold §T1174's first run a 2.65x curve
 * that was 100% artefact.
 *
 * Both tests carry a SAME-RUN CONTROL (§V929): the identical scenario runs once with the
 * patched `evictBindGroups` removed from the Effect prototype and once with it. The control
 * must grow, or the scenario is not exercising the leak and the green means nothing; the
 * treatment must be flat. That pairing is also what fails if `patches/vgpu.patch` is ever
 * dropped on a version bump — the method vanishes and the treatment starts growing too.
 *
 * The two leak shapes are different and both are here:
 *
 *  - a LIVE drawable whose binding slot ROTATES (the tile blit, re-pointed at every tile of
 *    every composite). vgpu's eviction subscription follows the SLOT, so `set()`ing the next
 *    tile unsubscribes the previous one and its cache entry outlives the target's destroy.
 *  - a DISCARDED drawable whose bound resources SURVIVE (a shader edit on a pass with no
 *    uniform block). Nothing it names is destroyed, so nothing evicts it.
 */

/**
 * A precise GC, without demanding `--expose-gc` of the whole suite.
 *
 * The alternative is `execArgv` in `vitest.workspace.ts`, which every other project and
 * track pays for. `setFlagsFromString` + a fresh context is the local equivalent and the
 * flag is turned straight back off.
 */
function exposeGc(): () => void {
  v8.setFlagsFromString("--expose-gc");
  const gc = vm.runInNewContext("gc") as unknown;
  v8.setFlagsFromString("--no-expose-gc");
  if (typeof gc !== "function") throw new Error("could not obtain a GC handle for the retention measurement");
  return gc as () => void;
}

/** The prototype `evictBindGroups` lives on, taken from a real instance on a throwaway device. */
async function effectPrototype(): Promise<Record<string, unknown>> {
  const session = await mockGpuHost().create({} as never);
  const probe = effect(session.gpu, `@fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f { return vec4f(uv, 0.0, 1.0); }`);
  return Object.getPrototypeOf(probe) as Record<string, unknown>;
}

interface Retention {
  /** Live GPUBindGroups after each measured step. */
  readonly samples: readonly number[];
  readonly created: number;
}

/** Wraps the live mock device so every bind group it mints is held ONLY by a WeakRef. */
function trackBindGroups(host: ReturnType<typeof mockGpuHost>): {
  retained: (gc: () => void) => Promise<number>;
  created: () => number;
} {
  const device = host.device as unknown as { createBindGroup: (descriptor: unknown) => object };
  const original = device.createBindGroup.bind(device);
  const refs: Array<WeakRef<object>> = [];
  let created = 0;
  device.createBindGroup = (descriptor: unknown): object => {
    const bindGroup = original(descriptor);
    created += 1;
    refs.push(new WeakRef(bindGroup));
    return bindGroup;
  };
  return {
    created: () => created,
    retained: async (gc: () => void): Promise<number> => {
      const instrumentation = host.instrumentation as unknown as Record<string, unknown>;
      for (const value of Object.values(instrumentation)) if (Array.isArray(value)) value.length = 0;
      for (let pass = 0; pass < 4; pass += 1) {
        gc();
        await new Promise((resolve) => {
          setImmediate(resolve);
        });
      }
      return refs.filter((ref) => ref.deref() !== undefined).length;
    },
  };
}

function frameInput(index: number): FrameEvaluationInput {
  return { timeSeconds: index / 60, deltaSeconds: 1 / 60, frameIndex: index, mode: "realtime", randomSeed: 1 };
}

const SURFACE = { x: 0, y: 0, width: 1600, height: 1000 };
const NODES = Array.from({ length: 40 }, (_, i) => ({ id: `n${i}`, x: (i % 8) * 320, y: Math.floor(i / 8) * 260 }));
const CYCLE_FRAMES = 150;

/** Closed loop: step CYCLE_FRAMES returns the camera exactly to step 0. */
function requestsFor(step: number): PreviewRequest[] {
  const t = (step / CYCLE_FRAMES) * Math.PI * 2;
  const cam = { x: 500 + Math.cos(t) * 500, y: 400 + Math.sin(t) * 300, zoom: 0.85 + Math.sin(t) * 0.45 };
  return NODES.map((node) => {
    const width = 220 * cam.zoom;
    const height = 150 * cam.zoom;
    const x = (node.x - cam.x) * cam.zoom + SURFACE.width / 2;
    const y = (node.y - cam.y) * cam.zoom + SURFACE.height / 2;
    return {
      ref: { nodeId: node.id, portId: "out" },
      source: { resourceId: "output", size: [64, 64], format: "rgba8unorm", space: "linear" },
      rect: { x, y, width, height },
      area: { width: 220, height: 150 },
      visible: x + width > 0 && y + height > 0 && x < SURFACE.width && y < SURFACE.height,
      pinned: false,
      collapsed: false,
      occluded: false,
      view: DEFAULT_PREVIEW_VIEW,
    } as PreviewRequest;
  });
}

/** A canvas stub that recycles ONE surface texture — a fresh one per present is harness growth. */
function previewCanvas(host: ReturnType<typeof mockGpuHost>): Parameters<ReturnType<typeof createVgpuBackend>["previewHost"]>[0] {
  let surfaceTexture: GPUTexture | undefined;
  const context = {
    configure() {},
    unconfigure() {},
    getCurrentTexture: () => {
      const device = host.device;
      if (!device) throw new Error("no live mock device");
      surfaceTexture ??= device.createTexture({
        size: [SURFACE.width, SURFACE.height],
        format: "rgba8unorm",
        usage: ["render_attachment", "texture_binding"] as unknown as GPUTextureUsageFlags,
      });
      return surfaceTexture;
    },
  };
  return {
    width: SURFACE.width,
    height: SURFACE.height,
    getContext: (kind: string) => (kind === "webgpu" ? context : null),
  } as unknown as Parameters<ReturnType<typeof createVgpuBackend>["previewHost"]>[0];
}

/** Pans the closed-loop camera for `cycles` identical cycles, sampling retention per cycle. */
async function panScenario(gc: () => void, cycles: number): Promise<Retention> {
  const host = mockGpuHost();
  const backend = createVgpuBackend({ host });
  await backend.initialize({});
  const track = trackBindGroups(host);
  const plan = await backend.compile(fixturePlan());
  backend.render(plan, { frame: frameInput(0), pointer: { x: 0, y: 0, buttons: 0 }, resolution: [64, 64] } as never);
  const system = createPreviewSystem({ host: backend.previewHost(previewCanvas(host)), capacity: 16 });

  const samples: number[] = [];
  let index = 0;
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    for (let step = 0; step < CYCLE_FRAMES; step += 1) {
      system.update({
        requests: requestsFor(step),
        frame: frameInput(index),
        surface: SURFACE,
        devicePixelRatio: 2,
        previewFps: 15,
        previewLongEdge: 192,
      });
      index += 1;
    }
    samples.push(await track.retained(gc));
  }
  backend.dispose();
  return { samples, created: track.created() };
}

/**
 * Recompiles one effect pass whose bindings all SURVIVE the edit.
 *
 * `composite` binds a sampler, a ping-pong and a target and carries NO uniform block, so a
 * shader-only edit replaces the Effect while every resource it named lives on. `generate`
 * cannot show this: its per-pass uniform block dies with the pass and vgpu reclaims the
 * entry as a side effect of that destroy.
 */
async function editScenario(gc: () => void, edits: number): Promise<Retention> {
  const host = mockGpuHost();
  const backend = createVgpuBackend({ host });
  await backend.initialize({});
  const track = trackBindGroups(host);

  const samples: number[] = [];
  for (let edit = 0; edit < edits; edit += 1) {
    const base = fixturePlan();
    const passes = (base.passes as ReadonlyArray<PassDescriptor>).map((pass) =>
      pass.id === "composite" && pass.kind === "effect"
        ? { ...pass, shader: edit % 2 === 0 ? pass.shader : pass.shader.replace("return textureSample", "return 1.0 * textureSample") }
        : pass,
    );
    const plan = await backend.compile({ ...base, passes } as never);
    backend.render(plan, { frame: frameInput(edit), pointer: { x: 0, y: 0, buttons: 0 }, resolution: [64, 64] } as never);
    samples.push(await track.retained(gc));
  }
  backend.dispose();
  return { samples, created: track.created() };
}

/** Runs `scenario` twice: once with the patched method removed (control), once with it. */
async function withControl(run: () => Promise<Retention>): Promise<{ control: Retention; treatment: Retention }> {
  const prototype = await effectPrototype();
  const saved = prototype["evictBindGroups"];
  if (typeof saved !== "function") {
    throw new Error("vgpu Effect has no evictBindGroups(): patches/vgpu.patch (T1180) is not applied");
  }
  delete prototype["evictBindGroups"];
  let control: Retention;
  try {
    control = await run();
  } finally {
    prototype["evictBindGroups"] = saved;
  }
  return { control, treatment: await run() };
}

describe("bind-group cache entries do not accumulate over a session (T1180, §T1174)", () => {
  it("a live blit re-pointed at every tile keeps a BOUNDED set of bind groups across identical camera cycles", async () => {
    const gc = exposeGc();
    const { control, treatment } = await withControl(() => panScenario(gc, 5));

    // The control must LEAK, or the scenario proves nothing. §T1174's camera loop makes
    // every cycle byte-identical, so any growth after the first is unreachable objects.
    const controlGrowth = control.samples[control.samples.length - 1]! - control.samples[1]!;
    expect(controlGrowth).toBeGreaterThan(0);

    // Flat. Not "grows more slowly" — cycle N holds what cycle 2 held.
    expect(treatment.samples.slice(1)).toEqual(
      Array.from({ length: treatment.samples.length - 1 }, () => treatment.samples[1]!),
    );
  }, 60_000);

  it("an effect discarded while every resource it bound survives takes its bind groups with it", async () => {
    const gc = exposeGc();
    const { control, treatment } = await withControl(() => editScenario(gc, 12));

    const controlGrowth = control.samples[control.samples.length - 1]! - control.samples[1]!;
    expect(controlGrowth).toBeGreaterThan(0);

    expect(treatment.samples.slice(1)).toEqual(
      Array.from({ length: treatment.samples.length - 1 }, () => treatment.samples[1]!),
    );
  }, 60_000);
});
