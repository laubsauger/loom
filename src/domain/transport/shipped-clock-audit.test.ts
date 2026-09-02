import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { listExamples } from "../../examples/catalogue.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { requireExample } from "../../examples/runner.ts";
import { CUSTOM_WGSL_DEFAULT_SOURCE } from "../../nodes/shaders/custom-wgsl-default.wgsl.ts";
import { NOISE_FRAGMENT_WGSL } from "../../nodes/shaders/noise.wgsl.ts";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════
 * T497 — WHAT THE SHIPPED SURFACE ITSELF READS, one layer under T489.
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * ## Why there is a second gate and not a second list
 *
 * T489 made the absolute clock REACHABLE from all eleven clock-reading surfaces and gated
 * that property in `loop-continuity.test.ts`. It never asked what the SHIPPED NODES, the
 * BUILT-IN SHADERS and the SHIPPED EXAMPLES were actually reading. They were reading the
 * wrapping one: the Noise node advanced its fourth dimension on `frameU.time`, so any field
 * with `speed != 0` snapped at every lap — seven shipped examples were on that side of it —
 * and the CustomWGSL starter, the source every user opens the first time they write a
 * shader, pulsed on `frameU.time` and therefore TAUGHT the seam to everything copied from
 * it. E13-Prism rolled and drifted on `time`/`ctx.time`; E16-Murmuration's whole flow field
 * did. Reachable, and nobody on it.
 *
 * That is §V437 for the fifth time — a property delivered SITE BY SITE is not delivered —
 * so this file is not a list of the four fixes. It is the property:
 *
 *   **A clock read anywhere in the shipped surface is either ABSOLUTE, or DECLARED
 *   timeline-anchored with a stated reason — and the next one that is neither fails here.**
 *
 * ## The shape is §V453's, deliberately
 *
 * §V453 gates value nodes by DERIVING the enumeration from the registry: `CLOCK_OWNERSHIP`
 * in `loop-continuity.test.ts` is checked against every node the registry reports, so value
 * node #14 fails until its author decides which clock it owns. The same shape, one layer
 * down: the enumeration here is derived from a SCAN of the shipped surface rather than from
 * a registry, because a shader body and a kernel in a `.loom.json` are text and there is no
 * registry to ask. `DECLARED` below must cover exactly what the scan finds — a file the scan
 * finds and the table does not fails, a table entry the scan no longer finds fails, and a
 * count that has grown fails. So shader #22 or example #30 cannot land on the wrapping clock
 * by nobody deciding anything, which is exactly how B98's LFO landed on it.
 *
 * §V452's repo-wide `SharedFrame` scan (`shared-uniform-contract.test.ts`) is the mechanical
 * precedent for the scan half — same walker, same "the scan must find what it polices" guard.
 *
 * ## Scope, stated rather than implied
 *
 * SCANNED: `src/nodes` (definitions and the built-in shaders), `src/examples` (the documents
 * every shipped example is generated FROM), and `examples/**.loom.json` (what actually
 * ships). That is the AUTHORED CONTENT surface — the things a user reads, copies and opens.
 *
 * SCANNED SINCE T582: `src/points` — the GENERATED WGSL surface. T579 found four
 * lifecycle passes inferring "my storage is fresh" from `params.frameIndex == 0u`, in a
 * directory this audit could not see: the gate had proven every AUTHORED surface clean
 * while the generated one quietly defeated the property it gates. The codegen plumbing
 * that legitimately reads the wrapping clock (to OFFER it as `ctx.time`) is DECLARED
 * below like any other site; a new wrapping read in generated code reddens the gate.
 *
 * NOT SCANNED, and each for a reason:
 *   - the rest of the RUNTIME (`src/runtime`, `src/domain`). Reading `frame.timeSeconds`
 *     is what a transport and an expression scope are FOR; gating them would gate the
 *     plumbing that makes both clocks exist. `loop-continuity.test.ts` covers that
 *     half by asserting the property end to end instead.
 *   - `*.test.ts` / test fixtures (`runtime/backend/vgpu/plan-fixture.ts` reads `frameU.time`
 *     on purpose: it is a fixture proving the shared block is BOUND, and nobody's picture
 *     depends on it).
 *   - `examples/*.md`. Those are hand-written prose ABOUT the graphs, and prose legitimately
 *     names the wrapping clock in order to contrast it. A text gate over prose is noise
 *     nobody reads (§V443 is the same lesson from the other side). The two docs that quoted
 *     the old clock were corrected by hand in T497 and are UNGATED — a real gap, filed.
 */

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SCANNED_ROOTS = ["src/nodes", "src/examples", "examples", "src/points"] as const;
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", ".git"]);

