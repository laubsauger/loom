import { describe, expect, it } from "vitest";
import { flattenComponents } from "../compiler/flatten.ts";
import { requireCodeBuilt } from "../compiler/document-findings.ts";
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
      "E42-Current.loom.json",
      "E43-Splice.loom.json",
      "E44-Sounding.loom.json",
      "E45-Pulse.loom.json",
      "E46-Lantern.loom.json",
      "E47-Hologram.loom.json",
      "E48-Marionette.loom.json",
      "E49-Lissajous.loom.json",
      "E5-Kaleidoscope.loom.json",
      "E50-Galvo.loom.json",
      "E51-Chorus.loom.json",
      "E52-Presence.loom.json",
      "E53-Two-Cuts.loom.json",
      "E54-Quorum.loom.json",
      "E55-Reactor.loom.json",
      "E56-Vesper.loom.json",
      "E57-Forest.loom.json",
      "E58-Alembic.loom.json",
      "E59-Vault.loom.json",
      "E6-Displacement-Stack.loom.json",
      "E60-Snarl.loom.json",
      "E61-Skein.loom.json",
      "E62-Rake.loom.json",
      "E63-Skin.loom.json",
      "E64-Relay.loom.json",
      "E66-Meter.loom.json",
      "E67-Fins.loom.json",
      "E68-Sanctum.loom.json",
      "E69-Burnish.loom.json",
      "E7-LFO-Dissolve.loom.json",
      "E70-Chimera.loom.json",
      "E71-Syphon-Loopback.loom.json",
      "E72-NDI-Loopback.loom.json",
      "E73-Native-Person-Mask.loom.json",
      "E74-Spout-Loopback-Preparation.loom.json",
      "E75-Resonance.loom.json",
      "E76-Verdant-Lotus.loom.json",
      "E77-Ember-Monoliths.loom.json",
      "E78-Aether-Orrery.loom.json",
      "E79-Crucible.loom.json",
      "E8-Slit-Scan.loom.json",
      "E80-Azulejo.loom.json",
      "E81-Phone-Desk.loom.json",
      "E82-Set-List.loom.json",
      "E83-Photo-Mapping-Moonlit-Stone.loom.json",
      "E84-Photo-Mapping-Contour-Engraving.loom.json",
      "E85-Photo-Mapping-Video.loom.json",
      "E86-Photo-Mapping-Point-Cloud.loom.json",
      "E87-Photo-Mapping-Falling-Facade.loom.json",
      "E88-Photo-Mapping-Ribbon-Peel.loom.json",
      "E89-Cymatics.loom.json",
      "E9-Ember.loom.json",
      "E90-Chord-Wheel.loom.json",
      "E91-Music-Features.loom.json",
    ]);
  });
});

