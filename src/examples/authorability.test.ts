import { describe, expect, it } from "vitest";

import { isComponentNodeType, parseComponentNodeType } from "../domain/components/component-type.ts";
import { componentLibrarySchema } from "../domain/components/schemas.ts";
import {
  componentDefinition,
  componentNamesFor,
  parseComponentKey,
  validateParameters,
} from "../domain/parameters/index.ts";
import { numericRangeOf } from "../domain/parameters/expression-range.ts";
import { createComponentSystem } from "../domain/components/registry.ts";
import { COMPONENT_LIBRARY_KEY, buildProjectFile, loadProject } from "../domain/project/index.ts";
import type { GraphComponentDefinition } from "../domain/types/components.ts";
import type { NumberParameter, ParameterDefinition } from "../domain/types/parameters.ts";
import { projectDocumentSchema } from "../domain/types/schemas.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import { listExamples, listStarterComponentFiles } from "./catalogue.ts";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════
 * T848 — IS EVERY SHIPPED EXAMPLE SOMETHING A USER COULD HAVE MADE?
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * The owner: *"all of our examples would be reproducable by anyone just with raw nodes
 * right? we're not doing any kind of special dances there that a user via UI or an agent
 * or whatnot couldn't recreate right?"*
 *
 * The honest answer before this file existed: **the FORMAT is gated, AUTHORABILITY is
 * not.** §V88 proves an example is a real `.loom.json` opened by the same loader a user's
 * file goes through. §V94 proves a shipped component is the same `GraphComponentDefinition`
 * a user saves. `component-sync.test.ts` re-validates the shipped definition through the
 * same zod schema a user's file is validated by. Every one of those is about the FILE
 * being well-formed. None of them says the values inside it are ones a control can
 * produce — and a document can be schema-valid and still hold something no UI affordance
 * reaches.
 *
 * §T823 is the proof that the gap bites. `AudioLevel` shipped `releaseRatio: 100` while
 * that parameter's slider travel stopped at 10: legal (`range: "floor"` means the max is
 * travel, not a limit) and reachable only by TYPING, never by dragging. It shipped, and
 * the fix was to widen the travel — the example was right, the control was short.
 *
 * ## The four assertions, and why each is a different question
 *
 *  (a) **REACHABLE NODE** — every node type used appears in the NODE BROWSER's list, or
 *      is a component instance whose definition ships beside it. The inverse of §T728's
 *      census: that one measured types with no example, this measures examples using a
 *      type a user could not find.
 *  (b) **REACHABLE VALUE** — in two halves, because "out of range" is two different
 *      facts. (b1) is the hard one: every stored parameter survives `validateParameters`,
 *      *the function the command bus runs on a user's or an agent's edit*. A value it
 *      refuses is a value no UI and no patch could have written — a special dance in the
 *      literal sense. (b2) is §T823's class: a value beyond a NON-clamping end is legal,
 *      but the slider stops before it, so it is typing-only. Legal is not the same as
 *      reachable, so it is CENSUSED BY NAME rather than failed.
 *  (c) **NO UNNAMED KEY** — component-sync's discipline, extended from components to
 *      documents. Its check asks whether the schema ACCEPTS the definition; zod strips
 *      silently, so acceptance says nothing about what SURVIVES. This asks the stronger
 *      question: does every key in the shipped bytes come back out of a closed parse?
 *  (d) **THE ROUND TRIP** (T856, §V802) — the consequence of (c), measured end to end:
 *      open the file the way the app opens it, save it the way the app saves it, compare.
 *      §T848 found (c) by reasoning about a schema and CONFIRMED it here, by measuring
 *      `AudioLevel` losing `range: "floor"` on save while reporting `changed === false`.
 *      Fixing the named key without this gate would leave the next unnamed one to repeat
 *      it.
 *
 * ## Why the exceptions are lists with reasons rather than fixes
 *
 * The owner, on what to do about a finding: *"dont break or dumb down the examples,
 * rather figure out how to make it achievable if theres gaps. dont break what we have
 * now in a weird way. so increase ranges and whatnot."* A value outside its control's
 * travel means the CONTROL is short, exactly as §T823 ruled — so the repair is a widened
 * declaration, which is public catalogue surface and the owner's call, not this file's.
 * Editing an example to make this gate green would be the one outcome that destroys the
 * gate's whole purpose: **a gate that can be satisfied by weakening its subject is not a
 * gate.**
 *
 * So each known finding is pinned BY NAME with the value that needs reaching and the
 * change it argues for (§V458's census shape, as `BOUNDED_DEGREES` does it). Pinned in
 * both directions: finding number four fails below, and a finding that gets FIXED must be
 * struck from the list or the list rots into an excuse (§V421).
 *
 * Source-level and cheap: no device, no render, no compile. It reads the shipped bytes
 * and the registry.
 */

const registry = createNodeRegistry(allNodeDefinitions);

/**
 * The list the node browser actually renders.
 *
 * `side-panes.tsx` builds it as `registry.list()` minus component instances, and that
 * subtraction is the half of this assertion the existing placeholder check cannot make:
 * `runner.test.ts` already proves no example names a type the loader lacks, which for an
 * ordinary node is the same question. A `component:<id>@<version>` type is registered and
 * loads fine, and is deliberately ABSENT from the node browser — its verb is instantiate,
 * not add (§V93) — so for those the reachability question has a different answer, below.
 */
const BROWSABLE = new Set(
  registry
    .list()
    .filter((definition) => !isComponentNodeType(definition.type))
    .map((definition) => definition.type),
);

interface Subject {
  readonly fileName: string;
  readonly text: string;
  readonly raw: Record<string, unknown>;
}

/** Every shipped `.loom.json`: the examples and the starter components' demo files. */
const SUBJECTS: readonly Subject[] = [...listExamples(), ...listStarterComponentFiles()].map(
  (file) => ({
    fileName: file.fileName,
    text: file.text,
    raw: JSON.parse(file.text) as Record<string, unknown>,
  }),
);

interface RawNode {
  readonly id: string;
  readonly type: string;
  readonly parameters?: Record<string, unknown>;
}

/** Every graph a shipped file carries: its own, plus each component definition's. */
function graphsOf(subject: Subject): ReadonlyArray<{ where: string; nodes: readonly RawNode[] }> {
  const own = subject.raw["graph"] as { nodes: Record<string, RawNode> };
  const library = subject.raw[COMPONENT_LIBRARY_KEY] as
    | { components?: readonly GraphComponentDefinition[] }
    | undefined;
  return [
    { where: subject.fileName, nodes: Object.values(own.nodes) },
    ...(library?.components ?? []).map((definition) => ({
      where: `${subject.fileName}#${definition.componentId}`,
      nodes: Object.values(definition.graph.nodes) as unknown as readonly RawNode[],
    })),
  ];
}

/* ------------------------------------------------------------------------------------
 * (a) every node type is one a user could find
 * ---------------------------------------------------------------------------------- */

describe("(a) every node type in a shipped example is reachable from a browser", () => {
  it("uses only types the node library lists, or components that ship beside them", () => {
    const unreachable: string[] = [];
    for (const subject of SUBJECTS) {
      const library = subject.raw[COMPONENT_LIBRARY_KEY] as
        | { components?: readonly GraphComponentDefinition[] }
        | undefined;
      const shippedComponents = new Set(
        (library?.components ?? []).map((definition) => `${definition.componentId}@${definition.version}`),
      );
      for (const { where, nodes } of graphsOf(subject)) {
        for (const node of nodes) {
          if (BROWSABLE.has(node.type)) continue;
          // A component instance is found in the COMPONENT library, not the node library
          // (§V93) — so it is reachable exactly when the definition it pins is installed.
          const ref = parseComponentNodeType(node.type);
          if (ref !== null && shippedComponents.has(`${ref.componentId}@${ref.version}`)) continue;
          unreachable.push(`${where}/${node.id} uses "${node.type}"`);
        }
      }
    }
    expect(
      unreachable,
      "a shipped example names a node type nothing offers: it is not in the node browser " +
        "and it is not a component instance whose definition rides in the same file. A user " +
        "opening this example cannot build another one like it (§T728's census, inverted).",
    ).toEqual([]);
  });

  it("the census reaches the whole shipped set — it can actually bite", () => {
    // Vacuity guard (§V461): an empty SUBJECTS or a graphsOf that found nothing would
    // satisfy the assertion above perfectly. Shape of the catalogue, not a target.
    const nodes = SUBJECTS.flatMap((subject) => graphsOf(subject)).flatMap((graph) => graph.nodes);
    expect(SUBJECTS.length).toBeGreaterThan(35);
    expect(nodes.length).toBeGreaterThan(700);
    expect(new Set(nodes.map((node) => node.type)).size).toBeGreaterThan(60);
    // And the two branches above are BOTH exercised: component instances are shipped.
    expect(nodes.some((node) => isComponentNodeType(node.type))).toBe(true);
  });
});

/* ------------------------------------------------------------------------------------
 * (b1) every value is one the command bus would have accepted
 * ---------------------------------------------------------------------------------- */

/**
 * Values the app's own write gate refuses, pinned by name and awaiting a ruling.
 *
 * Each entry names the change it argues for. The rule from §T823 and from the owner is
 * that the CONTROL is the defect, so the repair is a widened declaration — never a
 * retuned example. An entry leaves this list when the declaration moves, and the test
 * below fails if an entry is still listed after it stops being true.
 *
 * EMPTY, and struck rather than emptied by hand (T856). §T848 found one: E35's
 * `renderpoints1.sizePixels` retained 0 against a `floor` of 0.5 — the fallback for a
 * detached drive, which the author wanted to be INVISIBLE. Ruled ruling 1: the floor
 * moved to 0, because "draw nothing" is a meaningful state and 0 is the only value that
 * says it. The example was never touched.
 */
const REFUSED_PENDING_RULING: Readonly<Record<string, string>> = {};

function describeRefusal(where: string, node: RawNode, code: string, message: string): string {
  return `${where}/${node.id} (${node.type}) ${code}: ${message}`;
}

describe("(b1) every stored value is one the command bus would accept", () => {
  /**
   * `validateParameters` is not a re-implementation of the rules — it IS the rule.
   * `apply-patch.ts` runs it on `graph.setParameters`, which is the single write path for
   * an inspector edit, an agent patch and a WebMCP call alike (§V29). So a value it
   * refuses is a value that CANNOT have been produced by any of them, whatever the file
   * says. That is the owner's "special dance" stated precisely enough to test.
   */
  it("refuses nothing outside the named, reasoned list", () => {
    const refused: string[] = [];
    for (const subject of SUBJECTS) {
      for (const { where, nodes } of graphsOf(subject)) {
        for (const node of nodes) {
          const definition = registry.get(node.type);
          if (definition === undefined) continue; // (a) owns unknown types.
          for (const diagnostic of validateParameters(
            definition.parameters,
            (node.parameters ?? {}) as never,
            node.id,
          )) {
            refused.push(describeRefusal(where, node, diagnostic.code, diagnostic.message));
          }
        }
      }
    }
    const unexplained = refused.filter((entry) => REFUSED_PENDING_RULING[entry] === undefined);
    expect(
      unexplained,
      "a shipped example holds a parameter value the command bus would REFUSE, so no UI " +
        "edit and no agent patch could have written it. Do NOT retune the example to make " +
        "this pass — §T823's precedent is that the CONTROL is short. Widen the declaration, " +
        "or add the finding to REFUSED_PENDING_RULING with the change it argues for.",
    ).toEqual([]);

    // Both directions (§V458): a fixed finding must be struck from the list, or the list
    // is a permanent excuse for a defect that no longer exists (§V421).
    const stale = Object.keys(REFUSED_PENDING_RULING).filter((entry) => !refused.includes(entry));
    expect(stale, "REFUSED_PENDING_RULING names a refusal that no longer happens.").toEqual([]);
  });

  it("checks every node in the shipped set", () => {
    const nodes = SUBJECTS.flatMap((subject) => graphsOf(subject)).flatMap((graph) => graph.nodes);
    const withParameters = nodes.filter(
      (node) => registry.get(node.type) !== undefined && Object.keys(node.parameters ?? {}).length > 0,
    );
    // Vacuity guard: `validateParameters` over an empty bag reports nothing at all.
    expect(withParameters.length).toBeGreaterThan(700);
  });
});

/* ------------------------------------------------------------------------------------
 * (b2) §T823's class: legal, but past where the slider stops
 * ---------------------------------------------------------------------------------- */

/**
 * A value beyond a non-clamping end — legal, and reachable only by typing.
 *
 * This is EXACTLY what shipped in `AudioLevel` before §T823: `range: "floor"` means the
 * max is travel rather than a limit, so a larger value resolves correctly and nothing
 * complains — while the slider stops short of it and dragging can never get there. The
 * declaration explains why the value need not fail; it does not explain why the control
 * cannot reach it, and those are different claims.
 *
 * EMPTY (T856). §T848 found one: `limit.high = 6` in E13-Prism, E33-Obol and E34-Lidar,
 * each clamping HDR headroom before tone-mapping, against travel that stopped at 4.
 * Ruled ruling 2: `limit.low`/`limit.high` travel widened to ±8. Same disposition as
 * §T823's own — the value was right and the slider was short.
 */
const TYPING_ONLY_PENDING_RULING: Readonly<Record<string, string>> = {};

interface Overshoot {
  readonly id: string;
  readonly value: number;
  readonly parameter: NumberParameter;
}

/** Every static number a stored parameter carries, in every retained mode (§V108). */
function staticNumbersOf(stored: unknown): unknown[] {
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) return [stored];
  const slot = stored as { mode?: unknown; bindings?: Record<string, { kind?: string; value?: unknown }> };
  if (slot.mode === undefined || slot.bindings === undefined) return [];
  return Object.values(slot.bindings)
    .filter((binding) => binding?.kind === "static")
    .map((binding) => binding.value);
}

