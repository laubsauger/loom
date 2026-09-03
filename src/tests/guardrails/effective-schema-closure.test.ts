/**
 * ═══════════════════════════════════════════════════════════════════════════════════
 * §T903 / §V814 — THE FUNNEL IS THE ONLY WAY TO A NODE'S PARAMETER SCHEMA
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * §T880 gave a node the power to derive its own parameters from its own stored source
 * (`NodeDefinition.parametersFor`), so a `customWgsl` publishes its shader's `struct Params`
 * as real controls. Wiring that into the codebase has now failed THREE times in the same
 * shape, and each failure was found by a user rather than by a gate:
 *
 *   §T880  threaded the schema into the paths its author thought of — RESOLUTION.
 *   §B166  found the WRITE paths still on the static schema: every reflected control
 *          rendered with the right value and refused every edit.
 *   §B167  found the ENUMERATING ones: `authorability.test` reported E46's seven knobs as
 *          `Unknown parameter "floorLevel"` — the gate that certifies an example is
 *          reproducible by a user was reporting the opposite of the truth — and the agent's
 *          own node description could not name a single one of them.
 *
 * Each fix was correct. Each declared the domain closed over a list someone happened to
 * think of, which is exactly the claim §V814 says is not a proof: *"I read all N paths" is
 * a list you happened to find, not a proof the list is closed.*
 *
 * So this test IS the closure. It is not a sample and not a convention: it reads every file
 * in the program through the TypeScript checker and reports every expression that reaches a
 * node's parameter SCHEMA without going through `effectiveParameterSchema`. The set it
 * reports is the definition of the set — there is no roster to keep in sync, and a fourth
 * surface fails here before a user can find it.
 *
 * ## What counts as a read
 *
 * A read of a `parameters` property whose TYPE is `ParameterSchema` (never `GraphNode`'s
 * stored values, never a component's published-parameter ARRAY), or of the `parametersFor`
 * hook itself. The test is STRUCTURAL rather than nominal on purpose: the first census of
 * this defect keyed on the name `NodeDefinition` and silently missed `pulse.ts`, which
 * declares its own duck-typed `SchemaSource` and was reading a placed node's schema
 * statically — §V814's mistake reproduced inside the mechanism built to prevent it. Anything
 * shaped like a schema source is a schema source.
 *
 * ## When this test fails
 *
 * If a node instance is in hand, the fix is one line: read the schema through
 * `effectiveParameterSchema(definition, node.parameters)` (`src/domain/parameters/resolve.ts`).
 * If the context genuinely has NO instance — the catalogue, the palette, a manifest audit, a
 * definition's own unit test — then the declared schema is the right answer and the read
 * belongs in `RAW_SCHEMA_READS` below, WITH ITS REASON. The ledger is the record of every
 * place the static schema is deliberate; adding to it is a decision, which is the point.
 */
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** The funnel's own module: the one place these reads are supposed to happen. */
const FUNNEL = "src/domain/parameters/resolve.ts";

/** Reads that are DELIBERATELY of the declared schema, with the reason each one is. */
const TYPE_ONLY_UNIT_TEST =
  "a definition's own unit test asserts what its TYPE declares. No node instance exists in " +
  "the assertion, so there is nothing to reflect from and the static schema IS the subject.";
const CATALOGUE_AUDIT =
  "a catalogue-wide audit over `allNodeDefinitions`: it asks what the manifests DECLARE, " +
  "which is a property of the types and not of any document.";
const COMPONENT_MANIFEST =
  "a component's generated manifest, read at TYPE level (what the component publishes), not " +
  "for a placed instance.";
const REFLECTOR_SELF_READ =
  "a definition composing its OWN reflected schema out of its own static block. This is the " +
  "inside of `parametersFor`, which is what the funnel calls — routing it through the funnel " +
  "would be a cycle.";
