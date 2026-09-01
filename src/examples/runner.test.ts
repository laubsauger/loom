import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "../domain/types/schemas.ts";
import { documentLiveness, isValueSourceDefinition } from "../domain/graph/liveness.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import { listExamples } from "./catalogue.ts";
import {
  errorsOf,
  frameSequence,
  frameStateDigest,
  messagesOf,
  renderTrace,
  requireExample,
  runExample,
} from "./runner.ts";

/**
 * THE EXAMPLE GATE (T157, §V89).
 *
 * Every `.loom.json` in `examples/` must load through the real loader with no complaints,
 * compile to a plan the real backend reader accepts, and replay a fixed frame sequence
 * identically twice. §V89 makes a failure here a release blocker, and that is the whole
 * design: an example breaking means the FILE FORMAT regressed, a node manifest changed
 * incompatibly, or the compiler broke. None of those are "a docs chore".
 *
 * The suite is generated from `listExamples()`, which reads the directory. There is no
 * list of example names here on purpose — a gate you have to remember to register a file
 * with is a gate that eventually has a hole in it. Dropping a file into `examples/` is the
 * entire registration step. The one hard-coded list below is the OPPOSITE check: it fails
 * if a shipped example DISAPPEARS, which discovery alone could never notice.
 */

const examples = listExamples();

/** Long enough that a feedback pair has been bound in both directions and settled. */
const FRAME_COUNT = 6;

describe("examples: the gate", () => {
  it("finds the examples the spec names", () => {
    // §C names them. Discovery would happily report "0 examples, all passing".
    // Lexicographic listing order: E10 and E11 sort between E1 and E2.
    expect(examples.map((file) => file.fileName)).toEqual([
      "E1-Feedback-Echo.loom.json",
      "E10-Instanced-Torus.loom.json",
      "E11-Gradient-Remap.loom.json",
      "E12-Fluid.loom.json",
      "E13-Prism.loom.json",
      "E14-Self-Regulating-Bloom.loom.json",
      "E16-Murmuration.loom.json",
      "E2-Reaction-Diffusion.loom.json",
      "E20-Gooeyball.loom.json",
      "E24-Audio-Reaction-Diffusion.loom.json",
      "E25-Stage.loom.json",
      "E26-Interference.loom.json",
      "E27-Relief.loom.json",
      "E28-Sundial.loom.json",
      "E29-Descent.loom.json",
      "E3-Animated-Noise-Field.loom.json",
      "E30-Nave.loom.json",
      "E31-Corona.loom.json",
      "E32-Pasture.loom.json",
      "E33-Obol.loom.json",
      "E34-Lidar.loom.json",
      "E35-Nova-Torus.loom.json",
      "E36-Facade.loom.json",
      "E37-Sirocco.loom.json",
      "E38-Sigil.loom.json",
      "E39-Rosette.loom.json",
      "E4-Bloom.loom.json",
      "E40-Wake.loom.json",
      "E41-Cinder.loom.json",
      "E5-Kaleidoscope.loom.json",
      "E6-Displacement-Stack.loom.json",
      "E7-LFO-Dissolve.loom.json",
      "E8-Slit-Scan.loom.json",
      "E9-Ember.loom.json",
    ]);
  });
});