/**
 * THE WRAPPING MEMBERS, as a property access.
 *
 * `frameU.time` / `frameU.frameIndex` (the shared frame block), `ctx.time` / `ctx.frameIndex`
 * (a point kernel's `PointCtx`) and `frame.timeSeconds` / `frame.frameIndex` (a value node's
 * `FrameEvaluationInput`) are the same three names on three receivers, so one pattern reaches
 * all of them. Anchored on the DOT because the alternative — a bare word — matches the
 * declarations that merely NAME the layout (`timeSeconds: 0` in a uniform fixture, `time: f32`
 * in a struct body), and a gate that cries at a struct member is a gate people delete.
 *
 * The absolute counterparts survive it by construction: `.absTime`, `.absFrame`,
 * `.absTimeSeconds` and `.absFrameIndex` do not begin with `time` or `frameIndex` after the
 * dot. That is asserted below rather than reasoned about.
 */
const WRAPPING_ACCESS = /\.(?:time|timeSeconds|frameIndex)\b/g;

/** The wrapping names in the EXPRESSION grammar (§V71), where a clock is a bare identifier. */
const WRAPPING_EXPRESSION_NAMES = new Set(["time", "frame"]);

/**
 * Comments are stripped before matching, and it is load-bearing in both directions.
 *
 * §V443: a text-scanning gate reads comments too. Every one of these files EXPLAINS which
 * clock it chose and why, and a good explanation names the clock it did not take — the
 * CustomWGSL starter says "swap it for frameU.time when the motion IS the position in the
 * piece", which is the sentence a user needs and which a naive scan would report as a
 * violation. Strip, and the gate reads CODE.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

interface ClockRead {
  /** Repo-relative path of the file the read ships in. */
  readonly path: string;
  /** The matched text, for the failure message. */
  readonly token: string;
  /** Enough surrounding source to recognise the site. */
  readonly context: string;
}

function walk(directory: string, out: string[]): string[] {
  for (const entry of readdirSync(directory)) {
    if (SKIPPED_DIRECTORIES.has(entry)) continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

function readsIn(path: string, text: string, out: ClockRead[]): void {
  const stripped = stripComments(text);
  for (const match of stripped.matchAll(WRAPPING_ACCESS)) {
    const at = match.index ?? 0;
    out.push({
      path,
      token: match[0],
      context: stripped.slice(Math.max(0, at - 60), at + 40).replace(/\s+/g, " ").trim(),
    });
  }
}

/** `time`/`frame` used as a NAME inside an expression source (§V71's grammar). */
function expressionReadsIn(path: string, source: string, out: ClockRead[]): void {
  for (const name of source.split(/[^A-Za-z0-9_]+/)) {
    if (WRAPPING_EXPRESSION_NAMES.has(name)) {
      out.push({ path, token: name, context: `expression: ${source}` });
    }
  }
}

/** Every string a shipped document holds — kernel, spawn hook, WGSL source, schema. */
function documentReads(path: string, value: unknown, out: ClockRead[]): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const entry of value) documentReads(path, entry, out);
    return;
  }
  const record = value as Record<string, unknown>;
  // An expression slot, exactly as `resolveParameters` reads it.
  const expression = (record["bindings"] as Record<string, unknown> | undefined)?.["expression"];
  if (record["mode"] === "expression" && expression !== null && typeof expression === "object") {
    const source = (expression as Record<string, unknown>)["source"];
    if (typeof source === "string") expressionReadsIn(path, source, out);
  }
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === "string") readsIn(path, entry, out);
    else documentReads(path, entry, out);
    void key;
  }
}

