import { readFileSync, readdirSync } from "node:fs";
import { flatDocument } from "@compiler/test-support.ts";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { NodeRegistryView } from "../../nodes/registry/registry.ts";
import { diagnosticClass } from "../diagnostics/classes.ts";
import { evaluateExpression } from "../expressions/index.ts";
import type { FrameEvaluationInput } from "../types/frame.ts";
import type { GraphDocument, GraphNode } from "../types/graph.ts";
import type { ParameterSchema } from "../types/parameters.ts";
import { NO_FLATTENING, parameterReadOptions } from "./node-references.ts";
import { resolveParameterSchema } from "./resolve.ts";
import type { ChannelResolver } from "./resolve.ts";
import { testRead } from "./test-support.ts";

/**
 * The cross-node read path (T316, §V148, §V152).
 *
 * The round trip through the copy/paste commands is covered in
 * `commands/parameter-commands.test.ts`, and the compiler-and-inspector-agree claim at
 * the composed level. What is here is what a reader does when the reference is WRONG —
 * which is most of the surface area, because a reference is a name typed by a person into
 * a text field and every way of getting it wrong has to say so rather than produce a
 * number.
 */

const SCHEMA: ParameterSchema = {
  gain: { type: "number", label: "Gain", default: 1 },
  enabled: { type: "boolean", label: "Enabled", default: false },
  tint: { type: "color", label: "Tint", default: [0, 0, 0, 1], space: "display" },
};

function node(id: string, label: string, parameters: GraphNode["parameters"] = {}): GraphNode {
  return { id, type: "test.node", definitionVersion: 1, position: { x: 0, y: 0 }, label, parameters };
}

function graphOf(...nodes: GraphNode[]): GraphDocument {
  return {
    revision: 1,
    nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])),
    edges: {},
    groups: {},
  };
}

const expression = (source: string) => ({
  mode: "expression" as const,
  bindings: { expression: { kind: "expression" as const, source } },
});

/** Every node in these graphs carries `SCHEMA`, as the factory's catalogue sees it. */
const SCHEMA_REGISTRY = { get: () => ({ parameters: SCHEMA }) };

/** §T1557b: a read over `graph` through the one factory — its `nodes` is the reader. */
function readFor(graph: GraphDocument, channels?: (address: string) => number | undefined) {
  return testRead({ graph, registry: SCHEMA_REGISTRY, channels });
}

/** What an expression on `subject` resolves to, with the reader attached. */
function resolve(graph: GraphDocument, subject: GraphNode, key = "gain") {
  return resolveParameterSchema(subject, SCHEMA, readFor(graph)).get(key);
}