/** The numeric definition a stored key answers to, compound components included (§V113). */
function numericDefinitionFor(
  schema: Readonly<Record<string, ParameterDefinition>>,
  key: string,
): ParameterDefinition | undefined {
  const direct = schema[key];
  if (direct !== undefined) return direct;
  const parsed = parseComponentKey(key);
  if (parsed === null) return undefined;
  const base = schema[parsed.base];
  if (base === undefined) return undefined;
  const names = componentNamesFor(base);
  const index = names === null ? -1 : names.indexOf(parsed.component);
  return index < 0 ? undefined : componentDefinition(base, parsed.component, index);
}

function overshootsOf(definition: ParameterDefinition, key: string, value: unknown): Overshoot[] {
  if (definition.type !== "number" && definition.type !== "vector") return [];
  const numbers =
    typeof value === "number"
      ? [value]
      : Array.isArray(value) && value.every((entry) => typeof entry === "number")
        ? (value as number[])
        : [];
  // The ends that CLAMP are (b1)'s business — a value past one of those is refused, not
  // merely hard to drag to. This half is about the ends that are only slider travel.
  const clamping = numericRangeOf(definition);
  const found: Overshoot[] = [];
  for (const number of numbers) {
    const belowTravel = definition.min !== undefined && number < definition.min;
    const aboveTravel = definition.max !== undefined && number > definition.max;
    if (!belowTravel && !aboveTravel) continue;
    if (belowTravel && clamping?.min !== null && clamping?.min !== undefined) continue;
    if (aboveTravel && clamping?.max !== null && clamping?.max !== undefined) continue;
    found.push({
      id: `${key} = ${number} (travel ${definition.min ?? "−∞"}…${definition.max ?? "∞"}, range ${definition.range ?? "bounded"})`,
      value: number,
      parameter: definition as NumberParameter,
    });
  }
  return found;
}