describe.each(examples)("example $fileName", (file) => {
  /**
   * §V88: through `loadProject`, from the shipped bytes. Not a fixture, not a re-serialized
   * document — the same call the "open project" path makes. One baseline and one independent
   * reload carry all checks, with two independent mock-device replays.
   */
  it("loads, compiles, and replays without diagnostics, dead nodes, or frame allocations", async () => {
    const result = runExample(file);

    expect(result.reason, `${file.fileName}: load`).toBeUndefined();
    expect(result.document, `${file.fileName}: load`).toBeDefined();
    expect(messagesOf(result.loadDiagnostics), `${file.fileName}: load`).toEqual([]);
    // A placeholder means a node type this build does not have (§V10). An example is
    // supposed to be buildable with the shipped catalogue, so any placeholder is a bug.
    expect(result.placeholders.map((entry) => entry.type), `${file.fileName}: load`).toEqual([]);
    // `changed` means the loader migrated or clamped something. A shipped example must be
    // already-current: if opening one immediately marks the project dirty, the file was
    // written against a schema or a limit this build no longer agrees with.
    expect(result.changed, `${file.fileName}: load`).toBe(false);
    expect(result.document?.schemaVersion, `${file.fileName}: load`).toBe(SCHEMA_VERSION);

    /** §V89: zero ERROR diagnostics is the letter of it. Zero diagnostics is the intent. */

    // Not just errors. A warning here is an unknown parameter key, a stale
    // `definitionVersion`, a colour-space clash or a format falling back — every one of
    // which renders something quietly different from what the example claims to show.
    expect(messagesOf(result.plan?.diagnostics ?? []), `${file.fileName}: compile diagnostics`).toEqual([]);
    expect(result.plan?.ok, `${file.fileName}: compile diagnostics`).toBe(true);

    expect(errorsOf(result.read?.diagnostics ?? []), `${file.fileName}: backend reader`).toEqual([]);
    expect(result.read?.ok, `${file.fileName}: backend reader`).toBe(true);

    /**
     * §V25: an example is a specification, so every node in it has to matter. A pruned node
     * is either dead weight the reader will try to understand, or a wiring mistake that the
     * compiler quietly worked around.
     */
    const { plan, document } = result;
    if (document === undefined || plan === undefined) {
      throw new Error(`${file.fileName}: load/compile did not return a document and plan`);
    }
    requireCodeBuilt(`${file.fileName}: document findings`, result.findings);
    const registry = createNodeRegistry(allNodeDefinitions);

    /* E81: a node with NO OUTPUT AND NO VALUE — today exactly Annotate (a note box behind the
       graph, T1262) and Panel (the controls surface, T1388b) — has nothing to send toward a
       sink, so "reaches a sink" asks it a question it has no way to answer. The compiler
       prunes both by design (`annotate.test.ts` pins it). T1512b gave the Panel an INPUT —
       widgets join it by wire — which changes nothing here: a wire into a node that sends
       nothing on still ends at it. They are the ONLY nodes allowed in `pruned`, and the set
       is read off the manifests, so a node that grows an output is held to §V25 again the
       day it does. */
    const unwireable = Object.values(document.graph.nodes)
      .filter((node) => {
        const definition = registry.get(node.type);
        return (
          definition !== undefined &&
          definition.outputs.length === 0 &&
          definition.sink !== true &&
          !isValueSourceDefinition(definition)
        );
      })
      .map((node) => node.id)
      .sort();
    /* §V1030 (§T1718b, owner 2026-10-22): a Layer that ships OFF prunes its picture's chain, and that is the point of
       it (an off look costs nothing). Those nodes are not dead: switched on, they render. So
       the file is held to its plan WITH every off Layer on, where nothing but the unwireable
       may be pruned, and the shipped plan may prune exactly that plus what the off Layers
       hide. A layer shipped off over a chain that is dead anyway still fails, on the first. */
    const shippedOff = Object.values(document.graph.nodes).some((node) => node.type === "layer" && node.ui?.bypassed === true);
    const layersOn = result.layersOn ?? null;
    if (shippedOff) expect(layersOn, `${file.fileName}: the plan with its off layers on`).not.toBeNull();
    const behindOffLayers = layersOn === null ? [] : plan.pruned.filter((nodeId) => !layersOn.pruned.includes(nodeId));
    if (layersOn !== null) expect([...layersOn.pruned].sort(), `${file.fileName}: node liveness, off layers on`).toEqual(unwireable);
    expect([...plan.pruned].sort(), `${file.fileName}: node liveness`).toEqual([...unwireable, ...behindOffLayers].sort());
    // Not every live node is a PLAN node. A value source (LFO, Constant, Timer) has no
    // ports and never compiles to GPU work — it is alive through channel addressing, and
    // `plan.order` correctly omits it (§V173b). Asserting order === all node ids would
    // therefore fail on a working document, so the claim is split: everything is live,
    // and everything that should compile did.
    expect([...documentLiveness(document.graph, registry).dead], `${file.fileName}: node liveness`).toEqual(unwireable);
    /* T956: a component INSTANCE flattens into `<id>/<inner>` plan nodes (E47's depthpoints_holo1 is
       the first shipped case), and the plan is compiled from that FLATTENED document — so
       the flattened document is where the expected order is read from. T1236: an instance
       of value nodes only (E66's AudioAnalysis) expands to NO plan node at all and is
       alive the way a Constant is; asserting "every instance expands to something in the
       order" made a working document fail, which is the §V173b mistake one level up. */
    const logical =
      result.components === undefined || result.nodes === undefined
        ? document.graph
        : flattenComponents({ graph: document.graph, registry: result.nodes, components: result.components }).graph;
    const expectedOrder = Object.keys(logical.nodes)
      .filter((id) => {
        const node = logical.nodes[id];
        if (node === undefined) return true;
        if (unwireable.includes(id)) return false;
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
    // §T1718b: the off layers' chains compile only with the layers on, and an off layer is
    // itself spliced out (bypass passes its stack through, with no pass of its own).
    if (layersOn !== null) expect([...layersOn.order].sort(), `${file.fileName}: node liveness, off layers on`).toEqual(expectedOrder);
    const bypassedLayer = (id: string) => logical.nodes[id]?.type === "layer" && logical.nodes[id]?.ui?.bypassed === true;
    expect([...plan.order].sort(), `${file.fileName}: node liveness`).toEqual(
      expectedOrder.filter((id) => !behindOffLayers.includes(id) && !bypassedLayer(id)),
    );
    expect(plan.passes.length, `${file.fileName}: node liveness`).toBeGreaterThan(0);

    /**
     * T826/§B163 — a LABEL IS AN ADDRESS, so it must be unique per document (§V782's family).
     *
     * A driven or bound parameter names its source by LABEL (`drivenSlot("limit_tearn:high")`),
     * and `nodeNames` resolves a label to the FIRST node id that carries it and silently
     * drops the rest — so two nodes sharing a label is not an error, it is a binding that
     * quietly resolves to whichever id sorts first while the branch it was built for goes
     * dead. E40 shipped exactly that: `tearb` and `tearn` both labelled `math_tearb`, and
     * `transform_shiftb` bound the positive intermediate instead of the negative clamp. A count, not
     * `nodeNames`, because the point is to catch the collision the resolver hides.
     */
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const [nodeId, node] of Object.entries(document.graph.nodes)) {
      const label = node.label;
      if (label === undefined) continue;
      const prior = seen.get(label);
      if (prior !== undefined) collisions.push(`"${label}" on both ${prior} and ${nodeId}`);
      else seen.set(label, nodeId);
    }
    expect(collisions, `${file.fileName}: unique labels`).toEqual([]);

    /**
     * §V89 determinism, first half: the compiler is a pure function of the file.
     *
     * Two independent trips from the same bytes — parse, migrate, validate, prune, order,
     * propagate, compile — must produce the same plan down to pass order and resource ids,
     * because the plan's structural signature is what decides whether GPU resources get
     * rebuilt (§V5). An unstable ordering would rebuild the world on every keystroke.
     */
    const first = result;
    const second = runExample(file);

    expect(second.plan?.signature, `${file.fileName}: independent compile determinism`).toBe(first.plan?.signature);
    expect(JSON.stringify(second.plan?.passes), `${file.fileName}: independent compile determinism`).toBe(JSON.stringify(first.plan?.passes));
    expect(JSON.stringify(second.plan?.resources), `${file.fileName}: independent compile determinism`).toBe(JSON.stringify(first.plan?.resources));
    expect(JSON.stringify(second.plan?.outputs), `${file.fileName}: independent compile determinism`).toBe(JSON.stringify(first.plan?.outputs));
    expect(JSON.stringify(second.plan?.feedback), `${file.fileName}: independent compile determinism`).toBe(JSON.stringify(first.plan?.feedback));
    expect(JSON.stringify(second.document), `${file.fileName}: independent compile determinism`).toBe(JSON.stringify(first.document));

    /**
     * §V89 determinism, second half: a fixed seed and a fixed frame sequence produce the
     * same GPU state every time.
     *
     * `frameStateDigest` covers the plan's compile-time uniforms plus the shared frame block,
     * which is the only channel time reaches a shader through (§V44). If a node ever started
     * reading a wall clock, the same `frameIndex` would stop producing the same digest.
     */

    if (second.document === undefined || second.plan === undefined) {
      throw new Error(`${file.fileName}: independent replay did not return a document and plan`);
    }
    requireCodeBuilt(`${file.fileName}: independent replay document findings`, second.findings);

    const firstRun = frameSequence(document, FRAME_COUNT).map((inputs) =>
      frameStateDigest(plan, inputs),
    );
    const secondPlan = second.plan;
    const secondRun = frameSequence(second.document, FRAME_COUNT).map((inputs) =>
      frameStateDigest(secondPlan, inputs),
    );

    expect(secondRun, `${file.fileName}: frame-state determinism`).toEqual(firstRun);
    expect(firstRun, `${file.fileName}: frame-state determinism`).toHaveLength(FRAME_COUNT);
    // Being explicit about what this does NOT say: the digest carries `frameIndex`, so it
    // varies frame to frame for every example, animated or not. That variation is not
    // evidence of anything. The claim here is CROSS-RUN identity. Whether an example
    // actually consumes the frame block is E3's question, asserted in `concepts/*.test.ts`.
    expect(new Set(firstRun).size, `${file.fileName}: frame-state determinism`).toBe(FRAME_COUNT);

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

    const trace = await renderTrace(plan, document, FRAME_COUNT);

    expect(trace.diagnostics.filter((entry) => entry.startsWith("error")), `${file.fileName}: mock backend build and steps`).toEqual([]);
    expect(trace.framesSubmitted, `${file.fileName}: mock backend build and steps`).toBe(FRAME_COUNT);
    expect(trace.snapshots, `${file.fileName}: mock backend build and steps`).toHaveLength(FRAME_COUNT);

    /** The same frame sequence must issue the same commands on two independent devices. */

    const replay = await renderTrace(plan, document, FRAME_COUNT);

    expect(replay.snapshots, `${file.fileName}: mock command replay`).toEqual(trace.snapshots);

    /**
     * §V8: nothing is allocated inside the frame loop.
     *
     * Pipelines, shader modules, buffers and bind groups are all created at compile time. A
     * ping-pong pair legitimately binds its second half the first time the pair is read the
     * other way round, so the counters are compared from the THIRD frame on — after which
     * anything but a new command encoder per frame is an allocation in the loop.
     */

    const { snapshots } = trace;
    const settled = snapshots[2];
    const last = snapshots[FRAME_COUNT - 1];
    if (settled === undefined || last === undefined) throw new Error(`${file.fileName}: allocation check has too few frames`);

    const grew = Object.keys(last)
      .filter((key) => key !== "createCommandEncoder")
      .filter((key) => (last[key] ?? 0) !== (settled[key] ?? 0));
    expect(grew, `${file.fileName}: frame allocations`).toEqual([]);
  });
});