describe("reading op('name').par.key (T316)", () => {
  it("resolves to the referenced node's value", () => {
    const source = node("n1", "gain1", { gain: 7 });
    const subject = node("n2", "gain2", { gain: expression("op('gain1').par.gain") });
    const graph = graphOf(source, subject);

    const resolved = resolve(graph, subject);
    expect(resolved?.diagnostic).toBeNull();
    expect(resolved?.value).toBe(7);
  });

  it("resolves through a CHAIN, because the target's own value may be a reference", () => {
    // The reason a read is a resolve and not a lookup: `b` is worth what `a` is worth.
    const a = node("n1", "a", { gain: 3 });
    const b = node("n2", "b", { gain: expression("op('a').par.gain") });
    const c = node("n3", "c", { gain: expression("op('b').par.gain * 2") });
    expect(resolve(graphOf(a, b, c), c)?.value).toBe(6);
  });

  it("names the LOOP rather than overflowing the stack (§V152)", () => {
    // T331 refuses this at authoring time (`referenceCyclesThrough`), so a document that
    // went through the bus never holds it. A hand-edited file still can, and this guard
    // is what stands between that file and infinite recursion.
    const a = node("n1", "a", { gain: expression("op('b').par.gain") });
    const b = node("n2", "b", { gain: expression("op('a').par.gain") });
    const resolved = resolve(graphOf(a, b), a);

    // §T1641b: the loop's own code, at the severity a loop has at the whole-document check.
    // The guard fires one hop inside the loop, so `a` sees it as its target's diagnostic;
    // the kind is passed up, or the parameter its author is looking at would say "upstream".
    expect([resolved?.diagnostic?.severity, resolved?.diagnostic?.code]).toEqual(["error", "parameter.referenceCycle"]);
    expect(resolved?.diagnostic?.message).toContain("cycle");
    expect(resolved?.diagnostic?.suggestion).toContain("Break the loop");
    // §V108: it falls back to a value rather than leaving the parameter undefined.
    expect(resolved?.value).toBe(1);
  });

  it("catches a node referencing ITSELF through op()", () => {
    const self = node("n1", "a", { gain: expression("op('a').par.gain") });
    expect(resolve(graphOf(self), self)?.diagnostic?.message).toContain("cycle");
  });

  it("is not fooled into calling two independent reads a cycle", () => {
    // The visited set is per PATH, not per reader. A reader that shared one set across a
    // resolution would call the second read of `src` a loop, and the bug would look like
    // "the third parameter I reference stops working".
    const src = node("n1", "src", { gain: 5 });
    const subject = node("n2", "both", {
      gain: expression("op('src').par.gain + op('src').par.gain"),
    });
    expect(resolve(graphOf(src, subject), subject)?.value).toBe(10);
  });

  it("says which name is missing when the node is not there", () => {
    const subject = node("n1", "a", { gain: expression("op('ghost').par.gain") });
    expect(resolve(graphOf(subject), subject)?.diagnostic?.message).toContain('no node named "ghost"');
  });

  it("says which parameter is missing when the node has no such key", () => {
    const source = node("n1", "src");
    const subject = node("n2", "a", { gain: expression("op('src').par.nope") });
    expect(resolve(graphOf(source, subject), subject)?.diagnostic?.message).toContain(
      'has no parameter "nope"',
    );
  });

  it("refuses a compound read WHOLE, and says which components it has", () => {
    // §V71: an expression is arithmetic over numbers. Reading a colour and silently
    // taking its red channel would be a number that looks like an answer — and now that
    // the channel IS addressable (T332), the message points at the one keystroke that
    // fixes it rather than leaving the user to guess the spelling.
    const source = node("n1", "src", { tint: [1, 0.5, 0.25, 1] });
    const subject = node("n2", "a", { gain: expression("op('src').par.tint") });
    const message = resolve(graphOf(source, subject), subject)?.diagnostic?.message;
    expect(message).toContain("an expression reads a number");
    expect(message).toContain("op('src').par.tint.r");
  });

  it("reads a boolean as 0 or 1, which is the documented bridge", () => {
    const source = node("n1", "src", { enabled: true });
    const subject = node("n2", "a", { gain: expression("op('src').par.enabled") });
    expect(resolve(graphOf(source, subject), subject)?.value).toBe(1);
  });

  it("reads ONE COMPONENT of a compound (T332, §V113)", () => {
    // The point of storing colour as four independently-moded slots is that a channel can
    // be driven; a channel nothing outside its own node can read is half of that.
    const source = node("n1", "src", { tint: [1, 0.5, 0.25, 1] });
    const subject = node("n2", "a", { gain: expression("op('src').par.tint.g") });
    const resolved = resolve(graphOf(source, subject), subject);
    expect(resolved?.diagnostic).toBeNull();
    expect(resolved?.value).toBe(0.5);
  });

  it("reads a component whose OWN slot carries an expression", () => {
    // `tint.b` moving on its own while r, g and a stay put is the §V113 shape, and it is
    // what a reference to one channel has to see — not the compound's stored tuple.
    const source = node("n1", "src", { tint: [0, 0, 0, 1], "tint.b": expression("3 * 0.25") });
    const subject = node("n2", "a", { gain: expression("op('src').par.tint.b") });
    expect(resolve(graphOf(source, subject), subject)?.value).toBe(0.75);
  });

  it("hands back the STORED-space channel, exactly as a local bind does (§V56, T148)", () => {
    // `tint` is `space: "display"`. The decode to linear happens once, where `values`
    // leaves the resolver as evaluation input; doing it here as well is T187's double
    // decode, which measured 0.5 → 0.0376 on the way to the shader.
    const source = node("n1", "src", { tint: [0.5, 0.5, 0.5, 1] });
    const subject = node("n2", "a", { gain: expression("op('src').par.tint.r") });
    expect(resolve(graphOf(source, subject), subject)?.value).toBe(0.5);
  });

  it("names the components when the channel does not exist", () => {
    const source = node("n1", "src", { tint: [1, 1, 1, 1] });
    const subject = node("n2", "a", { gain: expression("op('src').par.tint.q") });
    expect(resolve(graphOf(source, subject), subject)?.diagnostic?.message).toContain(
      'has no component "q" (it has r, g, b, a)',
    );
  });

  it("refuses a component OF A SCALAR rather than inventing one", () => {
    const source = node("n1", "src", { gain: 4 });
    const subject = node("n2", "a", { gain: expression("op('src').par.gain.x") });
    expect(resolve(graphOf(source, subject), subject)?.diagnostic?.message).toContain(
      "has no components",
    );
  });

  it("propagates a BROKEN component's diagnostic rather than its fallback (§V243)", () => {
    // The whole trap in one test: the component falls back to a usable number by design
    // (§V108), so reading the value would make a broken reference look healthy at the top
    // of the chain, which is where its author is looking.
    const source = node("n1", "src", { tint: [1, 1, 1, 1], "tint.g": expression("nope") });
    const subject = node("n2", "a", { gain: expression("op('src').par.tint.g") });
    const resolved = resolve(graphOf(source, subject), subject);
    expect(resolved?.diagnostic?.message).toContain('unknown name "nope"');
  });

  it("does NOT blame a healthy component for the compound's own problem", () => {
    // The other half of §V243: a component with its own slot resolved on its own terms.
    // Forwarding the compound's fallback here would be a false alarm on a good channel,
    // and a false alarm teaches people to ignore the real ones.
    const source = node("n1", "src", { tint: expression("nope"), "tint.g": 0.25 });
    const subject = node("n2", "a", { gain: expression("op('src').par.tint.g") });
    const resolved = resolve(graphOf(source, subject), subject);
    expect(resolved?.diagnostic).toBeNull();
    expect(resolved?.value).toBe(0.25);
  });

  it("carries the compound's diagnostic to a component that FOLLOWS it (§V243)", () => {
    // No slot of its own, so this channel's number came out of the compound's fallback.
    // Reporting the number without the reason is the fallback hiding the error, one
    // channel at a time — which is harder to see than the whole-parameter case.
    const source = node("n1", "src", { tint: expression("nope") });
    const subject = node("n2", "a", { gain: expression("op('src').par.tint.g") });
    expect(resolve(graphOf(source, subject), subject)?.diagnostic?.message).toContain(
      'unknown name "nope"',
    );
  });

  it("refuses a path it does not understand rather than guessing a namespace", () => {
    const source = node("n1", "src", { gain: 2 });
    const subject = node("n2", "a", { gain: expression("op('src').ports.out") });
    expect(resolve(graphOf(source, subject), subject)?.diagnostic?.message).toContain(
      "only .par and .chan are readable",
    );
  });

  it("still reports when NO reader is supplied — a caller without a graph invents nothing", () => {
    // The state every caller was in before this landed, and the state a bare evaluator is
    // still in. Resolving to 0 here would be the worst outcome: a plausible number.
    const result = evaluateExpression("op('a').par.gain");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("need a graph");
  });
});

/**
 * T901 — `op('name').chan.<channel>`: a value node's OUTPUT, read through the channels
 * resolver (the seam the retired `driven` mode used). The whole point of the collapse:
 * inline maths over a live signal, which `driven` could not express at all.
 */
describe("reading op('name').chan.channel (T901)", () => {
  /** A resolver publishing lfo1's bag the way the value graph does. */
  const channels = (address: string) => {
    const bags: Record<string, Record<string, number>> = { lfo1: { value: 0.5 }, beat1: { low: 0.7, high: 0.2 } };
    const colon = address.indexOf(":");
    const name = colon < 0 ? address : address.slice(0, colon);
    const bag = bags[name];
    if (bag === undefined) return undefined;
    if (colon >= 0) return bag[address.slice(colon + 1)];
    return bag["value"];
  };

  function resolveWith(graph: GraphDocument, subject: GraphNode) {
    return resolveParameterSchema(subject, SCHEMA, readFor(graph, channels)).get("gain");
  }

  it("reads a named channel and does inline maths over it", () => {
    const source = node("n1", "beat1");
    const subject = node("n2", "a", { gain: expression("op('beat1').chan.low * 2 + 1") });
    expect(resolveWith(graphOf(source, subject), subject)?.value).toBeCloseTo(2.4, 10);
  });

  it(".chan.value answers a node's bare channel, exactly as the old bare driven address did", () => {
    const source = node("n1", "lfo1");
    const subject = node("n2", "a", { gain: expression("op('lfo1').chan.value") });
    expect(resolveWith(graphOf(source, subject), subject)?.value).toBe(0.5);
  });

  it("mixes a channel and another node's parameter in one expression", () => {
    const par = node("n1", "src", { gain: 3 });
    const sig = node("n3", "beat1");
    const subject = node("n2", "a", { gain: expression("op('beat1').chan.low * op('src').par.gain") });
    expect(resolveWith(graphOf(par, sig, subject), subject)?.value).toBeCloseTo(2.1, 10);
  });

  it("a missing channel fails LOUDLY with the name in the message", () => {
    const source = node("n1", "beat1");
    const subject = node("n2", "a", { gain: expression("op('beat1').chan.nope") });
    expect(resolveWith(graphOf(source, subject), subject)?.diagnostic?.message).toContain(
      'publishes no channel "nope"',
    );
  });

  it("no resolver degrades to the INFO tier the driven mode used (T897, §V815)", () => {
    const source = node("n1", "lfo1");
    const subject = node("n2", "a", { gain: expression("op('lfo1').chan.value") });
    // Reader WITHOUT channels in base — the structural-compile state.
    const resolved = resolve(graphOf(source, subject), subject);
    expect(resolved?.diagnostic?.severity).toBe("info");
    expect(resolved?.diagnostic?.code).toBe("parameter.channels.unavailable");
  });
});