describe.each(examples)("example $fileName", (file) => {
  /**
   * §V88: through `loadProject`, from the shipped bytes. Not a fixture, not a re-serialized
   * document — the same call the "open project" path makes.
   */
  it("loads through the real project loader", () => {
    const result = runExample(file);

    expect(result.reason).toBeUndefined();
    expect(result.document).toBeDefined();
    expect(messagesOf(result.loadDiagnostics)).toEqual([]);
    // A placeholder means a node type this build does not have (§V10). An example is
    // supposed to be buildable with the shipped catalogue, so any placeholder is a bug.
    expect(result.placeholders.map((entry) => entry.type)).toEqual([]);
    // `changed` means the loader migrated or clamped something. A shipped example must be
    // already-current: if opening one immediately marks the project dirty, the file was
    // written against a schema or a limit this build no longer agrees with.
    expect(result.changed).toBe(false);
    expect(result.document?.schemaVersion).toBe(SCHEMA_VERSION);
  });

  /** §V89: zero ERROR diagnostics is the letter of it. Zero diagnostics is the intent. */
  it("compiles with no diagnostics at all", () => {
    const { plan } = runExample(file);

    // Not just errors. A warning here is an unknown parameter key, a stale
    // `definitionVersion`, a colour-space clash or a format falling back — every one of
    // which renders something quietly different from what the example claims to show.
    expect(messagesOf(plan?.diagnostics ?? [])).toEqual([]);
    expect(plan?.ok).toBe(true);
  });

  it("emits a plan the backend reader accepts", () => {
    const { read } = runExample(file);

    expect(errorsOf(read?.diagnostics ?? [])).toEqual([]);
    expect(read?.ok).toBe(true);
  });

  /**
   * §V25: an example is a specification, so every node in it has to matter. A pruned node
   * is either dead weight the reader will try to understand, or a wiring mistake that the
   * compiler quietly worked around.
   */
  it("has no dead nodes: every node reaches a sink", () => {
    const { plan, document } = requireExample(file);

    expect(plan.pruned).toEqual([]);
    // Not every live node is a PLAN node. A value source (LFO, Constant, Timer) has no
    // ports and never compiles to GPU work — it is alive through channel addressing, and
    // `plan.order` correctly omits it (§V173b). Asserting order === all node ids would
    // therefore fail on a working document, so the claim is split: everything is live,
    // and everything that should compile did.
    const registry = createNodeRegistry(allNodeDefinitions);
    expect([...documentLiveness(document.graph, registry).dead]).toEqual([]);
    const expectedOrder = Object.keys(document.graph.nodes)
      .filter((id) => {
        const node = document.graph.nodes[id];
        if (node === undefined) return true;
        const definition = registry.get(node.type);
        // `isValueSourceDefinition`, not a local `valueChannel === undefined` test. The
        // narrower spelling was right while the LFO/Constant/Timer trio were the only
        // value nodes in any example, and it silently became wrong the moment one shipped
        // a Mouse or a Lag: those declare `valueEvaluate` and no `valueChannel`, so this
        // filter kept them and demanded the compiler put a portless CPU node into the GPU
        // plan's order. §V173 already names the whole class — one spelling, one answer.
        if (isValueSourceDefinition(definition)) return false;
        // T538, and §V316's shape exactly: "not every LIVE node is a PLAN node" had one
        // member and quietly narrowed to it. A `passthrough` node — `null` is the only one
        // today — is SPLICED OUT by the compiler by design: no pass, no resource, zero
        // render-time cost, and therefore never in `plan.order`. It is still live, still
        // unpruned, still previewable through the §V130 alias. Without this clause the gate
        // made `null` unexampleable, which is a strange thing for the gate on examples to
        // do to a shipped node — and it is why `null` sat in the class-(c) unexampled list.
        return definition?.passthrough === undefined;
      })
      .sort();
    expect([...plan.order].sort()).toEqual(expectedOrder);
    expect(plan.passes.length).toBeGreaterThan(0);
  });

  /**
   * §V89 determinism, first half: the compiler is a pure function of the file.
   *
   * Two independent trips from the same bytes — parse, migrate, validate, prune, order,
   * propagate, compile — must produce the same plan down to pass order and resource ids,
   * because the plan's structural signature is what decides whether GPU resources get
   * rebuilt (§V5). An unstable ordering would rebuild the world on every keystroke.
   */
  it("compiles to an identical plan twice from the same bytes", () => {
    const first = runExample(file);
    const second = runExample(file);

    expect(second.plan?.signature).toBe(first.plan?.signature);
    expect(JSON.stringify(second.plan?.passes)).toBe(JSON.stringify(first.plan?.passes));
    expect(JSON.stringify(second.plan?.resources)).toBe(JSON.stringify(first.plan?.resources));
    expect(JSON.stringify(second.plan?.outputs)).toBe(JSON.stringify(first.plan?.outputs));
    expect(JSON.stringify(second.plan?.feedback)).toBe(JSON.stringify(first.plan?.feedback));
    expect(JSON.stringify(second.document)).toBe(JSON.stringify(first.document));
  });

  /**
   * §V89 determinism, second half: a fixed seed and a fixed frame sequence produce the
   * same GPU state every time.
   *
   * `frameStateDigest` covers the plan's compile-time uniforms plus the shared frame block,
   * which is the only channel time reaches a shader through (§V44). If a node ever started
   * reading a wall clock, the same `frameIndex` would stop producing the same digest.
   */
  it("produces the same per-frame state for the same seed and frame sequence", () => {
    const first = requireExample(file);
    const second = requireExample(file);

    const firstRun = frameSequence(first.document, FRAME_COUNT).map((inputs) =>
      frameStateDigest(first.plan, inputs),
    );
    const secondRun = frameSequence(second.document, FRAME_COUNT).map((inputs) =>
      frameStateDigest(second.plan, inputs),
    );

    expect(secondRun).toEqual(firstRun);
    expect(firstRun).toHaveLength(FRAME_COUNT);
    // Being explicit about what this does NOT say: the digest carries `frameIndex`, so it
    // varies frame to frame for every example, animated or not. That variation is not
    // evidence of anything. The claim here is CROSS-RUN identity. Whether an example
    // actually consumes the frame block is E3's question, asserted in `concepts.test.ts`.
    expect(new Set(firstRun).size).toBe(FRAME_COUNT);
  });

  /**
   * The plan is not just structurally valid — the real backend can BUILD it.
   *
   * This is the assertion that catches a plan the compiler is happy with and the backend
   * cannot construct: a binding that names a resource the plan never declared, a pass kind
   * the reader accepts and the builder does not, a shader module that fails to create. It
   * runs against `vgpu/mock` through the backend adapter, with no canvas (§V47).
   *
   * NO PIXELS ARE CHECKED HERE, and none can be: the mock device executes no shaders, so a
   * readback returns zeroes. Comparing those images would be a test that looks like it
   * verifies rendering and does not. Pixel parity belongs to the Dawn headless track.
   */
  it("builds and steps on the mock device with no backend errors", async () => {
    const { plan, document } = requireExample(file);

    const trace = await renderTrace(plan, document, FRAME_COUNT);

    expect(trace.diagnostics.filter((entry) => entry.startsWith("error"))).toEqual([]);
    expect(trace.framesSubmitted).toBe(FRAME_COUNT);
    expect(trace.snapshots).toHaveLength(FRAME_COUNT);
  });

  /** The same frame sequence must issue the same commands on two independent devices. */
  it("issues an identical command trace on a replay", async () => {
    const { plan, document } = requireExample(file);

    const first = await renderTrace(plan, document, FRAME_COUNT);
    const second = await renderTrace(plan, document, FRAME_COUNT);

    expect(second.snapshots).toEqual(first.snapshots);
  });

  /**
   * §V8: nothing is allocated inside the frame loop.
   *
   * Pipelines, shader modules, buffers and bind groups are all created at compile time. A
   * ping-pong pair legitimately binds its second half the first time the pair is read the
   * other way round, so the counters are compared from the THIRD frame on — after which
   * anything but a new command encoder per frame is an allocation in the loop.
   */
  it("allocates nothing per frame once the plan has settled", async () => {
    const { plan, document } = requireExample(file);

    const { snapshots } = await renderTrace(plan, document, FRAME_COUNT);
    const settled = snapshots[2];
    const last = snapshots[FRAME_COUNT - 1];
    if (settled === undefined || last === undefined) throw new Error("too few frames");

    const grew = Object.keys(last)
      .filter((key) => key !== "createCommandEncoder")
      .filter((key) => (last[key] ?? 0) !== (settled[key] ?? 0));
    expect(grew).toEqual([]);
  });
});
