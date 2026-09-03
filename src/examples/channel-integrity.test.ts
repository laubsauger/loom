import { describe, expect, it } from "vitest";

import { createValueGraphSession } from "../domain/channels/value-graph.ts";
import type { GraphDocument, GraphNode } from "../domain/types/graph.ts";
import type { FrameEvaluationInput } from "../domain/types/frame.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import { listExamples, listStarterComponentFiles } from "./catalogue.ts";

/**
 * ⚑ T1074 — every `op('X').chan.K` in every shipped document names a channel X ACTUALLY
 * PUBLISHES, not merely a node that exists.
 *
 * `reference-integrity.test.ts` is the other half of this and stops one level short: it
 * proves X is a label in the graph. Both halves are needed because a driven parameter whose
 * channel is wrong fails EXACTLY as one whose node is wrong does — §V108 retains the static
 * and the document renders, every claim passes, and the feature never ran. That is §V856's
 * family, and it has now shipped three times in one week:
 *
 *   - E52  `op('mask1').chan.coverage`  — a LIVE source (personMask), whose road into the
 *          expression engine did not exist until T1067 put `externalChannels` in the ladder
 *   - E53  `op('matte1').chan.coverage` — the same, one seam over
 *   - E54  reported as `op('clag1').chan.bar` and was NOT this bug at all: `clag1` publishes
 *          `bar` on every frame of the document's life, measured through the real session.
 *          That diagnostic came from the app's own resolver window (`use-value-graph.ts`
 *          answers `undefined` for a FRAMED read before the first evaluated frame and after
 *          `reset()`), which is that hook's question, not this file's.
 *
 * So the three are not one mistake, and the honest gate is not one rule. What this file can
 * settle from the document ALONE it settles exactly; what needs a running app it INVENTORIES
 * rather than waves through, so a new unreachable reference fails a list instead of joining
 * it in silence.
 *
 * ## What "publishes" means, per kind of source
 *
 * VALUE-GRAPH nodes (anything with `valueEvaluate` / `valueChannel`) publish a BAG whose
 * keys are the return value of a function — no definition declares them, so there is
 * nothing static to read and the only honest source is to RUN the value graph. That is
 * cheap (scalars on the CPU, §V183) and it is what the app itself does, so this walks the
 * document through the real `createValueGraphSession` and reads the keys back.
 *
 * ANALYZE nodes publish one channel, named by the label alone (`analyzeChannelEntries`), so
 * `.chan.value` is the only spelling `node-references.ts` can route to one — a `.chan.<x>`
 * on an Analyze node is unreachable at every point in the program's life and is FAILED here.
 *
 * ANYTHING ELSE — the live seams (vision, matte, depth, midi, osc) and component-internal
 * chains fed from outside the file — has no static enumeration to check against. Those are
 * listed in `UNVERIFIABLE` below and the list is asserted whole.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();

/**
 * §V44's deterministic zero frame plus a few real ones. A bag's KEYS can depend on the
 * frame (a stage with no input publishes nothing), so the union across several frames is
 * the honest "can this name ever be published", not one lucky sample.
 */
const FRAMES: readonly FrameEvaluationInput[] = [0, 1, 30, 197].map((frameIndex) => ({
  timeSeconds: frameIndex / 60,
  deltaSeconds: 1 / 60,
  frameIndex,
  mode: "realtime" as const,
  randomSeed: 54,
}));

interface Reference {
  readonly where: string;
  readonly name: string;
  readonly key: string;
}

/** Every `op('X').chan.K` written anywhere in a document's parameter slots. */
function channelReferences(graph: GraphDocument): Reference[] {
  const found: Reference[] = [];
  for (const [nodeId, node] of Object.entries(graph.nodes)) {
    for (const [key, value] of Object.entries(node.parameters ?? {})) {
      const source = (value as { bindings?: { expression?: { source?: string } } })?.bindings?.expression
        ?.source;
      if (typeof source !== "string") continue;
      for (const match of source.matchAll(/op\(\s*'([^']+)'\s*\)\s*\.\s*chan\s*\.\s*([A-Za-z0-9_]+)/g)) {
        found.push({ where: `${nodeId}.${key}`, name: match[1] ?? "", key: match[2] ?? "" });
      }
    }
  }
  return found;
}

const nodeByLabel = (graph: GraphDocument, label: string): GraphNode | undefined =>
  Object.values(graph.nodes).find((node) => node.label === label);

/** The union of channel names each label publishes, over the frames above. */
function publishedChannels(graph: GraphDocument): Map<string, Set<string>> {
  const session = createValueGraphSession(registry);
  const published = new Map<string, Set<string>>();
  for (const frame of FRAMES) {
    for (const [name, bag] of session.evaluate(graph, frame).byName) {
      const keys = published.get(name) ?? new Set<string>();
      for (const key of Object.keys(bag)) keys.add(key);
      published.set(name, keys);
    }
  }
  return published;
}