/**
 * §T1641b — EVERY WAY A REFERENCE FAILS HAS ITS OWN CODE, and the code says whether the
 * reference can NEVER read as written or only cannot read YET.
 *
 * They were all `parameter.expression` at warning, so a function the grammar does not have
 * (§B262) weighed what a channel not yet published weighs, and a guard could stop on all of
 * them or none. The split has two directions and both are held here: the kinds that can
 * never read are errors, and the kinds the rule could swallow by mistake (a node that does
 * not exist yet, a channel not published yet, a type a newer build declares, a caller with
 * no resolver) stay exactly as loud as they were.
 */
describe("the kind of a failed reference decides its code and its severity (T1641b)", () => {
  const channels = (address: string) => (address === "beat1:low" ? 0.7 : undefined);
  const said = (graph: GraphDocument, subject: GraphNode, resolver?: (address: string) => number | undefined) =>
    resolveParameterSchema(subject, SCHEMA, readFor(graph, resolver)).get("gain")?.diagnostic ?? null;
  const verdict = (graph: GraphDocument, subject: GraphNode, resolver?: (address: string) => number | undefined) => {
    const diagnostic = said(graph, subject, resolver);
    return diagnostic === null ? null : [diagnostic.severity, diagnostic.code, diagnosticClass(diagnostic.code)];
  };
  const reading = (source: string) => node("n2", "a", { gain: expression(source) });

  it("is an error when the reference can never read as written", () => {
    const src = node("n1", "src", { tint: [1, 1, 1, 1] });
    const never = ["error", "parameter.reference.unreadable", "never"];
    // A parameter the target does not declare, a compound read whole, a component a scalar
    // does not have, a namespace that is not one of the two.
    expect(verdict(graphOf(src, reading("op('src').par.nope")), reading("op('src').par.nope"))).toEqual(never);
    expect(verdict(graphOf(src, reading("op('src').par.tint")), reading("op('src').par.tint"))).toEqual(never);
    expect(verdict(graphOf(src, reading("op('src').par.gain.x")), reading("op('src').par.gain.x"))).toEqual(never);
    expect(verdict(graphOf(src, reading("op('src').ports.out")), reading("op('src').ports.out"))).toEqual(never);
    // The SHAPE of a channel read is wrong whoever asks: with no resolver it is still said.
    expect(verdict(graphOf(src, reading("op('src').chan.a.b")), reading("op('src').chan.a.b"))).toEqual(never);
  });

  it("names the nearest declared key and the whole list when a parameter is not declared", () => {
    const src = node("n1", "src");
    const subject = reading("op('src').par.gian");
    expect(said(graphOf(src, subject), subject)?.suggestion).toBe('Nearest: "gain". "src" (test.node) declares: enabled, gain, tint.');
  });

  it("stays a warning of class notYet when the reference reads once something else arrives", () => {
    const beat = node("n1", "beat1", { gain: expression("mod(1, 0)") });
    // No node of that name yet: through .par, and through .chan with or without a resolver.
    const noNode = ["warning", "parameter.reference.node", "notYet"];
    expect(verdict(graphOf(reading("op('ghost').par.gain")), reading("op('ghost').par.gain"))).toEqual(noNode);
    expect(verdict(graphOf(reading("op('ghost').chan.value")), reading("op('ghost').chan.value"), channels)).toEqual(noNode);
    expect(verdict(graphOf(reading("op('ghost').chan.value")), reading("op('ghost').chan.value"))).toEqual(noNode);
    // A node that exists and publishes no such channel right now.
    expect(verdict(graphOf(beat, reading("op('beat1').chan.high")), reading("op('beat1').chan.high"), channels)).toEqual([
      "warning",
      "parameter.reference.channel",
      "notYet",
    ]);
    // A parameter whose own expression has a finding: this one clears when that one does.
    expect(verdict(graphOf(beat, reading("op('beat1').par.gain")), reading("op('beat1').par.gain"))).toEqual([
      "warning",
      "parameter.reference.upstream",
      "notYet",
    ]);
  });

  it("passes 'no channel resolver' up a chain of reads: it is the caller's state all the way", () => {
    // E55's haze reads the reactor's knobs, which read channels. At a structural compile no
    // one has a resolver, and that is an INFO about the caller at every link (§V338): a
    // warning on each would bury every real one in the examples under 159 false ones.
    const lfo = node("n0", "lfo1");
    const middle = node("n1", "mid", { gain: expression("op('lfo1').chan.value * 2") });
    const subject = reading("op('mid').par.gain");
    expect(verdict(graphOf(lfo, middle, subject), subject)).toEqual(["info", "parameter.channels.unavailable", "elsewhereHost"]);
    // With a resolver the chain simply reads.
    const live = (address: string) => (address === "lfo1:value" ? 0.5 : undefined);
    expect(resolveParameterSchema(subject, SCHEMA, readFor(graphOf(lfo, middle, subject), live)).get("gain")?.value).toBe(1);
  });

  it("says a placeholder's type is unknown to this build, never that it has no such parameter", () => {
    // §V10: a node of a type a newer build declares is kept as a placeholder. Its parameters
    // are not absent, they are unknowable here; "has no parameter" would be an error about
    // a document that is right.
    const future: GraphNode = { ...node("n1", "glow_next"), type: "future.glow" };
    const subject = reading("op('glow_next').par.amount");
    const read = testRead({
      graph: graphOf(future, subject),
      registry: { get: (type) => (type === "test.node" ? { parameters: SCHEMA } : undefined) },
    });
    const diagnostic = resolveParameterSchema(subject, SCHEMA, read).get("gain")?.diagnostic;
    expect([diagnostic?.severity, diagnostic?.code]).toEqual(["warning", "parameter.reference.unknownType"]);
    expect(diagnosticClass("parameter.reference.unknownType")).toBe("elsewhereBuild");
    expect(diagnostic?.message).toContain('"glow_next" has an unknown node type');
  });

  it("is an error for a bare name nothing supplies, and says what is spelled like it", () => {
    const flicker = node("n1", "slider_flicker");
    const beat = node("n3", "beat1");
    const remedy = (source: string): string | undefined => {
      const subject = reading(source);
      const diagnostic = said(graphOf(flicker, beat, subject), subject, channels);
      expect([diagnostic?.severity, diagnostic?.code, diagnosticClass(diagnostic?.code ?? "")]).toEqual([
        "error",
        "parameter.expression.name",
        "never",
      ]);
      return diagnostic?.suggestion;
    };
    // A node whose role is the name (T1593b), with the two forms that read a node.
    expect(remedy("flicker * 2")).toBe(
      `A node is named "slider_flicker": write op('slider_flicker').par.<parameter> or op('slider_flicker').chan.<channel>.`,
    );
    // A channel some node publishes right now.
    expect(remedy("low * 2")).toBe(`"beat1" publishes a channel "low": write op('beat1').chan.low.`);
    // A parameter of the node the expression is on.
    expect(remedy("enabled + 1")).toBe(`"enabled" is a parameter of this node: read it in Bind mode.`);
    // A clock, misspelled.
    expect(remedy("tim * 2")).toBe("Nearest clock: time.");
    // And nothing at all, said as such, with the forms that do read.
    expect(remedy("zzzz")).toBe(
      `No node, channel or parameter of this node is spelled "zzzz". An expression reads the clocks and other nodes: op('name').par.key, op('name').chan.channel.`,
    );
  });
});