describe("(b2) values past the end of their slider are censused, not assumed fine", () => {
  it("finds only the typing-only values that are named and reasoned", () => {
    const found = new Set<string>();
    for (const subject of SUBJECTS) {
      for (const { nodes } of graphsOf(subject)) {
        for (const node of nodes) {
          const definition = registry.get(node.type);
          if (definition === undefined) continue;
          for (const [key, stored] of Object.entries(node.parameters ?? {})) {
            const parameter = numericDefinitionFor(definition.parameters, key);
            if (parameter === undefined) continue;
            for (const value of staticNumbersOf(stored)) {
              for (const overshoot of overshootsOf(parameter, `${node.type}.${key}`, value)) {
                found.add(overshoot.id);
              }
            }
          }
        }
      }
    }
    const unexplained = [...found].filter((id) => TYPING_ONLY_PENDING_RULING[id] === undefined);
    expect(
      unexplained,
      "a shipped example holds a value the slider cannot be dragged to. It is LEGAL — the " +
        "end it passes is travel, not a limit — but §T823 shipped exactly this and the " +
        "ruling was to widen the travel so the common use is reachable. Add it to " +
        "TYPING_ONLY_PENDING_RULING with the change it argues for, or widen the control.",
    ).toEqual([]);

    const stale = Object.keys(TYPING_ONLY_PENDING_RULING).filter((id) => !found.has(id));
    expect(stale, "TYPING_ONLY_PENDING_RULING names an overshoot that no longer exists.").toEqual([]);
  });

  it("reads numbers out of compound keys and retained bindings too", () => {
    // The two shapes that would silently empty this census: `transform.t.x` (a compound
    // COMPONENT key, which is not in the schema under that name) and a slot's retained
    // static value (which is not a bare number). §T823's own case was the second kind.
    let compoundNumbers = 0;
    let retainedNumbers = 0;
    for (const subject of SUBJECTS) {
      for (const { nodes } of graphsOf(subject)) {
        for (const node of nodes) {
          const definition = registry.get(node.type);
          if (definition === undefined) continue;
          for (const [key, stored] of Object.entries(node.parameters ?? {})) {
            if (definition.parameters[key] === undefined) {
              if (numericDefinitionFor(definition.parameters, key) !== undefined) compoundNumbers += 1;
              continue;
            }
            if (typeof stored === "object" && stored !== null && !Array.isArray(stored)) {
              retainedNumbers += staticNumbersOf(stored).filter((v) => typeof v === "number").length;
            }
          }
        }
      }
    }
    expect(compoundNumbers).toBeGreaterThan(50);
    expect(retainedNumbers).toBeGreaterThan(50);
  });
});

