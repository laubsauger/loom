import { beforeEach, describe, expect, it } from "vitest";
import { compileGraph } from "@compiler/index.ts";
import { createDomainBus } from "@domain/commands/index.ts";
import type { ShaderloomBus } from "@domain/commands/bus.ts";
import type { InvocationContext } from "@domain/types/commands.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { DEFAULT_PROJECT_SETTINGS } from "@domain/types/graph.ts";
import type { BackendCapabilities } from "@domain/types/backend.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";

/**
 * T595 (§V109, §V373) — `feedback.in` is SATISFIABLE, and both halves say the same thing.
 *
 * ## The bug
 *
 * `feedback` declares `in` as a real, REQUIRED input and fills it BY NAME (§V372/§V373):
 * the editor and `connect_ports` refuse a wire into it — "takes its source by NAME, not a
 * wire" — and the compiler synthesizes the exact edge the wired shape would have had,
 * before it validates. `project.validate` skipped the synthesis, so on a loop that
 * compiles and runs it reported
 *
 *   Input "in" on "fb1" (feedback) is required but nothing is connected to it.
 *
 * There is no legal edit that clears that. Two halves of one codebase disagreeing about
 * whether a port is filled is §V109's shape, and the report an agent cannot act on is the
 * cost.
 *
 * ## What is gated, and why it cannot pass vacuously
 *
 * NOT "validate returns nothing for a feedback node" — a validator that had simply
 * stopped checking required inputs would pass that. The gate is AGREEMENT: for each
 * document, `project.validate` and `compileGraph` are asked the same question and must
 * give the same answer, and the documents are chosen so the answer differs between them.
 *
 *  - `source` NAMED   → both say the input is filled (this is what regressed);
 *  - `source` EMPTY   → both still say it is missing (§V461: the check is alive);
 *  - `source` DANGLING→ both name the name (§V369), and the input is missing besides.
 *
 * A second, separately-written resolution inside the command could pass the first case
 * and would have to reproduce §V369's refusals and the LIST ordering to pass the rest;
 * the module both callers now share is what makes that unnecessary (§V373: one resolution
 * mechanism, not two).
 */

const CAPABILITIES: BackendCapabilities = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
};

const INPUT_MISSING = "compiler/input-missing";
const REFERENCE_MISSING = "compiler/source-reference-missing";

/**
 * The codes BOTH halves are responsible for — wiring.
 *
 * The comparison is restricted to these on purpose, and the restriction is what makes it
 * a real gate rather than an impossible one: `project.validate` deliberately does not
 * answer resolution, format or pass questions (its docblock says so — those need settings
 * and a device report the domain must not invent), so demanding identical LISTS would
 * gate a difference the design states. What must never differ is whether a port is
 * filled, which is the question T595 found them disagreeing about.
 */
const WIRING_CODES = new Set([
  INPUT_MISSING,
  REFERENCE_MISSING,
  "compiler/source-reference-ambiguous",
]);

const actor = { kind: "human", id: "tester" } as const;
const context: InvocationContext = { actor, projectId: "project-1", capabilities: [] };

let bus: ShaderloomBus;
let registry: NodeRegistryView;

beforeEach(() => {
  registry = createNodeRegistry(allNodeDefinitions).view();
  bus = createDomainBus({ registry }).bus;
});

async function apply(operations: GraphPatchOperation[]) {
  return bus.execute(
    "graph.applyPatch",
    { baseRevision: bus.store.getRevision(), operations },
    context,
  );
}

/** solid1 → feedback1 (by name, or not) → output1. The shipped shape of a trails loop. */
async function loop(source: string | null): Promise<void> {
  const built = await apply([
    { op: "addNode", ref: "$solid", type: "solid", position: { x: -300, y: 0 } },
    { op: "addNode", ref: "$fb", type: "feedback", position: { x: 0, y: 0 } },
    { op: "addNode", ref: "$out", type: "output", position: { x: 300, y: 0 } },
  ]);
  const fb = built.output.createdIds["$fb"] as string;
  const out = built.output.createdIds["$out"] as string;
  await apply([
    { op: "connect", source: { nodeId: fb, portId: "out" }, target: { nodeId: out, portId: "input" } },
  ]);
  if (source !== null) {
    await apply([{ op: "setParameters", nodeId: fb, parameters: { source } }]);
  }
}

/** The codes each half reports for the feedback node, so the two can be compared. */
async function bothHalves(): Promise<{ validator: string[]; compiler: string[] }> {
  const graph = bus.store.getGraph();
  const fbId = Object.keys(graph.nodes).find((id) => graph.nodes[id]?.type === "feedback");
  expect(fbId).toBeDefined();

  const validated = await bus.execute("project.validate", {}, context);
  const plan = compileGraph({
    graph,
    registry,
    settings: DEFAULT_PROJECT_SETTINGS,
    capabilities: CAPABILITIES,
  });

  const forNode = (diagnostics: ReadonlyArray<{ code: string; nodeId?: string }>) =>
    diagnostics
      .filter((entry) => entry.nodeId === fbId && WIRING_CODES.has(entry.code))
      .map((entry) => entry.code)
      .sort();

  return { validator: forNode(validated.output.diagnostics), compiler: forNode(plan.diagnostics) };
}

describe("T595 — feedback.in, through project.validate", () => {
  it("is satisfied by the NAME, and both halves agree it is", async () => {
    await loop("solid1");
    const { validator, compiler } = await bothHalves();
    expect(validator).not.toContain(INPUT_MISSING);
    // The claim is AGREEMENT, not silence: the compiler is the half that was always
    // right, and the validator now answers identically for the same document.
    expect(validator).toEqual(compiler);
  });

  it("STILL reports the input missing when nothing names it and nothing wires it", async () => {
    // §V461: the control. Without this, "no diagnostic" above would also be produced by a
    // validator that had stopped checking required inputs altogether.
    await loop(null);
    const { validator, compiler } = await bothHalves();
    expect(validator).toContain(INPUT_MISSING);
    expect(validator).toEqual(compiler);
  });

  it("names a DANGLING source rather than going quiet about it (§V369)", async () => {
    // The second control, and the one that catches a fix that merely SKIPPED reference-fed
    // ports: skipping would leave this document reported as clean, which is the failure
    // §V369 exists to make impossible — an empty loop because the name matched nothing.
    await loop("nosuchnode");
    const { validator, compiler } = await bothHalves();
    expect(validator).toContain(REFERENCE_MISSING);
    expect(validator).toContain(INPUT_MISSING);
    expect(validator).toEqual(compiler);
  });

  it("counts the DOCUMENT's edges, not the synthesized ones (§V373: refs are plumbing)", async () => {
    await loop("solid1");
    const report = (await bus.execute("project.validate", {}, context)).output;
    const graph = bus.store.getGraph();
    // One wire in the file (feedback → output). The name is a parameter, not an edge, and
    // an agent that read 2 here could not address the second one.
    expect(report.edgeCount).toBe(Object.keys(graph.edges).length);
    expect(report.edgeCount).toBe(1);
    expect(report.ok).toBe(true);
  });
});