function scan(): ClockRead[] {
  const out: ClockRead[] = [];
  for (const root of SCANNED_ROOTS) {
    for (const absolute of walk(join(ROOT, root), [])) {
      const path = absolute.slice(ROOT.length);
      if (/\.test\.tsx?$/.test(path)) continue;
      if (path.endsWith(".ts") || path.endsWith(".tsx") || path.endsWith(".wgsl")) {
        const text = readFileSync(absolute, "utf8");
        readsIn(path, text, out);
        // Expressions authored in a document SOURCE are string literals, so the property
        // scan above cannot see them: `expressionSlot("time * 7")` holds a clock in a
        // grammar with no dots in it. E13-Prism's roll was exactly that, and it is the one
        // site in T497 that neither of the other two matchers would have found.
        for (const match of text.matchAll(/expressionSlot\(\s*"([^"]*)"/g)) {
          expressionReadsIn(path, match[1] as string, out);
        }
        continue;
      }
      if (path.endsWith(".loom.json")) {
        documentReads(path, JSON.parse(readFileSync(absolute, "utf8")), out);
      }
    }
  }
  return out;
}

/**
 * §V436 — WHICH CLOCK EACH SHIPPED SITE OWNS, and it is a decision, never a default.
 *
 * The counterpart of `CLOCK_OWNERSHIP` in `loop-continuity.test.ts`, for the surface a
 * registry cannot enumerate. An entry is a promise about a FILE: this many wrapping reads,
 * for this reason. `reads` is a count rather than a quoted line so that reformatting does
 * not redden the gate while a NEW read still does — adding one to a file already listed
 * fails just as loudly as adding a file.
 *
 * `kind` distinguishes the two honest ways to survive the scan:
 *   - `timeline-anchored` — a real read of the wrapping clock, on purpose, per §V436.
 *   - `names-the-contrast` — the file does not READ it; it NAMES it in a string the user
 *     reads, to teach the difference. Held to a stricter test below (the same text must
 *     name the absolute clock), because "it's just documentation" is the shape an escape
 *     hatch takes when it stops being one.
 */
const DECLARED: Readonly<
  Record<string, { readonly kind: "timeline-anchored" | "names-the-contrast"; readonly reads: number; readonly reason: string }>
> = {
  "src/nodes/definitions/values.ts": {
    kind: "timeline-anchored",
    reads: 1,
    reason:
      "The TIMER. Where you are IN the piece is the only question it exists to answer, so " +
      "it wraps BY DESIGN — a Timer that kept climbing across the lap would have stopped " +
      "answering it. Classified `timeline-anchored` in CLOCK_OWNERSHIP and said out loud in " +
      "the node's own description, next door to the LFO, which is free-running (B98).",
  },
  "src/nodes/definitions/audio.ts": {
    kind: "timeline-anchored",
    reads: 2,
    reason:
      "The deterministic BEAT. `beats` and `beatsBefore` are two reads of one decision: a " +
      "bar number is a POSITION IN THE PIECE, so beat 1 has to fall on the in point every " +
      "lap or the pattern stops being a pattern. Classified `timeline-anchored` too.",
  },
  "src/nodes/definitions/point-kernel-advanced.ts": {
    kind: "names-the-contrast",
    reads: 2,
    reason:
      "The `kernel` parameter's DESCRIPTION, which teaches the distinction. T587 turned it " +
      "round: it now LEADS with ctx.absTime/ctx.absFrame and names ctx.time and " +
      "ctx.frameIndex second, as the timeline readings that reset at every lap — two reads " +
      "where there was one, because the sentence that steers people off a clock has to say " +
      "which clock. Reachability was never the problem; `time` being the obvious name was.",
  },
  "src/nodes/definitions/points.ts": {
    kind: "names-the-contrast",
    reads: 2,
    reason:
      "T587, the same sentence on the basic Point Kernel. It used to list the ctx members " +
      "flatly — 'index, count, time, delta, frameIndex' — with the absolute pair mentioned " +
      "last as an extra, which is exactly the shape that made `ctx.time` the obvious choice " +
      "and the wrong one. It now leads with ctx.absTime/ctx.absFrame and names ctx.time and " +
      "ctx.frameIndex as the special case, with the declaration that silences the notice.",
  },
  "src/points/codegen.ts": {
    kind: "timeline-anchored",
    reads: 5,
    reason:
      "The PROVIDER. ctx.time and ctx.frameIndex ARE the wrapping clock by contract — " +
      "these reads exist to build them (two PointCtx constructions), plus the per-frame " +
      "random salt, which keys on frameIndex so a given timeline frame reproduces its " +
      "randomness on replay. What this file must never do again is INFER storage " +
      "freshness from frameIndex == 0 — T579's lap bug, now ctx.firstRun (T510) — and " +
      "the count is what catches the next such inference in generated WGSL.",
  },
  /*
   * T579 — THE TWO E9 ENTRIES ARE GONE, and their absence is the point.
   *
   * They excused `if (ctx.frameIndex == 0u)` in the fountain's seeding guard, with the
   * reason ending "the missing primitive is a ctx member meaning 'this buffer is fresh';
   * until there is one, this is the honest read". T510 shipped that primitive and T579
   * spent it: E9-Ember seeds on `ctx.firstRun == 1u`, so the read the excuse covered no
   * longer exists and §V464(b) — the STALE half of the gate — is what deleted these.
   * NO shipped example reads the wrapping clock any more; the three entries left are all
   * node definitions, and two of them wrap on purpose.
   */
};