/* ------------------------------------------------------------------------------------
 * (c) no key the document schema does not name
 * ---------------------------------------------------------------------------------- */

/**
 * Keys a shipped file carries that a CLOSED parse drops, pinned by name.
 *
 * The loader is deliberately open (§V68): `openProjectDocumentSchema` is `.passthrough()`
 * everywhere, so a file from a future build keeps every byte it arrived with. That is
 * right for a USER's file and says nothing about OURS. A shipped example needing
 * forward-compat to survive its own loader is a file this build cannot fully read.
 *
 * EMPTY (T856). §T848 found two, both `range` on a published component parameter:
 * `parameterDefinitionSchema` did not name it, so a closed parse dropped it and the
 * loader installed the stripped copy. Ruled ruling 3: `range` is named on the number and
 * vector arms. The round-trip gate below is what stops the NEXT unnamed key repeating it
 * — this assertion catches a key the schema forgets, that one catches the consequence
 * (§V802).
 */
const UNNAMED_KEYS_PENDING_RULING: Readonly<Record<string, string>> = {};

/** Every path present in `raw` but missing from `kept` — what a closed parse stripped. */
function strippedPaths(raw: unknown, kept: unknown, path = ""): string[] {
  if (raw === null || typeof raw !== "object") return [];
  if (Array.isArray(raw)) {
    if (!Array.isArray(kept)) return [path];
    return raw.flatMap((item, index) => strippedPaths(item, kept[index], `${path}[${index}]`));
  }
  if (kept === null || typeof kept !== "object" || Array.isArray(kept)) return [path];
  const out: string[] = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const here = path === "" ? key : `${path}.${key}`;
    if (!(key in (kept as Record<string, unknown>))) out.push(here);
    else out.push(...strippedPaths(value, (kept as Record<string, unknown>)[key], here));
  }
  return out;
}