const HOOK_UNDER_TEST =
  "the reflection hook itself is the subject: the test calls `parametersFor` directly to " +
  "prove what it reflects.";

const RAW_SCHEMA_READS: Readonly<Record<string, { readonly reason: string; readonly reads: readonly string[] }>> = {
  [FUNNEL]: {
    reason: "THE FUNNEL. Every read below is one this file makes on everyone else's behalf.",
    reads: ["definition.parameters", "definition.parametersFor"],
  },

  // ── Product code that answers a TYPE-level question ────────────────────────────────
  "src/agent/tools/read.ts": {
    reason:
      "`list_node_definitions` and `get_node_definition` answer about a TYPE — the catalogue " +
      "an agent browses before anything is placed. There is no instance, so reflecting would " +
      "be an invention. §T903 gave the INSTANCE-shaped question its own answer: `get_node` " +
      "reports the effective schema, through the funnel.",
    reads: ["definition.parameters", "definition.parameters"],
  },
  "src/domain/media/transport.ts": {
    reason:
      "§V453 classifies a node as media BY WHAT ITS MANIFEST DECLARES, so that media node " +
      "N+1 is classified by construction. A per-instance answer would make the class of a " +
      "node depend on its stored values.",
    reads: ["definition.parameters"],
  },
  "src/editor/help/node-reference.ts": {
    reason: "the help page documents a node TYPE, before and independently of any placement.",
    reads: ["definition.parameters"],
  },
  "src/nodes/registry/registry.ts": {
    reason:
      "manifest validation at REGISTRATION (§V46): the declared schema is what is being " +
      "validated, and no node of the type exists yet.",
    reads: ["definition.parameters"],
  },
  "src/editor/component/component-page.tsx": {
    reason:
      "a props destructure of a schema that was ALREADY read through the funnel one scope up " +
      "(the publish list for the selected node). Propagation, not a second lookup.",
    reads: ["destructured parameters"],
  },

  // ── Definitions reflecting their own declarations (§T880, §T900) ───────────────────
  "src/nodes/definitions/points.ts": { reason: REFLECTOR_SELF_READ, reads: ["pointKernelNode.parameters", "pointKernelNode.parameters"] },
  "src/nodes/definitions/point-kernel-advanced.ts": {
    reason: REFLECTOR_SELF_READ,
    reads: ["pointKernelAdvancedNode.parameters", "pointKernelAdvancedNode.parameters"],
  },
  "src/nodes/definitions/custom-wgsl.test.ts": {
    reason: `${TYPE_ONLY_UNIT_TEST} ${HOOK_UNDER_TEST}`,
    reads: [
      "customWgslNode.parameters",
      "customWgslNode.parameters",
      "customWgslNode.parameters",
      "customWgslNode.parametersFor",
      "customWgslNode.parametersFor",
    ],
  },
  "src/nodes/definitions/depth.test.ts": {
    reason:
      `${TYPE_ONLY_UNIT_TEST} The one read is §T880's own rule under test (T965): the STATIC ` +
      "schema must contain every key a fresh drop stores, so the assertion walks the declared " +
      "block and checks each key survives into the computed one. Everything else in that file " +
      "goes through the funnel, which is why there is exactly one.",
    reads: ["depthNode.parameters"],
  },
  "src/nodes/definitions/point-kernel-params.test.ts": {
    reason: HOOK_UNDER_TEST,
    reads: [
      "pointKernelNode.parametersFor",
      "pointKernelNode.parametersFor",
      "pointKernelNode.parametersFor",
      "pointKernelNode.parametersFor",
      "pointKernelNode.parametersFor",
    ],
  },

  // ── Catalogue-wide audits ──────────────────────────────────────────────────────────
  "src/domain/parameters/parameter-range.test.ts": { reason: CATALOGUE_AUDIT, reads: ["definition.parameters"] },
  "src/domain/transport/loop-continuity.test.ts": {
    reason: CATALOGUE_AUDIT,
    reads: ["definition.parameters", "definition.parameters"],
  },
  "src/domain/transport/shipped-clock-audit.test.ts": { reason: CATALOGUE_AUDIT, reads: ["definition.parameters"] },
  "src/tests/guardrails/parameter-precision.test.ts": {
    reason: CATALOGUE_AUDIT,
    reads: ["definition.parameters", "definition.parameters", "definition.parameters", "lfoNode.parameters"],
  },
  "src/tests/guardrails/code-parameter-order.test.ts": {
    reason:
      `${CATALOGUE_AUDIT} §T1052 derives the set of node types that DECLARE a code parameter ` +
      "from `allNodeDefinitions` rather than listing the two anybody would name (§V316), so " +
      "the subject of the audit is a property of the manifests. It then reads `parametersFor` " +
      `directly for the reflected half — ${HOOK_UNDER_TEST}`,
    reads: [
      "definition.parameters",
      "definition.parameters",
      "definition.parameters",
      "definition.parameters",
      "definition.parameters",
      "definition.parameters",
      "definition.parametersFor",
    ],
  },
  "src/nodes/definitions/index.test.ts": {
    reason: CATALOGUE_AUDIT,
    reads: ["definition.parameters", "definition.parameters", "definition.parameters", "text.parameters"],
  },
  "src/runtime/backend/vgpu/camera-wiring.gpu.test.ts": {
    reason: CATALOGUE_AUDIT,
    reads: ["cameraNode.parameters", "cameraNode.parameters", "definition.parameters"],
  },

  // ── Component manifests, at type level ─────────────────────────────────────────────
  "src/domain/components/commands.test.ts": { reason: COMPONENT_MANIFEST, reads: ["manifest.parameters"] },
  "src/domain/components/parameter-page.test.ts": {
    reason: COMPONENT_MANIFEST,
    reads: ["after.parameters", "before.parameters"],
  },
  "src/domain/components/publishable.test.ts": {
    reason: COMPONENT_MANIFEST,
    reads: ["manifest.parameters", "manifest.parameters", "manifest.parameters"],
  },
  "src/domain/components/registry.test.ts": { reason: COMPONENT_MANIFEST, reads: ["manifest.parameters"] },
  "src/editor/help/help-reference.test.ts": { reason: COMPONENT_MANIFEST, reads: ["manifest.parameters"] },

  // ── A definition's own unit test ───────────────────────────────────────────────────
  "src/agent/surface.test.ts": { reason: TYPE_ONLY_UNIT_TEST, reads: ["solidNode.parameters", "solidNode.parameters"] },
  "src/domain/channels/graph-channels.test.ts": { reason: TYPE_ONLY_UNIT_TEST, reads: ["blurNode.parameters"] },
  "src/domain/channels/value-graph.test.ts": {
    reason: TYPE_ONLY_UNIT_TEST,
    reads: ["valueFilterNode.parameters", "valueFilterNode.parameters", "valueLagNode.parameters"],
  },
  "src/domain/commands/parameter-commands.test.ts": {
    reason: TYPE_ONLY_UNIT_TEST,
    reads: [
      "menuNode.parameters",
      "menuNode.parameters",
      "menuNode.parameters",
      "menuNode.parameters",
      "menuNode.parameters",
      "menuNode.parameters",
      "menuNode.parameters",
    ],
  },
  "src/domain/parameters/resolve.test.ts": { reason: TYPE_ONLY_UNIT_TEST, reads: ["solidLike.parameters"] },
  "src/domain/parameters/stored-values.test.ts": { reason: TYPE_ONLY_UNIT_TEST, reads: ["solid.parameters"] },
  "src/editor/inspector/parameter-resolver.test.ts": {
    reason: TYPE_ONLY_UNIT_TEST,
    reads: ["blurNode.parameters", "solidNode.parameters"],
  },
  "src/examples/audio-level-claims.test.ts": {
    reason: TYPE_ONLY_UNIT_TEST,
    reads: ["valueLagNode.parameters", "valueLagNode.parameters"],
  },
  "src/nodes/definitions/audio.test.ts": { reason: TYPE_ONLY_UNIT_TEST, reads: ["definition.parameters"] },
  "src/nodes/definitions/cache.test.ts": {
    reason: TYPE_ONLY_UNIT_TEST,
    reads: ["cacheNode.parameters", "cacheNode.parameters"],
  },
  "src/nodes/definitions/color.test.ts": { reason: TYPE_ONLY_UNIT_TEST, reads: ["levelNode.parameters"] },
  "src/nodes/definitions/composite.test.ts": {
    reason: TYPE_ONLY_UNIT_TEST,
    reads: [
      "compositeNode.parameters",
      "compositeNode.parameters",
      "compositeNode.parameters",
      "crossNode.parameters",
      "crossNode.parameters",
      "node.parameters",
    ],
  },
  "src/nodes/definitions/feedback.test.ts": {
    reason: TYPE_ONLY_UNIT_TEST,
    reads: ["feedbackNode.parameters", "feedbackNode.parameters", "feedbackNode.parameters"],
  },
  "src/nodes/definitions/filters.test.ts": {
    reason: TYPE_ONLY_UNIT_TEST,
    reads: ["convolveNode.parameters", "displaceNode.parameters", "slopeNode.parameters", "uvNode.parameters"],
  },
  "src/nodes/definitions/generators.test.ts": { reason: TYPE_ONLY_UNIT_TEST, reads: ["rampNode.parameters"] },
  "src/nodes/definitions/media.test.ts": {
    reason: TYPE_ONLY_UNIT_TEST,
    reads: ["textNode.parameters", "textNode.parameters"],
  },
  "src/nodes/definitions/noise.test.ts": { reason: TYPE_ONLY_UNIT_TEST, reads: ["noiseNode.parameters"] },
  "src/nodes/definitions/output.test.ts": {
    reason: TYPE_ONLY_UNIT_TEST,
    reads: ["outputNode.parameters", "outputNode.parameters"],
  },
  "src/nodes/definitions/point-generators.test.ts": {
    reason: TYPE_ONLY_UNIT_TEST,
    reads: [
      "pointGeneratorNode.parameters",
      "pointGeneratorNode.parameters",
      "pointGeneratorNode.parameters",
      "pointSphereNode.parameters",
      "pointSphereNode.parameters",
      "pointSphereNode.parameters",
    ],
  },
  "src/nodes/definitions/slit-scan.test.ts": { reason: TYPE_ONLY_UNIT_TEST, reads: ["slitScanNode.parameters"] },
  "src/nodes/definitions/solid.test.ts": {
    reason: TYPE_ONLY_UNIT_TEST,
    reads: ["solidNode.parameters", "solidNode.parameters"],
  },
  "src/nodes/definitions/switch.test.ts": { reason: TYPE_ONLY_UNIT_TEST, reads: ["switchNode.parameters"] },
  "src/nodes/definitions/transforms.test.ts": {
    reason: TYPE_ONLY_UNIT_TEST,
    reads: ["flipNode.parameters", "mirrorNode.parameters", "transformNode.parameters"],
  },
  "src/nodes/definitions/value-switch.test.ts": { reason: TYPE_ONLY_UNIT_TEST, reads: ["valueSwitchNode.parameters"] },
};