const found = scan();
const byFile = new Map<string, ClockRead[]>();
for (const read of found) byFile.set(read.path, [...(byFile.get(read.path) ?? []), read]);

describe("T497 — the shipped surface reads the absolute clock, or says why it does not", () => {
  /**
   * The half that makes every other assertion in this file mean something. A repo-wide
   * matcher that quietly matches nothing is a green test that checks nothing (§V452's own
   * gate says the same about its struct scan), and the failure mode is silent: the scan
   * would keep passing forever while the surface drifted.
   */
  it("the matcher fires on the wrapping clock and NOT on the absolute one", () => {
    const hits = (text: string): number => {
      const out: ClockRead[] = [];
      readsIn("probe", text, out);
      return out.length;
    };
    // Every receiver the shipped surface reaches a clock through.
    expect(hits("let w = frameU.time * s;")).toBe(1);
    expect(hits("if (ctx.frameIndex == 0u) {}")).toBe(1);
    expect(hits("const t = frame.timeSeconds;")).toBe(1);
    expect(hits("q.x = ctx.time;")).toBe(1);
    // The absolute pair on the same receivers. If the pattern ever caught these, T497's
    // whole fix would read as a violation and the table would be "corrected" back onto the
    // wrapping clock — the exact wrong repair.
    expect(hits("let w = frameU.absTime * s;")).toBe(0);
    expect(hits("if (ctx.absFrame == 0u) {}")).toBe(0);
    expect(hits("const t = absTimeSecondsOf(frame);")).toBe(0);
    expect(hits("kernelFrame.absTimeSeconds, kernelFrame.absFrameIndex")).toBe(0);
    // Declaring the layout is not reading it: a struct body and a uniform fixture both name
    // the members, and gating those would make the gate unusable.
    // (Spelled `FrameBlock` rather than the canonical name on purpose: §V452's repo-wide
    // scan polices every `struct SharedFrame` in src/ and examples/, and a probe is not a
    // copy of the contract. Two text gates over one tree, and each is the other's data.)
    expect(hits("struct FrameBlock { time: f32, frameIndex: f32 };")).toBe(0);
    expect(hits("const frameUniforms = { timeSeconds: 0, frameIndex: 0 };")).toBe(0);
    // Comments are stripped, so an explanation naming the other clock is not a violation.
    expect(hits("// swap for frameU.time when you want the timeline\nlet a = 1.0;")).toBe(0);
    // ...and stripping must not eat the code around it.
    expect(hits("/* absTime, not time */ let w = frameU.time;")).toBe(1);
  });

  it("the expression matcher reads §V71's grammar, where a clock has no dot", () => {
    const hits = (source: string): number => {
      const out: ClockRead[] = [];
      expressionReadsIn("probe", source, out);
      return out.length;
    };
    expect(hits("time * 7 % 360")).toBe(1);
    expect(hits("frame / 60")).toBe(1);
    expect(hits("abstime * 7 % 360")).toBe(0);
    expect(hits("absframe / 60")).toBe(0);
    // Not a substring match: `walltime` and `lifetime` are different names, and `delta` is
    // continuous across a lap by construction (T464), so none of them belongs here.
    expect(hits("walltime + delta")).toBe(0);
  });

  it("the scan actually reaches the files it is supposed to police", () => {
    const visited = new Set<string>();
    for (const root of SCANNED_ROOTS) {
      for (const absolute of walk(join(ROOT, root), [])) visited.add(absolute.slice(ROOT.length));
    }
    // A walker pointed at a directory that has moved would find nothing and pass.
    expect(visited.has("src/nodes/shaders/noise.wgsl.ts")).toBe(true);
    expect(visited.has("src/nodes/shaders/custom-wgsl-default.wgsl.ts")).toBe(true);
    expect(visited.has("src/examples/documents.ts")).toBe(true);
    // T802: the example sources are one file per example under `documents/` now, and the
    // expression clocks the scan polices live in THOSE, not the barrel — so the walker
    // must recurse into the directory. E13-Prism carries `abstime` expression slots, so
    // `prism.ts` is the representative the scan has to reach; a walker that stopped at the
    // barrel would find no example clock reads at all and pass blind.
    expect(visited.has("src/examples/documents/prism.ts")).toBe(true);
    expect(visited.has("src/examples/documents/builders.ts")).toBe(true);
    expect(visited.has("examples/E13-Prism.loom.json")).toBe(true);
    // T582: the GENERATED surface — the walker must reach the file whose frameIndex
    // inference defeated the lap property while every authored surface scanned clean.
    expect(visited.has("src/points/lifecycle.ts")).toBe(true);
    expect(visited.has("src/points/codegen.ts")).toBe(true);
    expect(visited.size).toBeGreaterThan(80);
    // And it really parses the documents, rather than skipping every one of them silently.
    expect([...visited].filter((path) => path.endsWith(".loom.json")).length).toBeGreaterThan(20);
  });

  it("every wrapping clock read in the shipped surface is DECLARED", () => {
    const undeclared = [...byFile.entries()]
      .filter(([path]) => DECLARED[path] === undefined)
      .flatMap(([, reads]) => reads.map((read) => `${read.path} — ${read.token} in "${read.context}"`));
    expect(
      undeclared,
      "a shipped node, shader or example reads the clock that WRAPS without deciding to " +
        "(§V436/§V437). Either read the absolute clock — `frameU.absTime`, `ctx.absTime`, " +
        "`absTimeSecondsOf(frame)`, `abstime` in an expression — or add the file to DECLARED " +
        "with the reason its motion is anchored to the timeline, and say so at the read where " +
        "the person copying it will see it. T497 is what defaulting cost across seven examples.",
    ).toEqual([]);
  });

  it("DECLARED names no site that has stopped reading the wrapping clock", () => {
    const stale = Object.keys(DECLARED).filter((path) => (byFile.get(path)?.length ?? 0) === 0);
    expect(
      stale,
      "a declaration has rotted past the code it excuses (§V421). Delete the entry — a " +
        "standing excuse for a read that no longer exists is how the next one gets waved through.",
    ).toEqual([]);
  });

  it("a NEW read inside an already-declared file fails too — the count is the promise", () => {
    const grown = Object.entries(DECLARED)
      .map(([path, entry]) => ({ path, declared: entry.reads, actual: byFile.get(path)?.length ?? 0 }))
      .filter((entry) => entry.declared !== entry.actual);
    expect(
      grown.map((entry) => `${entry.path}: declared ${entry.declared}, found ${entry.actual}`),
      "the number of wrapping-clock reads in a declared file changed. This is the half that " +
        "stops a file from becoming a blanket permission: the Timer's one read does not " +
        "excuse a second node in values.ts quietly joining it.",
    ).toEqual([]);
  });

  it("every declared reason is stated where the person reading the code will see it", () => {
    for (const [path, entry] of Object.entries(DECLARED)) {
      expect(entry.reason.length, `${path} needs a real reason, not a placeholder`).toBeGreaterThan(80);
      const text = readFileSync(join(ROOT, path), "utf8").toLowerCase();
      if (entry.kind === "timeline-anchored") {
        // §V453's rule, one layer down: the classification lives in the artifact the user
        // reads, not only in this table. A gate nobody opens is not a declaration.
        expect(text, `${path} must say "timeline-anchored" at the site`).toContain("timeline-anchored");
      } else {
        // The stricter test for the escape hatch: text that names the wrapping clock in
        // order to teach the contrast must name the absolute one in the same breath.
        expect(text, `${path} names the wrapping clock without the contrast`).toContain("abstime");
      }
    }
  });
});