describe("(c) a shipped file carries no key the closed schema does not name", () => {
  it("survives a closed parse with nothing stripped, or names why not", () => {
    const stripped: string[] = [];
    for (const subject of SUBJECTS) {
      const { [COMPONENT_LIBRARY_KEY]: library, ...document } = subject.raw;
      const parsed = projectDocumentSchema.safeParse(document);
      if (!parsed.success) {
        stripped.push(
          `${subject.fileName}: the closed document schema REJECTED it — ${parsed.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; ")}`,
        );
      } else {
        for (const path of strippedPaths(document, parsed.data)) {
          stripped.push(`${subject.fileName}: ${path}`);
        }
      }
      if (library === undefined) continue;
      const parsedLibrary = componentLibrarySchema.safeParse(library);
      if (!parsedLibrary.success) {
        stripped.push(
          `${subject.fileName}: the component library schema REJECTED it — ${parsedLibrary.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; ")}`,
        );
        continue;
      }
      for (const path of strippedPaths(library, parsedLibrary.data)) {
        stripped.push(`${subject.fileName}: ${COMPONENT_LIBRARY_KEY}.${path}`);
      }
    }
    const unexplained = stripped.filter((entry) => UNNAMED_KEYS_PENDING_RULING[entry] === undefined);
    expect(
      unexplained,
      "a shipped file carries a key the closed schema does not name. It survives today " +
        "only because the loader is `.passthrough()` for forward compatibility (§V68) — " +
        "which is a promise to files from the FUTURE, not a place for our own to live. " +
        "Name the key in the schema, or add the finding here with the reason.",
    ).toEqual([]);

    const stale = Object.keys(UNNAMED_KEYS_PENDING_RULING).filter((entry) => !stripped.includes(entry));
    expect(stale, "UNNAMED_KEYS_PENDING_RULING names a key that is no longer stripped.").toEqual([]);
  });

  it("the closed parse is actually reading the files", () => {
    // Vacuity guard: a `safeParse` over `{}` strips nothing and would pass silently.
    const parsed = SUBJECTS.map((subject) => {
      const { [COMPONENT_LIBRARY_KEY]: _library, ...document } = subject.raw;
      return projectDocumentSchema.safeParse(document);
    });
    expect(parsed.every((result) => result.success)).toBe(true);
    expect(SUBJECTS.filter((subject) => subject.raw[COMPONENT_LIBRARY_KEY] !== undefined).length)
      .toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------------------------
 * (d) the round trip §V802 asks for: load → save → compare
 * ---------------------------------------------------------------------------------- */

/**
 * The assertion (c) could not make, and the one that would have caught §T848's own bug
 * on its own (T856, §V802).
 *
 * (c) asks whether the shipped bytes contain a key the closed schema forgets. That is the
 * CAUSE. This asks the CONSEQUENCE, end to end and through the real code: open the file
 * the way the app opens it, save it the way the app saves it, and compare. A key nobody
 * named does not merely fail to validate — it is gone from the file the user gets back,
 * and `changed === false` while it happens.
 *
 * Why both, rather than only this one: (c) names the offending KEY and its path, so a
 * failure says `definition.range` rather than "these 40KB differ somewhere". This one
 * cannot be fooled by a loss that (c) does not model — a migration that rewrites a value,
 * a clamp applied on load, a serializer that reorders. Cause and consequence catch
 * different mistakes, and §T848's bug happened to be visible to both only because zod's
 * stripping is exactly the mechanism (c) models.
 *
 * `now` is pinned to the file's own `updatedAt`. The save path deliberately refreshes
 * that stamp on every write, so leaving it live would make every file differ for the one
 * reason that is not a defect — and would hide every reason that is.
 */
describe("(d) every shipped file survives its own load → save (§V802)", () => {
  it.each(SUBJECTS.map((subject) => subject.fileName))("%s comes back byte-identical", (fileName) => {
    const subject = SUBJECTS.find((entry) => entry.fileName === fileName);
    if (subject === undefined) throw new Error(`no subject named ${fileName}`);

    // A component-aware system, because the library rides at the file root and a
    // node-only registry would drop it silently — which is the very shape being tested.
    const { components, nodes } = createComponentSystem(createNodeRegistry(allNodeDefinitions).view());
    const loaded = loadProject(subject.text, { nodes, components });
    if (!loaded.ok) throw new Error(`${fileName} did not load: ${loaded.reason}`);

    const resaved = buildProjectFile({
      document: loaded.document,
      components: components.view().all(),
      now: () => loaded.document.updatedAt,
    });

    // The honest pair. `changed` is what the loader BELIEVES it did; the bytes are what
    // happened. §T848 measured them disagreeing — `changed === false` while `range`
    // vanished — so asserting only the flag would have passed through the whole defect.
    expect(loaded.changed, `${fileName}: the loader reports it altered the document`).toBe(false);
    expect(resaved.text, `${fileName}: opening and saving this file changes it`).toBe(subject.text);
  });

  it("the round trip is exercising the component library, not just plain documents", () => {
    // Vacuity guard: every EXAMPLE has an empty library, so a round trip that only ever
    // saw those would never re-serialize a component and could not have caught §T848's
    // bug at all. The starter component files are what make this assertion load-bearing.
    const withLibrary = SUBJECTS.filter((subject) => {
      const { components, nodes } = createComponentSystem(createNodeRegistry(allNodeDefinitions).view());
      const loaded = loadProject(subject.text, { nodes, components });
      return loaded.ok && components.view().all().length > 0;
    });
    expect(withLibrary.length).toBeGreaterThanOrEqual(6);
  });
});