interface SchemaRead {
  /** Repo-relative path. */
  readonly file: string;
  /** The receiver expression plus the property, e.g. `definition.parameters`. */
  readonly read: string;
  readonly line: number;
}

/**
 * Every expression in `program` that reaches a parameter SCHEMA off a schema source.
 *
 * Kept deliberately dumb about WHO the receiver is: it asks whether the value carries a
 * `parameters` property typed as the schema, or the `parametersFor` hook. A `GraphNode`'s
 * stored values are `Record<string, StoredParameter>` and a component's published parameters
 * are an ARRAY, so neither can be mistaken for one.
 */
function collectSchemaReads(program: ts.Program, checker: ts.TypeChecker, root: string): SchemaRead[] {
  const nameOf = (type: ts.Type | undefined): string | undefined =>
    (type?.aliasSymbol ?? type?.getSymbol())?.getName();

  const isSchemaType = (type: ts.Type | undefined): boolean => {
    if (type === undefined) return false;
    if (nameOf(type) === "ParameterSchema") return true;
    // An inlined `Record<string, ParameterDefinition>` is the same thing without the alias.
    const index = checker.getIndexTypeOfType(type, ts.IndexKind.String);
    return index !== undefined && nameOf(index) === "ParameterDefinition";
  };

  const carriesSchema = (type: ts.Type | undefined, at: ts.Node, property: string): boolean => {
    if (type === undefined) return false;
    const parts = type.isUnionOrIntersection() ? type.types : [type];
    for (const part of parts) {
      const symbol = part.getProperty(property);
      if (symbol === undefined) continue;
      if (property === "parametersFor") return true;
      if (isSchemaType(checker.getTypeOfSymbolAtLocation(symbol, at))) return true;
    }
    return false;
  };

  const isSchemaProperty = (name: string): boolean => name === "parameters" || name === "parametersFor";
  const found: SchemaRead[] = [];

  for (const source of program.getSourceFiles()) {
    if (source.isDeclarationFile) continue;
    if (!source.fileName.startsWith(root)) continue;
    const file = path.relative(REPO_ROOT, source.fileName);
    const record = (node: ts.Node, read: string): void => {
      found.push({ file, read, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
    };

    const walk = (node: ts.Node): void => {
      let receiver: ts.Expression | undefined;
      let property: string | undefined;
      if (ts.isPropertyAccessExpression(node) && isSchemaProperty(node.name.text)) {
        receiver = node.expression;
        property = node.name.text;
      } else if (
        ts.isElementAccessExpression(node) &&
        node.argumentExpression !== undefined &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        isSchemaProperty(node.argumentExpression.text)
      ) {
        receiver = node.expression;
        property = node.argumentExpression.text;
      }
      if (receiver !== undefined && property !== undefined) {
        if (carriesSchema(checker.getTypeAtLocation(receiver), receiver, property)) {
          record(node, `${receiver.getText().replace(/\s+/g, " ")}.${property}`);
        }
      }

      // `const { parameters } = definition` reaches the same value by another spelling.
      if (ts.isObjectBindingPattern(node)) {
        const parent = node.parent;
        const subject = ts.isVariableDeclaration(parent)
          ? parent.initializer
          : ts.isParameter(parent)
            ? parent
            : undefined;
        const type = subject === undefined ? undefined : checker.getTypeAtLocation(subject);
        for (const element of node.elements) {
          const name = element.propertyName ?? element.name;
          if (!ts.isIdentifier(name) || !isSchemaProperty(name.text)) continue;
          if (carriesSchema(type, node, name.text)) record(element, `destructured ${name.text}`);
        }
      }

      ts.forEachChild(node, walk);
    };
    walk(source);
  }
  return found;
}

function programOf(configPath: string): { program: ts.Program; checker: ts.TypeChecker } {
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error !== undefined) throw new Error(`cannot read ${configPath}`);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  return { program, checker: program.getTypeChecker() };
}

function tally(entries: readonly { file: string; read: string }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const key = `${entry.file} :: ${entry.read}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

const FIX =
  "\n\nFIX: if a node instance is in hand, read its schema through " +
  "`effectiveParameterSchema(definition, node.parameters)` (src/domain/parameters/resolve.ts) — " +
  "that is the ONE way to a node's parameters (§T903). If this context has no instance (the " +
  "catalogue, the palette, a manifest audit, a definition's own unit test), the declared " +
  "schema is right and the read belongs in RAW_SCHEMA_READS with its reason.";

describe("§T903 — nothing reads a node's parameter schema outside the funnel", () => {
  const collected = (() => {
    const { program, checker } = programOf(path.join(REPO_ROOT, "tsconfig.app.json"));
    return collectSchemaReads(program, checker, path.join(REPO_ROOT, "src"));
  })();

  const allowed = tally(
    Object.entries(RAW_SCHEMA_READS).flatMap(([file, entry]) => entry.reads.map((read) => ({ file, read }))),
  );
  const actual = tally(collected);

  it("finds no raw schema read that is not named and reasoned", () => {
    const unlisted = [...actual]
      .filter(([key, count]) => count > (allowed.get(key) ?? 0))
      .map(([key, count]) => `${key} (found ${count}, allowed ${allowed.get(key) ?? 0})`)
      .sort();

    expect(
      unlisted,
      "a surface reads a node's parameter schema WITHOUT the funnel. This is the shape that " +
        "shipped three times: §T880 wired resolution, §B166 found the writes, §B167 found the " +
        "enumerating validators — and E46's seven reflected knobs were reported as unknown " +
        "parameters by the gate that certifies an example is authorable." +
        FIX,
    ).toEqual([]);
  }, 180_000);

  it("keeps no ledger entry for a read that no longer exists (§V458)", () => {
    const stale = [...allowed]
      .filter(([key, count]) => count > (actual.get(key) ?? 0))
      .map(([key, count]) => `${key} (allowed ${count}, found ${actual.get(key) ?? 0})`)
      .sort();

    expect(
      stale,
      "RAW_SCHEMA_READS names a raw read that is not there any more. A ledger nobody prunes " +
        "becomes a permanent excuse for a defect that no longer exists — strike the entry.",
    ).toEqual([]);
  }, 180_000);

  /**
   * The vacuity guard, and the honest half of the claim: a collector that matched NOTHING
   * would make both tests above pass forever. So the pattern is fired at a file written for
   * the purpose, containing exactly the defect §B167 was — a placed node's schema read off
   * its definition — and it must come back caught.
   */
  it("catches a NEW raw read, in a file it has never seen", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "shaderloom-closure-"));
    try {
      const nodeDefinition = path.join(REPO_ROOT, "src/domain/types/node-definition.ts");
      const graph = path.join(REPO_ROOT, "src/domain/types/graph.ts");
      const file = path.join(directory, "fourth-surface.ts");
      writeFileSync(
        file,
        [
          `import type { NodeDefinition } from ${JSON.stringify(nodeDefinition)};`,
          `import type { GraphNode } from ${JSON.stringify(graph)};`,
          "",
          "export function unknownParameters(definition: NodeDefinition, node: GraphNode): string[] {",
          "  return Object.keys(node.parameters).filter((key) => definition.parameters[key] === undefined);",
          "}",
          "",
        ].join("\n"),
        "utf8",
      );

      const config = ts.readConfigFile(path.join(REPO_ROOT, "tsconfig.app.json"), ts.sys.readFile);
      const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, REPO_ROOT);
      const program = ts.createProgram([file], parsed.options);
      const caught = collectSchemaReads(program, program.getTypeChecker(), directory);

      // Exactly one read, and it is the schema one: `node.parameters` in the same expression
      // is stored VALUES, and a pattern that reported those would fill the ledger with noise
      // until nobody read it.
      expect(caught.map((entry) => entry.read)).toEqual(["definition.parameters"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 180_000);

  it("is reading the repo it claims to read", () => {
    // If the program came up empty (a moved tsconfig, a renamed source root) the two gates
    // above would pass by finding nothing at all — the failure mode a closure test cannot have.
    expect(collected.length).toBeGreaterThan(50);
    expect(collected.some((entry) => entry.file === FUNNEL)).toBe(true);
  });
});