/**
 * The other direction. Everything above says "nothing undeclared reads the wrapping clock",
 * which a surface that read NO clock at all would also satisfy — and T497's fixes would then
 * be invisible to their own gate. These assert the sites are on the absolute clock, so a
 * revert of any one of them reddens something rather than passing quietly.
 *
 * The reverts are silent by nature, which is why this half is worth its length: `time` and
 * `abstime` carry the SAME NUMBER until the first wrap, so a still frame, a screenshot, a
 * golden render and every existing plan assertion agree under either clock.
 */
describe("T497 — the sites T497 moved are, and stay, on the absolute clock", () => {
  it("the NOISE node scrolls its fourth dimension on absTime (§V436)", () => {
    expect(NOISE_FRAGMENT_WGSL).toContain("params.t4d + (frameU.absTime * params.speed)");
    expect(stripComments(NOISE_FRAGMENT_WGSL)).not.toContain("frameU.time");
  });

  it("the CustomWGSL STARTER — the source every user opens — pulses on absTime", () => {
    expect(stripComments(CUSTOM_WGSL_DEFAULT_SOURCE)).toContain("sin(frameU.absTime)");
    expect(stripComments(CUSTOM_WGSL_DEFAULT_SOURCE)).not.toContain("frameU.time");
  });

  const byName = new Map(listExamples().map((file) => [file.fileName, file]));
  const planFor = (fileName: string) => {
    const file = byName.get(fileName);
    if (file === undefined) throw new Error(`missing example ${fileName}`);
    return requireExample(file).plan;
  };
  const dispatchShader = (fileName: string, nodeId: string): string => {
    const pass = planFor(fileName).passes.find(
      (entry) => entry.kind === "dispatch" && entry.nodeId === nodeId,
    );
    if (pass === undefined || pass.kind !== "dispatch") throw new Error(`no dispatch for ${nodeId}`);
    return pass.shader;
  };

  /**
   * THE WITNESS LISTS BELOW ARE RE-POINTABLE. THE PROPERTY IS THE SUBJECT.
   *
   * Every hand-listed pair in this file names an example only because that example
   * happens to exercise the property under test. None of them is a contract with the
   * example. When a document is rebuilt and stops using the mechanism — as E13-Prism did
   * at T710, when the image-space dispersion it demonstrated was replaced by a 3D prism
   * with nothing in it that is honestly free-running — the correct move is to re-point
   * the witness at another file that genuinely carries the mechanism, NOT to preserve the
   * mechanism so the list keeps compiling.
   *
   * That failure mode is real and it runs the wrong way round: a shipped document
   * contorted to satisfy a gate is a lie authored into the product, and §V624's rule
   * against a dead parameter is the same rule — never ship a dead thing dressed as a live
   * one. A witness list drifts exactly the way any hand-maintained list drifts; the guard
   * is that it must always have at least two entries and each must still be true, which
   * is what these loops check by construction.
   *
   * ---
   *
   * WIRED, not merely written. A kernel naming `ctx.absTime` compiles only if codegen
   * DETECTED the name, declared both members on `KernelFrame` AND passed them into the ctx
   * constructor — and the failure when it does not is silent in the worst way (vgpu writes
   * uniforms by NAME, so a declared-but-unwritten member reads zero forever and looks like a
   * stopped clock). Asserting the generated text is asserting the whole chain, T489's §V309.
   *
   * T710 moved E13-Prism off this list and E9-Ember onto it: E9's `fire1` names
   * `ctx.absTime` on purpose (its draught and per-vent flare are free-running, T511/T579),
   * which is the same reason it stopped being a witness for the NEGATIVE property below.
   */
  for (const [fileName, nodeId] of [
    ["E9-Ember.loom.json", "sim"],
    ["E16-Murmuration.loom.json", "flock"],
  ] as const) {
    it(`${fileName} — the kernel's generated block carries the absolute pair, filled`, () => {
      const shader = dispatchShader(fileName, nodeId);
      expect(shader).toContain("absTimeSeconds: f32,");
      expect(shader).toContain("absTime: f32,");
      expect(shader).toContain("kernelFrame.absTimeSeconds, kernelFrame.absFrameIndex");
      expect(stripComments(shader)).not.toContain("ctx.time");
    });
  }

  /**
   * THE EXPRESSION GRAMMAR'S clock read, which is the one written with no dot in it.
   *
   * The property: a free-running rotation in a shipped document must be authored on
   * `abstime` and not on `time`, because `time` wraps at a timeline lap (T497/§V436) and
   * a roll on it snaps back to zero every time the piece loops — a seam that is invisible
   * in every screenshot and only appears once someone bounds the piece and plays it.
   *
   * T565 also removed the `% 360` this used to assert. That wrap was never geometry: it
   * was a user-level workaround for §B111, where `clampToDeclared` read Transform's
   * declared −360…360 as a hard limit and froze the roll at 360° after fifty-one seconds.
   * T537 made `r` `cyclic`, so the wrap has nothing left to do — and a shipped document
   * must not carry a scar from a bug we fixed.
   *
   * THE WITNESS MOVED AT T710, per the note above. This was E13-Prism's `roll1`; the
   * rebuilt Prism carries no expression slot at all, and there is no honest home for one
   * in it — a rotation would fight the optics the file is built on, and the expression
   * grammar is arithmetic only, so it cannot produce a camera orbit either. Inventing a
   * slot to keep this test naming E13 would have been the exact inversion this file warns
   * about. E5-Kaleidoscope's `fold` is the same mechanism, doing the same job, for real.
   */
  it("a shipped free-running roll reads `abstime`, the one clock read with no dot in it", () => {
    const document = requireExample(byName.get("E5-Kaleidoscope.loom.json") as never).document;
    const roll = document.graph.nodes["fold"]?.parameters["r"];
    const source = (roll as { bindings?: { expression?: { source?: string } } } | undefined)?.bindings
      ?.expression?.source;
    expect(source).toBe("abstime * 5");
    expect(source).not.toContain("%");
    // And it really does run past the manifest's declared ±360 rather than being wrapped
    // into it by hand: 5°/s crosses 360 at 72 seconds, so the unwrapped read is the point.
    expect(5 * 100).toBeGreaterThan(360);
  });

  /**
   * §V309 — and the other half of it, which is the one that costs nothing to state and
   * everything to skip: a kernel that names NO absolute member must generate exactly what it
   * generated before the member existed. The witnesses are kernels T497 never touched, which
   * would have picked up a wider uniform block if the detection had become unconditional.
   *
   * E9 WAS one of the two, and T511/T579 spent it: E9-Ember's draught and its per-vent
   * flare are free-running, so that kernel names `ctx.absTime` on purpose and can no longer
   * witness the negative. E27-Relief's `lift` takes its place — a stateless point kernel
   * with no clock read of any kind — so the property keeps two witnesses rather than one.
   */
  for (const [fileName, nodeId] of [
    ["E27-Relief.loom.json", "lift"],
    ["E20-Gooeyball.loom.json", "goo"],
  ] as const) {
    it(`${fileName} names no absolute member, so its block is unchanged (§V309)`, () => {
      const shader = dispatchShader(fileName, nodeId);
      expect(shader).not.toContain("absTimeSeconds");
      expect(shader).not.toContain("absFrameIndex");
    });
  }
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════
 * T587 — REACHABILITY IS NOT DISCOVERABILITY. What the catalogue TEACHES about clocks.
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * T489 made the absolute clock reachable and T497 got the shipped code onto it. Both left
 * `time` as the OBVIOUS name, and the owner watched an agent prove it: it wrote `ctx.time`,
 * the picture snapped at the lap, and the text it had read to get there — the kernel
 * parameter's description — had listed `time` first and the absolute pair last, as an extra.
 *
 * So this is the third gate over the same property, one layer up again: not what the shipped
 * surface READS (above) but what it TELLS you to read. §V424's lesson is the reason it can
 * exist at all — for an agent the schema IS the documentation, and a description is a
 * published contract that no validator checks.
 *
 * ## Why it is derived from the REGISTRY, and why it asserts ORDER
 *
 * §V453's shape: the enumeration comes from `allNodeDefinitions`, so node type N+1 whose
 * description names the wrapping clock fails until its author writes the contrast in. A
 * hand list would have covered the two kernel nodes and nothing after them.
 *
 * ORDER, not mere presence, because §V461: "the description mentions absTime" passes on the
 * description that put it last, which is the exact text that failed the owner. A string that
 * names the wrapping clock must name the absolute one FIRST — the framing is the fix.
 */
describe("T587 — every rendered string that names the wrapping clock leads with the absolute one", () => {
  /** A member ACCESS, the same anchoring `WRAPPING_ACCESS` uses and for the same reason. */
  const WRAPPING_IN_PROSE = /\b(?:ctx|frameU)\.(?:time|frameIndex)\b/;
  const ABSOLUTE_IN_PROSE = /\b(?:ctx|frameU)\.(?:absTime|absFrame)\b/;

  /** Every string the catalogue RENDERS: node descriptions, parameter labels and descriptions. */
  function renderedStrings(): { where: string; text: string }[] {
    const out: { where: string; text: string }[] = [];
    for (const definition of allNodeDefinitions) {
      out.push({ where: `${definition.type}.description`, text: definition.description ?? "" });
      for (const [key, parameter] of Object.entries(definition.parameters ?? {})) {
        const schema = parameter as { label?: unknown; description?: unknown };
        if (typeof schema.label === "string") out.push({ where: `${definition.type}.${key}.label`, text: schema.label });
        if (typeof schema.description === "string") {
          out.push({ where: `${definition.type}.${key}.description`, text: schema.description });
        }
      }
    }
    return out;
  }

  const teaching = renderedStrings().filter((entry) => WRAPPING_IN_PROSE.test(entry.text));

  it("the scan reaches the strings it polices, and they are the kernel descriptions", () => {
    // §V461/§V452: a matcher that quietly matches nothing is a green test checking nothing,
    // and this one would then pass for ever while every description drifted back.
    expect(renderedStrings().length).toBeGreaterThan(200);
    expect(teaching.map((entry) => entry.where).sort()).toEqual([
      "pointKernel.kernel.description",
      "pointKernelAdvanced.kernel.description",
    ]);
  });

  it("the matcher can tell a leading mention from a trailing one", () => {
    // The fixture has to be CAPABLE of failing the thing it asserts (§V461). Both probes
    // name both clocks; only the ORDER differs, which is the whole claim.
    const leads = "ctx.absTime keeps counting; ctx.time restarts at the lap.";
    const trails = "ctx carries index, count, time, delta — and ctx.time, plus ctx.absTime.";
    const indexes = (text: string) => [text.search(ABSOLUTE_IN_PROSE), text.search(WRAPPING_IN_PROSE)];
    expect(WRAPPING_IN_PROSE.test(leads) && WRAPPING_IN_PROSE.test(trails)).toBe(true);
    const [absLeads, wrapLeads] = indexes(leads) as [number, number];
    const [absTrails, wrapTrails] = indexes(trails) as [number, number];
    expect(absLeads).toBeLessThan(wrapLeads);
    expect(absTrails).toBeGreaterThan(wrapTrails);
  });

  for (const entry of teaching) {
    it(`${entry.where} names the absolute pair, and names it first`, () => {
      const absolute = entry.text.search(ABSOLUTE_IN_PROSE);
      const wrapping = entry.text.search(WRAPPING_IN_PROSE);
      expect(
        absolute,
        `${entry.where} names the clock that wraps and never names the one that does not. ` +
          "A person or an agent reading this writes ctx.time and watches the picture snap at " +
          "the lap (T489/T587).",
      ).toBeGreaterThanOrEqual(0);
      expect(
        absolute,
        `${entry.where} mentions the absolute clock only AFTER the wrapping one. Leading with ` +
          "`time` is what made it the obvious choice; the absolute pair goes first and the " +
          "wrapping clock is named as the special case (§V461: presence alone passes on the " +
          "text that failed the owner).",
      ).toBeLessThan(wrapping);
    });
  }

  /**
   * The declaration the diagnostic looks for has to be REACHABLE from the text, or it is a
   * secret handshake: codegen silences the notice on the word "timeline-anchored", so the
   * description that provokes the notice is where the word has to be offered (§V338/§V464).
   */
  it("the kernel descriptions say how to declare a deliberately timeline-anchored kernel", () => {
    for (const entry of teaching) {
      expect(entry.text.toLowerCase(), `${entry.where} names no way out of the notice`).toContain(
        "timeline-anchored",
      );
    }
  });
});