function unresolvable(graph: GraphDocument, fileName: string, unverified: string[]): string[] {
  const published = publishedChannels(graph);
  const problems: string[] = [];
  for (const reference of channelReferences(graph)) {
    const target = nodeByLabel(graph, reference.name);
    if (target === undefined) continue; // reference-integrity.test.ts owns this half.
    const definition = registry.get(target.type);
    const bag = published.get(reference.name);
    if (bag !== undefined) {
      // A value-graph member. Its bag is the authority, and `.chan.value` additionally
      // answers a single-channel node through `node-references.ts`'s bare-name fallback.
      if (bag.has(reference.key)) continue;
      if (reference.key === "value" && bag.size === 1) continue;
      problems.push(
        `${reference.where} reads op('${reference.name}').chan.${reference.key}, but ${reference.name} (${target.type}) publishes only { ${[...bag].sort().join(", ")} }`,
      );
      continue;
    }
    if (definition?.type === "analyze") {
      // Published under the bare label by `analyzeChannelEntries` — `.chan.value` is the
      // one spelling that reaches it. This is the E52/E53 case exactly.
      if (reference.key === "value") continue;
      problems.push(
        `${reference.where} reads op('${reference.name}').chan.${reference.key}, but ${reference.name} is an Analyze node and publishes one channel under its bare label — the reachable spelling is op('${reference.name}').chan.value`,
      );
      continue;
    }
    // An EXTERNAL publisher (vision, matte, depth, midi, osc) or a component-internal
    // chain whose source arrives from outside the file. Neither can be resolved from the
    // document alone, so this gate does not claim to have checked it — it INVENTORIES it
    // instead, and the inventory below is asserted whole. A gate that quietly exempted
    // what it could not understand is exactly what let E52 and E53 ship.
    unverified.push(`${fileName}  ${reference.where}  op('${reference.name}').chan.${reference.key}  [${target.type}]`);
  }
  return problems;
}

/**
 * ⚑ THE UNVERIFIABLE INVENTORY — every channel reference in the shipped set whose publisher
 * this gate cannot reach without a running app.
 *
 * It is pinned rather than skipped, and that is the whole point: a NEW reference to a source
 * with no static enumeration fails this list instead of joining it silently. Shrinking the
 * list is real work (each entry wants its publisher taught to enumerate its channel names,
 * the way `analyzeChannelEntries` already does) and is tracked rather than done here.
 *
 * The first three are LIVE-SOURCE reads — a person mask and a matte publish their coverage
 * through the external-channel ladder T1067 wired into `app.tsx`, and no headless walk of
 * the document can see it. The fourth is a COMPONENT-INTERNAL chain: `probe` is a Limit
 * whose input crosses the component boundary, so evaluated standalone it publishes nothing.
 */
const UNVERIFIABLE = [
  "AudioLevel.loom.json  glow.brightness  op('probe').chan.low  [valueLimit]",
  "E52-Presence.loom.json  wash.brightness  op('mask1').chan.coverage  [personMask]",
  "E53-Two-Cuts.loom.json  washC.brightness  op('seg1').chan.coverage  [personMask]",
  "E53-Two-Cuts.loom.json  washW.brightness  op('matte1').chan.coverage  [matte]",
];

describe("every shipped op().chan reference names a channel that is PUBLISHED (T1074)", () => {
  const files = [...listExamples(), ...listStarterComponentFiles()];

  it("sweeps the whole shipped set", () => {
    expect(files.length).toBeGreaterThan(40);
  });

  /**
   * The gate is only worth having if the catalogue actually exercises it — a sweep over
   * documents that contain no channel references at all would be green and empty.
   */
  it("finds channel references to check", () => {
    const total = files.reduce((count, file) => {
      const parsed = JSON.parse(file.text) as { graph?: GraphDocument };
      return count + (parsed.graph === undefined ? 0 : channelReferences(parsed.graph).length);
    }, 0);
    expect(total).toBeGreaterThan(20);
  });

  it.each(files.map((file) => file.fileName))("%s drives every parameter from a real channel", (fileName) => {
    const file = files.find((entry) => entry.fileName === fileName);
    const parsed = JSON.parse(file?.text ?? "{}") as { graph?: GraphDocument };
    expect(parsed.graph === undefined ? [] : unresolvable(parsed.graph, fileName, [])).toEqual([]);
  });

  /**
   * And the inventory is exactly what it was — so a reference to an unreachable publisher
   * cannot be added without this failing. Sorted, because the sweep order is not a claim.
   */
  it("has not grown a new reference it cannot verify", () => {
    const unverified: string[] = [];
    for (const file of files) {
      const parsed = JSON.parse(file.text) as { graph?: GraphDocument };
      if (parsed.graph !== undefined) unresolvable(parsed.graph, file.fileName, unverified);
    }
    expect(unverified.sort()).toEqual([...UNVERIFIABLE].sort());
  });
});