/**
 * §T1129 / §V837 — THE FACTORY IS THE ONLY WAY TO A READER, AND A GATE SAYS SO.
 *
 * The pairing "reader + the base it reads through" was honoured at all three call sites
 * and enforced at none, which is how §T1000 (the inspector) and §T1001 (the OSC pump)
 * became the third and fourth recurrences of §B8's shape. A shared factory only makes the
 * right thing EASY; this scan is what makes the wrong thing impossible to land quietly.
 */
describe("T1129 — the parameter read options come from one factory", () => {
  /** lfo1's bag, the way the value graph publishes it. */
  const channels = (address: string) => (address === "lfo1" ? 0.5 : undefined);

  it("resolves a channel expression through the base the factory built", () => {
    const source = node("n1", "lfo1");
    const subject = node("n2", "a", { gain: expression("op('lfo1').chan.value") });
    const graph = graphOf(source, subject);
    const options = parameterReadOptions({
      graph: flatDocument(graph),
      registry: { get: () => ({ parameters: SCHEMA }) } as unknown as NodeRegistryView,
      frame: undefined,
      channels,
      flattening: NO_FLATTENING,
    });
    // 0.5 only if `channels` reached the READER's base. Without it the reference reports
    // "no channel resolver" and the parameter sits on §V108's retained static (1).
    const resolved = resolveParameterSchema(subject, SCHEMA, options).get("gain");
    expect(resolved?.value).toBe(0.5);
    expect(resolved?.diagnostic).toBeNull();
  });

  it("leaves no product module building a reader of its own", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? walk(join(dir, entry.name))
          : /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
            ? [join(dir, entry.name)]
            : [],
      );
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const sources = walk(join(root, "src"));
    // The floor: a walk that finds nothing would assert over the empty set (§T985).
    expect(sources.length).toBeGreaterThan(100);
    /** Comments stripped: what the CODE does, not what a docblock says about it (§T949). */
    const code = (file: string) =>
      readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/^[ \t]*\/\/.*$/gm, " ");
    const callers = sources
      .filter((file) => /\bcreateNodeReferenceReader\s*\(/.test(code(file)))
      .map((file) => relative(root, file).replaceAll("\\", "/"));
    expect(
      callers,
      "A module builds its own cross-node reader instead of calling " +
        "`parameterReadOptions`. The reader is a CLOSURE over its `base`, so a " +
        "hand-built one can be handed a frame and channels on the resolve that never reach " +
        "it — §B8's shape, which has now recurred four times (§T593, §T1000, §T1001, §B46). " +
        "Ask the factory for both, or this is the fifth (T1129).",
    ).toEqual(["src/domain/parameters/node-references.ts"]);

    /*
     * §T1557b — and none MINTS one. `ParameterReadOptions` is branded so an options literal
     * cannot stand in for it; a cast is the one way round the brand, and the two producers
     * are the only modules allowed it: the factory, and `STORED_READ` beside the resolver.
     */
    const minted = sources
      .filter((file) => /\bas\s+ParameterReadOptions\b/.test(code(file)))
      .map((file) => relative(root, file).replaceAll("\\", "/"));
    expect(
      minted,
      "A module casts a value to `ParameterReadOptions` instead of asking `parameterReadOptions` " +
        "for one, which is the options literal the brand exists to refuse (§B181's shape). " +
        "Build it from a complete `ParameterReadContext`, or pass `STORED_READ` (T1557b).",
    ).toEqual(["src/domain/parameters/node-references.ts", "src/domain/parameters/resolve.ts"]);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════
 * T1172 — THE NAME INDEX IS BUILT ONCE PER READER, AND A READER IS ONE FRAME
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * `nodeByName` calls `nodeNames`, which sorts every node id and builds a fresh `Map`, and
 * it was called once per `op()` read — E55's `haze1` rebuilt the index twenty-one times a
 * frame to ask twenty-one questions about the same graph. The index now lives for the
 * lifetime of one reader.
 *
 * ⚠ THE HAZARD IS THE SCOPE, NOT THE INDEX. Keyed on the graph OBJECT, this memo would be
 * wrong: `apply-patch.ts` calls `nodeNames` on an immer DRAFT it is still mutating, and
 * two `addNode` ops in one patch need the second `uniqueNodeName` to see the first add.
 * `names.ts` is therefore untouched, and the memo is confined to a reader — which is
 * built per compile, per inspector render, per OSC event, and is only ever read from.
 * So the gates below are about what a NEW reader sees, which is the only thing an edit
 * can change.
 */
describe("T1172 — the reader's name index", () => {
  it("answers many different names from one reader, interleaved", () => {
    // A one-entry index answers the second name with the first name's node. Interleaved
    // because a cache correct in blocks can still be wrong read alternately — which is
    // how E55 reads it.
    const a = node("n1", "a", { gain: 3 });
    const b = node("n2", "b", { gain: 5 });
    const subject = node("n3", "c", { gain: expression("op('a').par.gain") });
    const other = node("n4", "d", { gain: expression("op('b').par.gain") });
    const graph = graphOf(a, b, subject, other);

    // One reader for all four reads, exactly as one compile resolves a whole graph.
    const options = readFor(graph);
    const read = (subjectNode: GraphNode) =>
      resolveParameterSchema(subjectNode, SCHEMA, options).get("gain")?.value;
    expect(read(subject)).toBe(3);
    expect(read(other)).toBe(5);
    expect(read(subject)).toBe(3);
    expect(read(other)).toBe(5);
  });

  it("resolves a RENAMED target through a new reader, and stops resolving the old name", () => {
    // The edit the memo must not outlive. A reader is per frame, so the frame after a
    // rename builds its own index; nothing carries the old one forward.
    const before = graphOf(node("n1", "gain1", { gain: 7 }), node("n2", "x", { gain: expression("op('gain1').par.gain") }));
    expect(resolve(before, before.nodes["n2"]!)?.value).toBe(7);

    const after = graphOf(node("n1", "gain2", { gain: 7 }), node("n2", "x", { gain: expression("op('gain1').par.gain") }));
    const stale = resolve(after, after.nodes["n2"]!);
    expect(stale?.diagnostic?.message).toContain('there is no node named "gain1"');

    const renamed = graphOf(node("n1", "gain2", { gain: 7 }), node("n2", "x", { gain: expression("op('gain2').par.gain") }));
    expect(resolve(renamed, renamed.nodes["n2"]!)?.value).toBe(7);
  });

  it("shares one index between the `par` and the `chan` read, which are two call sites", () => {
    // Both namespaces resolve the name through the same helper. A memo wired into one and
    // not the other would answer `.chan` against a graph the `.par` read had already
    // indexed, or the reverse — so both are exercised through ONE reader.
    const lfo = node("n1", "lfo1", { gain: 4 });
    const subject = node("n2", "x", {
      gain: expression("op('lfo1').par.gain"),
      enabled: expression("op('lfo1').chan.value"),
    });
    const graph = graphOf(lfo, subject);
    const options = parameterReadOptions({
      graph: flatDocument(graph),
      registry: { get: () => ({ parameters: SCHEMA }) } as unknown as NodeRegistryView,
      frame: undefined,
      channels: (address: string) => (address === "lfo1:value" || address === "lfo1" ? 1 : undefined),
      flattening: NO_FLATTENING,
    });
    const resolved = resolveParameterSchema(subject, SCHEMA, options);
    expect(resolved.get("gain")?.value).toBe(4);
    expect(resolved.get("enabled")?.value).toBe(true);
  });

  it("still refuses a name that is not in the graph, from a reader that has answered others", () => {
    // A lazily built index must be built at all: an absent name has to come back absent
    // rather than as whatever the previous question found.
    const graph = graphOf(node("n1", "a", { gain: 3 }), node("n2", "x", { gain: expression("op('a').par.gain") }));
    const options = readFor(graph);
    expect(resolveParameterSchema(graph.nodes["n2"]!, SCHEMA, options).get("gain")?.value).toBe(3);
    expect(options.nodes?.("nope", ["par", "gain"])).toEqual({
      ok: false,
      kind: "node",
      reason: `op('nope').par.gain: there is no node named "nope"`,
    });
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════
 * T1172 — THE TARGET MEMO: THE ONE THAT CHANGES THE COMPLEXITY CLASS
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * A read is a RESOLVE of the target's WHOLE parameter set, recursively through the
 * target's own expressions — right semantics, paid once per read. §T1172 measured a chain
 * of references as quadratic: 20 chained refs 0.9 ms/frame, 40 chained 4.2, 80 chained
 * 25.3, 160 chained 171.6, with render cost held at zero on the mock backend. Memoised per
 * READER it is linear: 0.40, 0.71, 1.40, 3.11 — a 55x cut at 160, and E55 4.7x faster
 * end to end.
 *
 * ⚠ TWO WAYS THIS COULD BE A BUG AND BOTH ARE GATED HERE.
 *
 * (1) A MEMO THAT OUTLIVES THE FRAME. Then every reference freezes on the number it had
 *     when the memo was minted, and the picture stops while every static assertion stays
 *     green — §B181 exactly, whose 26 tests were all green for months because every one
 *     of them resolved a STATIC. So the gates below drive references from the frame clock
 *     and from a channel, and assert the value MOVES when its driver moves.
 *
 * (2) A MEMO SERVED ACROSS DIFFERENT `visited` CHAINS. `visited` is read in exactly one
 *     place — §V152's cycle guard — so a resolve during which the guard never fired is
 *     path-independent, and an entry is only stored when that holds. The cycle gates are
 *     what hold that line: a loop must still be NAMED, and a node reachable both through
 *     a cycle and cleanly must still answer correctly on the clean path.
 */
describe("T1172 — the per-reader memo of a referenced node's parameters", () => {
  it("resolves a CHAIN to the same values it did unmemoised", () => {
    // The arithmetic is the point: every hop must still be worth what it computes, not
    // what some earlier hop computed. Four deep, each hop a different multiplier.
    const a = node("n1", "a", { gain: 2 });
    const b = node("n2", "b", { gain: expression("op('a').par.gain * 3") });
    const c = node("n3", "c", { gain: expression("op('b').par.gain * 5") });
    const d = node("n4", "d", { gain: expression("op('c').par.gain * 7") });
    const graph = graphOf(a, b, c, d);
    expect(resolve(graph, b)?.value).toBe(6);
    expect(resolve(graph, c)?.value).toBe(30);
    expect(resolve(graph, d)?.value).toBe(210);
  });

  it("gives two readers of two FRAMES two different numbers through a chain (§B181)", () => {
    // The memo is per reader and a reader is per frame. If one outlived the frame, this
    // is the assertion that would go flat — and nothing else here would notice.
    const clock = node("n1", "clock", { gain: expression("time * 2") });
    const relay = node("n2", "relay", { gain: expression("op('clock').par.gain + 1") });
    const sink = node("n3", "sink", { gain: expression("op('relay').par.gain * 10") });
    const graph = graphOf(clock, relay, sink);
    const at = (timeSeconds: number) =>
      resolveParameterSchema(
        sink,
        SCHEMA,
        testRead({
          graph,
          registry: SCHEMA_REGISTRY,
          frame: { timeSeconds, deltaSeconds: 1 / 60, frameIndex: timeSeconds * 60, mode: "realtime", randomSeed: 1 },
        }),
      ).get("gain");

    expect(at(0)?.value).toBe(10); // (0 * 2 + 1) * 10
    expect(at(1)?.value).toBe(30); // (2 + 1) * 10
    expect(at(2)?.value).toBe(50); // (4 + 1) * 10
    expect(at(0)?.driven).toBe(true);
    expect(at(2)?.driven).toBe(true);
  });

  it("follows a CHANNEL through the chain, and moves when the channel moves (§B181)", () => {
    // The §B181 shape proper: a reference whose target is driven by a live channel. A
    // memo carried between readers would pin the whole chain on one sample of the wire.
    const lfo = node("n1", "lfo1");
    const relay = node("n2", "relay", { gain: expression("op('lfo1').chan.value") });
    const sink = node("n3", "sink", { gain: expression("op('relay').par.gain * 4") });
    const graph = graphOf(lfo, relay, sink);
    const registry = { get: () => ({ parameters: SCHEMA }) } as unknown as NodeRegistryView;
    const at = (level: number) =>
      resolveParameterSchema(
        sink,
        SCHEMA,
        parameterReadOptions({
          graph: flatDocument(graph),
          registry,
          frame: undefined,
          channels: (address: string) => (address === "lfo1" || address === "lfo1:value" ? level : undefined),
          flattening: NO_FLATTENING,
        }),
      ).get("gain");

    expect(at(0.25)?.value).toBe(1);
    expect(at(0.5)?.value).toBe(2);
    expect(at(0.75)?.value).toBe(3);
    // Not §V108's retained static (SCHEMA's `gain` default is 1) — actually driven.
    expect(at(0.5)?.driven).toBe(true);
  });

  it("serves ONE reader's repeated reads of one target consistently", () => {
    // The steady state E55 is in: twenty-one reads of one target inside one resolve.
    // Every one must still be the target's own value.
    const source = node("n1", "src", { gain: 6 });
    const subject = node("n2", "many", {
      gain: expression("op('src').par.gain + op('src').par.gain + op('src').par.gain"),
    });
    expect(resolve(graphOf(source, subject), subject)?.value).toBe(18);
  });

  it("still NAMES a cycle rather than memoising one hop of it (§V152)", () => {
    // The memo refuses to store an entry whose resolve fired the cycle guard, so the
    // loop is still reported with the path in it — which is the only thing that tells a
    // user which two nodes they joined.
    const a = node("n1", "a", { gain: expression("op('b').par.gain") });
    const b = node("n2", "b", { gain: expression("op('a').par.gain") });
    const resolved = resolve(graphOf(a, b), a);
    expect(resolved?.diagnostic?.message).toContain("cycle");
    expect(resolved?.diagnostic?.message).toContain("n1");
    expect(resolved?.value).toBe(1);
  });

  it("does not let a cyclic read poison a clean one that was made after it", () => {
    /*
     * THE CASE THE CYCLE CONDITION EXISTS FOR, and it is genuinely path-dependent — which
     * most cycle shapes are not, because a diagnostic propagates and taints every caller
     * equally. This one does not. A compound resolves WHOLE, so its components are one
     * member of a ring while each keeps its own value:
     *
     *   x.aim    = 5, 0, 0                 x.aim.z = op('b').par.gain
     *   b.gain   = op('x').par.aim.x       n.gain  = op('b').par.gain
     *   t.gain   = op('x').par.aim.z
     *
     * `x.aim` and `b.gain` close a ring THROUGH `aim.z`, so `t` (which reads `aim.z`) is
     * inside it and reports the ring. `n` reads `b.gain`, which resolves through `aim.x` —
     * a static — and is worth 5 with no diagnostic at all. But `b.gain`'s resolve does fire
     * the guard, one level down in `aim.z`, so a memo that stored it anyway would hand `n`
     * the ring's fallback.
     *
     * (§B293: until the guard moved to (node, key) this fixture was two SCALARS of `x`, one
     * of them static, and it was "a loop" only because a read resolved the whole node. That
     * shape is no ring now and is held as such below.)
     */
    const two: ParameterSchema = {
      gain: { type: "number", label: "Gain", default: 1 },
      aim: { type: "vector", size: 3, label: "Aim", default: [0, 0, 0] },
    };
    const graph = graphOf(
      node("nx", "x", { aim: [5, 0, 0], "aim.z": expression("op('b').par.gain") }),
      node("nb", "b", { gain: expression("op('x').par.aim.x") }),
      node("nn", "n", { gain: expression("op('b').par.gain") }),
      node("nt", "t", { gain: expression("op('x').par.aim.z") }),
    );
    const readsOf = (order: readonly string[]) => {
      const options = testRead({ graph, registry: { get: () => ({ parameters: two }) } });
      return order.map((id) =>
        resolveParameterSchema(graph.nodes[id]!, two, options).get("gain"),
      );
    };

    // The poisoning order: the cyclic read first, the clean one second, one reader.
    const [cyclicFirst, cleanSecond] = readsOf(["nt", "nn"]);
    expect(cyclicFirst?.diagnostic?.message).toContain("cycle");
    expect(cleanSecond?.value).toBe(5);
    expect(cleanSecond?.diagnostic).toBeNull();

    // And the other way round, where nothing could have poisoned anything.
    const [cleanFirst, cyclicSecond] = readsOf(["nn", "nt"]);
    expect(cleanFirst?.value).toBe(5);
    expect(cleanFirst?.diagnostic).toBeNull();
    expect(cyclicSecond?.diagnostic?.message).toContain("cycle");
  });
});

/**
 * T1720b — A READER THAT REMEMBERS SUBEXPRESSIONS: each repeated subtree evaluated once for
 * the reader's life, which a frame's compile asks for (`frame-compile.ts`). The same two
 * hazards as §T1172's memo, held the same way: a remembered value must move with the frame
 * (a reader is per frame, §B181), and a value reached through a ring must not be served to a
 * clean path (§V152).
 */
describe("T1720b — a reader that remembers repeated subexpressions", () => {
  const registry = { get: () => ({ parameters: SCHEMA }) } as unknown as NodeRegistryView;
  const remembering = (graph: GraphDocument, channels: ChannelResolver | undefined, frame?: FrameEvaluationInput) =>
    parameterReadOptions({ graph: flatDocument(graph), registry, frame, channels, flattening: NO_FLATTENING }, { expressions: true });

  it("evaluates one text once for two parameters that carry it, and twice for a reader that remembers nothing", () => {
    const lfo = node("n1", "lfo1");
    const p = node("n2", "p", { gain: expression("op('lfo1').chan.value * 2") });
    const q = node("n3", "q", { gain: expression("op('lfo1').chan.value * 2") });
    const graph = graphOf(lfo, p, q);
    let asks = 0;
    const channels: ChannelResolver = (address) => (address === "lfo1:value" ? ((asks += 1), 0.25) : undefined);

    const once = remembering(graph, channels);
    expect([p, q].map((subject) => resolveParameterSchema(subject, SCHEMA, once).get("gain")?.value)).toEqual([0.5, 0.5]);
    expect(asks).toBe(1);

    asks = 0;
    const plain = parameterReadOptions({ graph: flatDocument(graph), registry, frame: undefined, channels, flattening: NO_FLATTENING });
    expect([p, q].map((subject) => resolveParameterSchema(subject, SCHEMA, plain).get("gain")?.value)).toEqual([0.5, 0.5]);
    expect(asks).toBe(2);
  });

  it("evaluates a subtree two different texts share once, and twice for a reader that remembers nothing", () => {
    const lfo = node("n1", "lfo1");
    const p = node("n2", "p", { gain: expression("op('lfo1').chan.value * 2") });
    const q = node("n3", "q", { gain: expression("op('lfo1').chan.value * 2 + 1") });
    const graph = graphOf(lfo, p, q);
    let asks = 0;
    const channels: ChannelResolver = (address) => (address === "lfo1:value" ? ((asks += 1), 0.25) : undefined);
    const once = remembering(graph, channels);
    expect([p, q].map((subject) => resolveParameterSchema(subject, SCHEMA, once).get("gain")?.value)).toEqual([0.5, 1.5]);
    expect(asks).toBe(1);
    asks = 0;
    const plain = parameterReadOptions({ graph: flatDocument(graph), registry, frame: undefined, channels, flattening: NO_FLATTENING });
    expect([p, q].map((subject) => resolveParameterSchema(subject, SCHEMA, plain).get("gain")?.value)).toEqual([0.5, 1.5]);
    expect(asks).toBe(2);
  });

  it("gives the readers of two frames two numbers for one text (§B181)", () => {
    const subject = node("n1", "s", { gain: expression("time * 2") });
    const at = (timeSeconds: number) =>
      resolveParameterSchema(subject, SCHEMA, remembering(graphOf(subject), undefined, { timeSeconds, deltaSeconds: 1 / 60, frameIndex: timeSeconds * 60, mode: "realtime", randomSeed: 1 })).get("gain")?.value;
    expect([at(1), at(2)]).toEqual([2, 4]);
  });

  it("does not serve a text first reached through a ring to a clean path that carries the same text (§V152)", () => {
    // §T1172's poisoning fixture, where `x.aim.z` and `n.gain` carry the SAME text: reached
    // from `t` it is inside the ring through `aim.z`; reached from `n` it is worth 5.
    const two: ParameterSchema = {
      gain: { type: "number", label: "Gain", default: 1 },
      aim: { type: "vector", size: 3, label: "Aim", default: [0, 0, 0] },
    };
    const graph = graphOf(
      node("nx", "x", { aim: [5, 0, 0], "aim.z": expression("op('b').par.gain") }),
      node("nb", "b", { gain: expression("op('x').par.aim.x") }),
      node("nn", "n", { gain: expression("op('b').par.gain") }),
      node("nt", "t", { gain: expression("op('x').par.aim.z") }),
    );
    const readsOf = (order: readonly string[]) => {
      const options = parameterReadOptions(
        { graph: flatDocument(graph), registry: { get: () => ({ parameters: two }) } as unknown as NodeRegistryView, frame: undefined, channels: undefined, flattening: NO_FLATTENING },
        { expressions: true },
      );
      return order.map((id) => resolveParameterSchema(graph.nodes[id]!, two, options).get("gain"));
    };
    const [cyclicFirst, cleanSecond] = readsOf(["nt", "nn"]);
    expect(cyclicFirst?.diagnostic?.message).toContain("cycle");
    expect(cleanSecond?.value).toBe(5);
    expect(cleanSecond?.diagnostic).toBeNull();
    const [cleanFirst, cyclicSecond] = readsOf(["nn", "nt"]);
    expect(cleanFirst?.value).toBe(5);
    expect(cyclicSecond?.diagnostic?.message).toContain("cycle");
  });
});

/**
 * T1207 — the failure the owner watched an agent hit, as the agent hit it.
 *
 * An agent holding the pair `constant1` / `value` set `solid1.color` to BIND mode with
 * ref `constant1.value`, because of the five mode names `bind` is the one that sounds
 * like "connect to a source". It is the one that means the opposite: bind reaches a
 * parameter IN SCOPE (a sibling, or `parent.*` per §V81), and a cross-NODE reference is
 * `expression`. The message it got back listed what the node HAS, which says what is
 * wrong and not what to write — so these assert the REPLACEMENT, in the caller's own
 * names, because that is the sentence that ends the loop.
 *
 * The namespace is probed rather than guessed, and both directions are pinned: a node
 * that declares the key answers `.par`, a node that only PUBLISHES it answers `.chan`.
 * Naming one form for both would be wrong half the time, and wrong advice at the moment
 * of the mistake is worse than the bare complaint it replaces.
 */
describe("a bind that names a NODE says what to write instead (T1207)", () => {
  const bind = (ref: string) => ({
    mode: "bind" as const,
    bindings: { bind: { kind: "bind" as const, ref } },
  });

  const channels = (address: string) => (address === "lfo1" || address === "lfo1:value" ? 0.5 : undefined);

  function bound(graph: GraphDocument, subject: GraphNode, withChannels = false) {
    return resolveParameterSchema(subject, SCHEMA, readFor(graph, withChannels ? channels : undefined)).get("gain");
  }

  it("names expression mode and the exact op() the ref meant — .par when the node declares it", () => {
    const source = node("n1", "constant1", { gain: 7 });
    const subject = node("n2", "solid1", { gain: bind("constant1.gain") });
    const message = bound(graphOf(source, subject), subject)?.diagnostic?.message ?? "";

    expect(message).toContain('is bound to "constant1.gain"');
    expect(message).toContain("expression mode");
    expect(message).toContain("op('constant1').par.gain");
  });

  it("answers .chan when the name is only PUBLISHED, never .par (T901)", () => {
    // `lfo1` has no `value` parameter at all; its `value` is a channel. The advice has to
    // follow the node, or it sends the reader from one dead end to another.
    const source = node("n1", "lfo1");
    const subject = node("n2", "solid1", { gain: bind("lfo1.value") });
    const message = bound(graphOf(source, subject), subject, true)?.diagnostic?.message ?? "";

    expect(message).toContain("op('lfo1').chan.value");
    expect(message).not.toContain(".par.value");
  });

  it("stays quiet about nodes when the ref is a plain misspelt sibling", () => {
    // The guard has to survive the legitimate case it could swallow: `gian` is a typo for
    // a parameter on this node, not a reference to a node called `gian`, and telling its
    // author to write `op('gian')` would be a second wrong turn.
    const subject = node("n2", "solid1", { gain: bind("gian") });
    const message = bound(graphOf(subject), subject)?.diagnostic?.message ?? "";

    expect(message).toContain("it names no parameter on this node");
    expect(message).not.toContain("op(");
  });

  it("stays quiet on a component path, which is dotted and is not a node reference", () => {
    // `tint.r` resolves; `tint.q` does not, and its complaint is about COMPONENTS. Reading
    // the dot as a node name here would rename this node's own colour channel to a node.
    const shallow = node("n2", "solid1", { gain: bind("tint.q") });
    const first = bound(graphOf(shallow), shallow)?.diagnostic?.message ?? "";
    expect(first).toContain('"tint" has no component "q"');
    expect(first).not.toContain("op(");

    // The case that actually reaches the guard: two dots put the whole thing past the
    // component branch and into the "names no parameter" fallback, where a leading
    // segment this node DECLARES must still not be read as somebody else's node name.
    const deep = node("n2", "solid1", { gain: bind("tint.q.x") });
    const second = bound(graphOf(deep), deep)?.diagnostic?.message ?? "";
    expect(second).toContain("it names no parameter on this node");
    expect(second).not.toContain("op(");
  });
});

/**
 * §B293 — A RING IS OVER (node, key), THROUGH THE REAL RESOLVE.
 *
 * Found by a camera whose Look At z was written as the length of its own Heading and refused
 * as "a cycle". The reader resolved the target's WHOLE schema and its guard was keyed by
 * node, so a parameter could not read another parameter of its own node: read from the node
 * itself it happened to work (the guard fired one level down and was thrown away), and read
 * from ANY OTHER node it failed. Both orders are held here, because only one of them failed.
 */
describe("B293 — a parameter reads another parameter of its own node", () => {
  const KEYS: ParameterSchema = {
    gain: { type: "number", label: "Gain", default: 1 },
    other: { type: "number", label: "Other", default: 2 },
    third: { type: "number", label: "Third", default: 3 },
    aim: { type: "vector", size: 3, label: "Aim", default: [0, 0, 0] },
  };
  const read = (graph: GraphDocument, nodeId: string, key = "gain") =>
    resolveParameterSchema(graph.nodes[nodeId]!, KEYS, testRead({ graph, registry: { get: () => ({ parameters: KEYS }) } })).get(key);

  it("⚑ one key reading another key of the same node is that key's value, from the node itself AND from another node", () => {
    const graph = graphOf(
      node("n1", "a", { gain: expression("op('a').par.other * 2"), other: 7 }),
      node("n2", "reader", { gain: expression("op('a').par.gain + 1") }),
    );
    expect([read(graph, "n1")?.value, read(graph, "n1")?.diagnostic]).toEqual([14, null]);
    // From another node: this is the read that was "a cycle" (the node already on the path).
    expect([read(graph, "n2")?.value, read(graph, "n2")?.diagnostic]).toEqual([15, null]);
  });

  it("⚑ a chain of three keys on one node resolves in the order it reads, whatever order they are declared in", () => {
    // gain is declared FIRST and read last: nothing is resolved "in a pass".
    const graph = graphOf(
      node("n1", "a", { gain: expression("op('a').par.other + 1"), other: expression("op('a').par.third + 1"), third: 5 }),
      node("n2", "reader", { gain: expression("op('a').par.gain * 10") }),
    );
    expect([read(graph, "n1")?.value, read(graph, "n1")?.diagnostic]).toEqual([7, null]);
    expect([read(graph, "n1", "other")?.value, read(graph, "n1", "other")?.diagnostic]).toEqual([6, null]);
    expect([read(graph, "n2")?.value, read(graph, "n2")?.diagnostic]).toEqual([70, null]);
  });

  it("⚑ a component reading a key of its own node, and a key reading a component of its own node", () => {
    const graph = graphOf(node("n1", "a", { aim: [1, 2, 0], "aim.z": expression("0 - op('a').par.gain"), gain: 4, other: expression("op('a').par.aim.y + op('a').par.aim.z") }));
    expect(read(graph, "n1", "aim")?.value).toEqual([1, 2, -4]);
    expect([read(graph, "n1", "other")?.value, read(graph, "n1", "other")?.diagnostic]).toEqual([-2, null]);
  });

  it("⚑ two nodes that read each other's UNRELATED parameters are not a ring", () => {
    // x.other → b.gain → x.gain (a static). It was "a loop through x" while a read resolved the whole node.
    const graph = graphOf(
      node("nx", "x", { gain: 5, other: expression("op('b').par.gain") }),
      node("nb", "b", { gain: expression("op('x').par.gain") }),
      node("nt", "t", { gain: expression("op('x').par.other") }),
    );
    expect([read(graph, "nt")?.value, read(graph, "nt")?.diagnostic]).toEqual([5, null]);
    expect([read(graph, "nx", "other")?.value, read(graph, "nx", "other")?.diagnostic]).toEqual([5, null]);
  });

  it("⚑ STILL A RING: a reads b reads a on one node, named by its parameters", () => {
    const graph = graphOf(node("n1", "a", { gain: expression("op('a').par.other"), other: expression("op('a').par.gain") }));
    const gain = read(graph, "n1");
    expect([gain?.diagnostic?.severity, gain?.diagnostic?.code]).toEqual(["error", "parameter.referenceCycle"]);
    expect(gain?.diagnostic?.message).toContain("that reference is a cycle (n1.gain → n1.other → n1.gain)");
    // §V108: its fallback, never a number that looks like an answer.
    expect(gain?.value).toBe(1);
  });

  it("⚑ STILL A RING: a parameter reading itself, and a component reading another component of its own vector", () => {
    const self = graphOf(node("n1", "a", { gain: expression("op('a').par.gain + 1") }));
    expect(read(self, "n1")?.diagnostic?.code).toBe("parameter.referenceCycle");
    expect(read(self, "n1")?.diagnostic?.message).toContain("(n1.gain → n1.gain)");
    const vector = graphOf(node("n1", "a", { aim: [3, 0, 0], "aim.z": expression("op('a').par.aim.x") }));
    const aim = read(vector, "n1", "aim");
    expect(aim?.components?.[2]?.diagnostic?.code).toBe("parameter.referenceCycle");
    expect(aim?.components?.[2]?.diagnostic?.message).toContain("(n1.aim → n1.aim)");
  });

  it("⚑ STILL A RING: through two nodes, named in order", () => {
    const graph = graphOf(
      node("n1", "a", { gain: expression("op('b').par.other") }),
      node("n2", "b", { other: expression("op('a').par.gain") }),
    );
    expect(read(graph, "n1")?.diagnostic?.code).toBe("parameter.referenceCycle");
    expect(read(graph, "n1")?.diagnostic?.message).toContain("(n1.gain → n2.other → n1.gain)");
  });

  it("a sibling read many times is resolved once a reader, and a bind on the target still reads its own node", () => {
    // The memo is per (node, key): twenty reads of one key are one resolve of it, and so one
    // read of the channel that key reads.
    let asked = 0;
    const graph = graphOf(
      node("n1", "a", {
        gain: expression(Array.from({ length: 20 }, () => "op('a').par.other").join(" + ")),
        other: expression("op('k').chan.value + op('a').par.third"),
        third: { mode: "bind", bindings: { bind: { kind: "bind", ref: "aim.x" } } },
        aim: [2, 0, 0],
      }),
      node("n2", "k"),
    );
    const options = testRead({ graph, registry: { get: () => ({ parameters: KEYS }) }, channels: (address) => (address === "k:value" ? ((asked += 1), 3) : undefined) });
    const gain = resolveParameterSchema(graph.nodes["n1"]!, { gain: KEYS["gain"]! }, { ...options, schema: KEYS }).get("gain");
    // third binds aim.x = 2; other = 3 + 2; gain = twenty of them.
    expect([gain?.value, gain?.diagnostic]).toEqual([100, null]);
    expect(asked).toBe(1);
  });
});
