import {
  absFrameIndexOf,
  absTimeSecondsOf,
  BEATS_PER_BAR,
  fpsOf,
  subframesOf,
  tempoOf,
  wallDeltaSecondsOf,
  wallSecondsOf,
} from "../types/frame.ts";
import type { FrameEvaluationInput } from "../types/frame.ts";

/**
 * The parameter expression engine (T108, §V71): own closed grammar, jsep-style AST,
 * deterministic and sandboxed by construction.
 *
 * This is THE single evaluator in the codebase — numeric text entry in the inspector
 * delegates here (`src/ui/controls/expression.ts`), and future expression-driven
 * parameters resolve through the same module, so `"1.5"`, `"1 + 0.5"` and a bound
 * `"time * 2"` can never disagree about arithmetic.
 *
 * Safety model: hand-written tokeniser and recursive-descent parser, no `eval`, no
 * `new Function`, no host globals. Expression text arrives from project files and from
 * agents, and §V37 treats both as untrusted; anything outside the grammar is rejected
 * with a reason, and nothing here ever throws. Variables come ONLY from the scope the
 * caller passes (FrameEvaluationInput plus node context), never from ambient state, so
 * the same AST and scope always produce the same value (§V44, §V45).
 *
 * Grammar: numbers, `+ - * / % ^`, unary sign, parentheses, scope variables, `op()`
 * references, and the closed function whitelist in `FUNCTIONS` below (T370).
 */

export type ExpressionAst =
  | { kind: "number"; value: number }
  | { kind: "variable"; name: string }
  /**
   * A node reference, `op('noise1').par.gain` (§V127, T221). PARSED now, so it can be
   * stored, validated and rename-rewritten (§V128) today; EVALUATION arrives with the
   * cross-node read path and until then resolves to a named failure, which the
   * parameter resolver turns into the §V108 fallback rather than an error wall.
   */
  | { kind: "opRef"; name: string; path: readonly string[] }
  /**
   * VN36 — `parent().par.gain`, `parent(2).par.tint.r`: a published parameter of the
   * component `hops` levels out (§V81). `path` is always `["par", key]` or
   * `["par", key, component]`; the parser refuses every other shape. `at`/`end` are its span
   * in the TRIMMED source, a pure function of the text like the rest of the tree (the parse
   * memo shares it), and they are what lets the flattener rewrite the read in place.
   *
   * Nothing evaluates one: the flattener rewrites it to an `op()` read of the instance it
   * names (`parent-reads.ts`), and one that reaches the evaluator was never inside a
   * component.
   */
  | { kind: "parentRef"; hops: number; path: readonly string[]; at: number; end: number }
  /** A whitelisted function call (T370). Arity is checked at PARSE time; see `FUNCTIONS`. */
  | { kind: "call"; name: string; args: readonly ExpressionAst[] }
  | { kind: "unary"; operator: "-" | "+"; operand: ExpressionAst }
  | {
      kind: "binary";
      operator: "+" | "-" | "*" | "/" | "%" | "^" | "==" | "!=" | "<" | "<=" | ">" | ">=";
      left: ExpressionAst;
      right: ExpressionAst;
    };

export type ExpressionScope = Readonly<Record<string, number>>;

/**
 * How `op('name').par.key` is READ (T316, §V148, §V61).
 *
 * A callback rather than a lookup table, because resolving another node's parameter is a
 * recursive resolve — the referenced parameter may itself be an expression, a bind or a
 * driven channel — and it is the caller that owns the graph, the schema and the cycle
 * guard. This module stays what §V71 says it is: a grammar and an evaluator over numbers,
 * with no idea what a node is.
 *
 * Returns a RESULT, not a bare number, so a failure arrives with a reason a human can act
 * on. "That node does not exist", "that parameter is not a number" and "this reference is
 * a cycle" are three different problems and a silent `undefined` is none of them (§V148
 * wants a cross-node reference that fails to fail LOUDLY, with the name in the message).
 */
export type NodeReferenceResult =
  | { ok: true; value: number }
  | { ok: false; kind?: ReferenceFailureKind; reason: string; suggestion?: string };

/**
 * §T1641b: a read that ALWAYS says why it failed. The product's one reader
 * (`node-references.ts`) is typed to return this, so a failure site there cannot leave its
 * kind out. `NodeReferenceResult` lets a hand-built reader (a test's) omit it, and the
 * evaluator then reads the failure as `unreadable`: a refusal that does not say when it
 * would read gives no reason to think it will.
 */
export type KindedNodeReferenceResult =
  | { ok: true; value: number }
  | { ok: false; kind: ReferenceFailureKind; reason: string; suggestion?: string };

/**
 * §T1641b — WHY a node reference failed, as a KIND a caller can act on. The reason is for a
 * person; the kind decides the diagnostic's code, and through the code its class
 * (`src/domain/diagnostics/classes.ts`): whether the reference can never read as written,
 * or reads once something else arrives. Before this the resolver told one kind from the
 * others by searching the reason's text for a marker.
 *
 *  - `unreadable`  the path can never read: a shape the reader refuses, a parameter the
 *                  target does not declare, a component it does not have, a compound read
 *                  whole, a value that is not a number.
 *  - `ambiguous`   an instance publishes that channel on more than one output.
 *  - `cycle`       the chain of references returns to itself (§V152).
 *  - `node`        no node has that name: it reads once one does.
 *  - `channel`     the target publishes no such channel right now.
 *  - `upstream`    the parameter read carries a failure of its own; this one clears with it.
 *  - `unknownType` the target's type is not one this build has (a §V10 placeholder).
 *  - `noResolver`  this context has no channel resolver (§V338): a state of the caller.
 *  - `noGraph`     this context has no reader at all: a storage read, a bare evaluation.
 */
export type ReferenceFailureKind =
  | "unreadable"
  | "ambiguous"
  | "cycle"
  | "node"
  | "channel"
  | "upstream"
  | "unknownType"
  | "noResolver"
  | "noGraph";

/**
 * §T1641b — why an expression failed. `syntax` is everything the parser refuses (a token,
 * a parenthesis, a function the grammar lacks, a wrong number of arguments, a malformed
 * `op()`); `name` is a bare name no scope supplies; `value` is arithmetic with no finite
 * answer for THESE inputs (a division by zero, an inverted `clamp`), which another frame
 * may not hit; the rest are the reader's.
 */
export type ExpressionFailureKind = "syntax" | "name" | "value" | `reference.${ReferenceFailureKind}`;

/** What in a graph is spelled like a bare name (see `NodeReferenceReader.spelledLike`). */
export interface SpelledLike {
  /** Nodes named it, or named `kind_<it>`. */
  readonly nodes: readonly string[];
  /** Nodes publishing a channel of that name right now. */
  readonly publishers: readonly string[];
}

export type NodeReferenceReader = ((name: string, path: readonly string[]) => NodeReferenceResult) & {
  /**
   * §T1641b: for the unknown-name message, which says whether a node or a channel of that
   * spelling exists. Absent on a reader that cannot say (a hand-built one).
   */
  readonly spelledLike?: (name: string) => SpelledLike;
  /**
   * §B293: the same reader, told WHICH PARAMETER IS ASKING. A ring is a parameter reached
   * again, and the parameter a resolve starts from is on it like any other: without this
   * the first one was not, so a ring was caught one hop late and a parameter read from its
   * own node and from another node could answer differently. Absent on a hand-built reader.
   */
  readonly readingFrom?: (nodeId: string, key: string) => NodeReferenceReader;
  /** T1720b: subtree values for this reader's life (see {@link SubtreeMemory}). Absent: none are kept. */
  readonly subtrees?: SubtreeMemory;
};

/**
 * T1720b — WHAT A READER REMEMBERS OF A TREE.
 *
 * Structurally equal subtrees are one object (`internAst`), so a subtree's value is kept by
 * identity and a repeat anywhere in the reader's frame costs a lookup. The rule is §T1172's:
 * a value computed while the reader's cycle guard fired depends on the path that asked, and
 * is not kept.
 */
export interface SubtreeMemory {
  readonly values: Map<ExpressionAst, number>;
  /** How many times the reader's cycle guard (§V152) has fired so far. */
  readonly fired: () => number;
}

/**
 * The function whitelist (T370) — closed, small, and argued name by name.
 *
 * ## What the grammar is FOR
 *
 * An expression is a value written WHERE IT IS READ: no node, no wire, no channel. That
 * is locality, and locality was already worth having with arithmetic alone. What
 * arithmetic alone could not do was say anything PERIODIC or BOUNDED, which is most of
 * what a parameter on a moving image wants to say — so `time * 7` on a ±360 rotate was
 * the only ramp available, and it hits the manifest's limit and stops (T368). Every name
 * below earns its place by one of two tests:
 *
 *  - the arithmetic grammar CANNOT express it (`sin`, `cos`, `min`, `max`, `floor`,
 *    `ceil`, `round`, `sign` — no series here; comparisons joined the GRAMMAR in T628;
 *    `atan2` joined in T1420b: there is no inverse trig to build it from, and it is the
 *    angle of a position, finite for every input); or
 *  - it is the CORRECT form of something the arithmetic form gets subtly wrong
 *    (`clamp` is what a bounded parameter does to you silently, said out loud; `mod` is a
 *    true modulo where `%` is a remainder that goes negative below zero; `fract` is the
 *    0..1 phase `x % 1` only appears to be; T1420b: `exp` is the `e ^ x` a typed-in
 *    `2.718 ^ x` only approximates, and `smoothstep` is the eased ramp whose arithmetic
 *    form repeats one clamped term, `t ^ 2 * (3 - 2 * t)`, where a typo in either copy
 *    still evaluates — the On Nothing shots (§T1400b) spelled it out in two helpers).
 *
 * Names that fail both tests stay out, and the rejection message lists what is in, so
 * typing one teaches the boundary instead of just failing. `sqrt` is `x ^ 0.5`; `mix` is
 * `a + (b - a) * t`; `hypot` and `pow` are the same story. `tan`, `log`, `asin` and
 * friends are excluded for a second reason as well: each has inputs where it returns a
 * non-finite number, and this evaluator's contract is a finite one — `exp` is let in
 * because its one such input, an overflow above ~709, is refused by name.
 *
 * ## Cost
 *
 * This runs on the CPU for every expression-mode parameter, every frame (§V163). A call
 * costs one `Map`-free object lookup plus the `Math` builtin; ARITY is checked when the
 * source is PARSED, so the per-frame path never re-validates a shape that cannot have
 * changed. Parse once, evaluate per frame, exactly as before.
 */
interface FunctionSpec {
  /** Argument names, in order. Length IS the arity, and the call shape shown in help. */
  readonly params: readonly string[];
  readonly apply: (args: readonly number[]) => number;
}

/** Fails loud rather than defaulting: `undefined` here would mean the arity check missed. */
function nth(args: readonly number[], index: number): number {
  const value = args[index];
  if (value === undefined) fail("syntax", `argument ${index + 1} is missing`);
  return value;
}

const FUNCTIONS: Readonly<Record<string, FunctionSpec>> = {
  abs: { params: ["x"], apply: (a) => Math.abs(nth(a, 0)) },
  /** The angle of (x, y) in radians, -π..π, quadrant included — what `y / x` loses. */
  atan2: { params: ["y", "x"], apply: (a) => Math.atan2(nth(a, 0), nth(a, 1)) },
  ceil: { params: ["x"], apply: (a) => Math.ceil(nth(a, 0)) },
  clamp: {
    params: ["x", "low", "high"],
    apply: (a) => {
      const [x, low, high] = [nth(a, 0), nth(a, 1), nth(a, 2)];
      // An inverted range is a typo, not a value: silently returning `high` would pin the
      // parameter at a number the author never asked for and never sees a reason for.
      if (low > high) fail("value", `clamp(): the low bound ${low} is above the high bound ${high}`);
      return Math.min(Math.max(x, low), high);
    },
  },
  cos: { params: ["x"], apply: (a) => Math.cos(nth(a, 0)) },
  exp: {
    params: ["x"],
    apply: (a) => {
      const value = Math.exp(nth(a, 0));
      // Refused HERE, by name, rather than as the generic "not a finite number" at the end:
      // an intermediate Infinity can also cancel into a finite number that means nothing.
      if (!Number.isFinite(value)) fail("value", `exp(): exp(${nth(a, 0)}) overflows`);
      return value;
    },
  },
  floor: { params: ["x"], apply: (a) => Math.floor(nth(a, 0)) },
  /** The 0..1 phase. `x % 1` is negative for negative x; this never is. */
  fract: { params: ["x"], apply: (a) => nth(a, 0) - Math.floor(nth(a, 0)) },
  max: { params: ["a", "b"], apply: (a) => Math.max(nth(a, 0), nth(a, 1)) },
  min: { params: ["a", "b"], apply: (a) => Math.min(nth(a, 0), nth(a, 1)) },
  /** TRUE modulo: `mod(-10, 360)` is 350, where `-10 % 360` is -10. */
  mod: {
    params: ["x", "period"],
    apply: (a) => {
      const period = nth(a, 1);
      if (period === 0) fail("value", "mod(): the period is zero");
      return nth(a, 0) - Math.floor(nth(a, 0) / period) * period;
    },
  },
  round: { params: ["x"], apply: (a) => Math.round(nth(a, 0)) },
  sign: { params: ["x"], apply: (a) => Math.sign(nth(a, 0)) },
  sin: { params: ["x"], apply: (a) => Math.sin(nth(a, 0)) },
  /**
   * WGSL's `smoothstep`, so a shader's easing reads the same in the knob beside it: 0 at
   * `low`, 1 at `high`, Hermite-eased between. `low > high` is the falling ramp the formula
   * gives (`smoothstep(1, 0, x)` fades out — an idiom, not a typo). Equal edges are refused:
   * the ramp has no width, and which side of the step `x == low` lands on is a guess.
   */
  smoothstep: {
    params: ["low", "high", "x"],
    apply: (a) => {
      const [low, high, x] = [nth(a, 0), nth(a, 1), nth(a, 2)];
      if (low === high) fail("value", `smoothstep(): the edges are equal (${low}), so the ramp has no width`);
      const t = Math.min(Math.max((x - low) / (high - low), 0), 1);
      return t * t * (3 - 2 * t);
    },
  },
};

/** Every function name the grammar accepts, sorted. The evaluator's own statement (§V150). */
export function functionNames(): readonly string[] {
  return Object.keys(FUNCTIONS).sort();
}

/** `clamp(x, low, high)` — the call shape, for help and completion. Null if unknown. */
export function functionSignature(name: string): string | null {
  const spec = FUNCTIONS[name];
  return spec === undefined ? null : `${name}(${spec.params.join(", ")})`;
}

/**
 * §T1641b — WHAT TO WRITE INSTEAD of a function the grammar leaves out. The docblock above
 * `FunctionSpec` argues each name in prose; this is the same argument as data, so the
 * refusal hands the author the replacement in their own operands (§B262: `pow(x, 2)`
 * shipped in three lamps, and the message listed fifteen other functions). A string is a
 * name left out because it has no finite answer for every input, and says so.
 *
 * `write` takes each argument twice: ready to stand as an OPERAND (parenthesised when it
 * is more than one term), and verbatim, for a slot that is already delimited.
 */
interface Rewrite {
  readonly params: readonly string[];
  readonly write: (operands: readonly string[], verbatim: readonly string[]) => string;
}

const NOT_FINITE = "its result is not finite for every input";
const BLEND: Rewrite = { params: ["a", "b", "t"], write: ([a = "", b = "", t = ""]) => `${a} + (${b} - ${a}) * ${t}` };

const REWRITES: Readonly<Record<string, Rewrite | string>> = {
  acos: NOT_FINITE,
  asin: NOT_FINITE,
  atan: { params: ["x"], write: (_operands, [x = ""]) => `atan2(${x}, 1)` },
  hypot: { params: ["a", "b"], write: ([a = "", b = ""]) => `(${a} ^ 2 + ${b} ^ 2) ^ 0.5` },
  lerp: BLEND,
  log: NOT_FINITE,
  log2: NOT_FINITE,
  mix: BLEND,
  pow: { params: ["a", "b"], write: ([a = "", b = ""]) => `${a} ^ ${b}` },
  saturate: { params: ["x"], write: (_operands, [x = ""]) => `clamp(${x}, 0, 1)` },
  sqrt: { params: ["x"], write: ([x = ""]) => `${x} ^ 0.5` },
  step: { params: ["edge", "x"], write: ([edge = "", x = ""]) => `(${x} >= ${edge})` },
  tan: { params: ["x"], write: (_operands, [x = ""]) => `sin(${x}) / cos(${x})` },
};

/**
 * The grammar's replacement for a function it leaves out, in general form
 * (`pow(a, b) is written a ^ b.`), or why it has none. Null for a name with no row.
 */
export function rewriteOf(name: string): string | null {
  const rewrite = Object.hasOwn(REWRITES, name) ? REWRITES[name] : undefined;
  if (rewrite === undefined) return null;
  if (typeof rewrite === "string") return `The grammar has no ${name}(): ${rewrite}.`;
  return `${name}(${rewrite.params.join(", ")}) is written ${rewrite.write(rewrite.params, rewrite.params)}.`;
}

/**
 * Edit distance: an insertion, a deletion, a substitution or a swap of two neighbours, one
 * each. The swap is counted as one because it is the commonest slip (`gian` for `gain`).
 */
function editDistance(a: string, b: string): number {
  let beforePrevious: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_unused, index) => index);
  for (let row = 1; row <= a.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= b.length; column += 1) {
      const substitute = (previous[column - 1] ?? 0) + (a[row - 1] === b[column - 1] ? 0 : 1);
      let best = Math.min(substitute, (previous[column] ?? 0) + 1, (current[column - 1] ?? 0) + 1);
      if (row > 1 && column > 1 && a[row - 1] === b[column - 2] && a[row - 2] === b[column - 1]) {
        best = Math.min(best, (beforePrevious[column - 2] ?? 0) + 1);
      }
      current.push(best);
    }
    beforePrevious = previous;
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/**
 * The candidate a misspelling most likely meant, or null when none is close: at most two
 * edits, and fewer than half the typed name, so `sine` finds `sin` and `x` finds nothing.
 * Case is not an edit. The first of equally near candidates wins, so pass them sorted.
 */
export function nearestSpelling(typed: string, candidates: readonly string[]): string | null {
  let best: string | null = null;
  let bestDistance = 3;
  for (const candidate of candidates) {
    const distance = editDistance(typed.toLowerCase(), candidate.toLowerCase());
    if (distance < bestDistance && distance * 2 < typed.length) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/** The failing half of a parse or an evaluation. §T1641b: it carries its KIND. */
export interface ExpressionFailure {
  ok: false;
  kind: ExpressionFailureKind;
  reason: string;
  /** What to write instead, when the grammar or the reader can say. */
  suggestion?: string;
  /** The name the failure is about: the function, or the bare name, nothing supplies. */
  subject?: string;
}

export type ParseResult = { ok: true; ast: ExpressionAst } | (ExpressionFailure & { kind: "syntax" });
export type EvaluateResult = { ok: true; value: number } | ExpressionFailure;

/** Names an expression may read when evaluated against a frame (§I.frame). */
/**
 * T505: the two clock families, EXPORTED so the expression highlighter derives from the
 * evaluator rather than remembering names (§V150). The distinction is the one that has
 * bitten this project four times: `time`/`frame`/`delta` WRAP with the timeline once it
 * is bounded; the free-running names keep counting through a loop. A test pins both
 * lists against `scopeFromFrame`'s actual keys, in both directions.
 */
export const WRAPPING_CLOCK_NAMES = ["time", "delta", "frame"] as const;
export const FREE_RUNNING_CLOCK_NAMES = ["walltime", "walldelta", "abstime", "absframe"] as const;
/**
 * T1426b/T1435b: the RATES — not clocks (they do not advance), the terms that say what a
 * clock's step means: `fps`, the project's frame rate, and `subframes`, the offline
 * sub-frames accumulated into each output frame (1 live). With the two clock families they
 * are exactly the scope's frame keys.
 */
export const FRAME_RATE_NAMES = ["fps", "subframes"] as const;

/**
 * T1785b: the PROJECT TEMPO, the transport's beat clock (`FrameEvaluationInput.tempo`).
 * `bpm` is the tempo in effect; `beat` and `bar` COUNT (whole numbers since the downbeat,
 * four beats to the bar); `beatphase` and `barphase` RAMP 0..1 inside each; `beatpulse` is
 * the beats that landed in this frame (0, and 1 on the frame a beat lands); `tempolocked`
 * is 1 while the tempo source is delivering and 0 while the last tempo is held.
 */
export const TEMPO_NAMES = ["bpm", "beat", "beatphase", "beatpulse", "bar", "barphase", "tempolocked"] as const;

function tempoScope(frame: FrameEvaluationInput): Record<(typeof TEMPO_NAMES)[number], number> {
  const tempo = tempoOf(frame);
  const beat = Math.floor(tempo.beats);
  const bars = tempo.beats / BEATS_PER_BAR;
  return {
    bpm: tempo.bpm,
    beat,
    beatphase: tempo.beats - beat,
    beatpulse: tempo.pulse,
    bar: Math.floor(bars),
    barphase: bars - Math.floor(bars),
    tempolocked: tempo.locked ? 1 : 0,
  };
}

export function scopeFromFrame(
  frame: FrameEvaluationInput,
  nodeContext: ExpressionScope = {},
): ExpressionScope {
  return {
    // T1785b: BEFORE the node's own context, unlike the clocks below. These names arrived
    // after documents existed, and a node that hands `bpm` or `beat` to its expressions
    // (an Audio In wired into an Expression, a parameter key) keeps reading its own.
    ...tempoScope(frame),
    ...nodeContext,
    // T271/§V172 — `time` is TIMELINE time and `delta` is its step; `walltime` and
    // `walldelta` are the other clock. Never a mix: an expression reading `time` and a
    // simulation reading `delta` must be advancing at the same rate.
    time: frame.timeSeconds,
    delta: frame.deltaSeconds,
    frame: frame.frameIndex,
    walltime: wallSecondsOf(frame),
    walldelta: wallDeltaSecondsOf(frame),
    // T461 — the clocks that do NOT reset. `time` and `frame` wrap with the timeline once
    // it is bounded (T455); these keep counting, so a continuous rotation has something to
    // read that does not snap back at the out point. Still deterministic: a frame COUNT,
    // never the wall clock, so a graph reading `abstime` renders offline exactly as it
    // played (§V44).
    abstime: absTimeSecondsOf(frame),
    absframe: absFrameIndexOf(frame),
    // T1426b/T1435b: the rates. A transport that states none is a plain project at the
    // default rate with no accumulation, which is what `projectFps()` says of absent settings.
    fps: fpsOf(frame),
    subframes: subframesOf(frame),
  };
}

/** `at` and `end` are the token's span in the source: a refusal quotes the author's own text. */
type Token = (
  | { kind: "number"; value: number }
  | { kind: "identifier"; value: string }
  | { kind: "string"; value: string }
  | { kind: "dot" }
  | { kind: "comma" }
  | { kind: "op"; value: "+" | "-" | "*" | "/" | "%" | "^" | "==" | "!=" | "<" | "<=" | ">" | ">=" }
  | { kind: "paren"; value: "(" | ")" }
) & { at: number; end: number };

const OPERATORS = new Set(["+", "-", "*", "/", "%", "^"]);

const isIdentStart = (char: string): boolean =>
  (char >= "a" && char <= "z") || (char >= "A" && char <= "Z") || char === "_";
const isIdentPart = (char: string): boolean => isIdentStart(char) || (char >= "0" && char <= "9");

function tokenize(input: string): Token[] | string {
  const tokens: Token[] = [];
  let index = 0;

  while (index < input.length) {
    const char = input[index] as string;

    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      index += 1;
      continue;
    }

    if (char === "(" || char === ")") {
      tokens.push({ kind: "paren", value: char, at: index, end: index + 1 });
      index += 1;
      continue;
    }

    if (char === ",") {
      tokens.push({ kind: "comma", at: index, end: index + 1 });
      index += 1;
      continue;
    }

    /*
     * T628: comparisons. Two-character forms first, so `<=` never reads as `<` `=`.
     * A bare `=` or `!` is refused with the spelling the author meant — the reset
     * idiom this exists for is `frame % 120 == 0`, and "unexpected =" teaches nothing.
     */
    if (char === "=" || char === "!" || char === "<" || char === ">") {
      const two = input.slice(index, index + 2);
      if (two === "==" || two === "!=" || two === "<=" || two === ">=") {
        tokens.push({ kind: "op", value: two, at: index, end: index + 2 });
        index += 2;
        continue;
      }
      if (char === "<" || char === ">") {
        tokens.push({ kind: "op", value: char, at: index, end: index + 1 });
        index += 1;
        continue;
      }
      return char === "=" ? 'single "=" — comparison is written "=="' : 'single "!" — negation is written "!="';
    }

    if (OPERATORS.has(char)) {
      tokens.push({ kind: "op", value: char as "+" | "-" | "*" | "/" | "%" | "^", at: index, end: index + 1 });
      index += 1;
      continue;
    }

    if (isIdentStart(char)) {
      const start = index;
      while (index < input.length && isIdentPart(input[index] as string)) index += 1;
      tokens.push({ kind: "identifier", value: input.slice(start, index), at: start, end: index });
      continue;
    }

    // String literal — only op('name') references use these (§V127).
    if (char === "'" || char === '"') {
      const close = input.indexOf(char, index + 1);
      if (close < 0) return "unterminated string";
      tokens.push({ kind: "string", value: input.slice(index + 1, close), at: index, end: close + 1 });
      index = close + 1;
      continue;
    }

    // A dot NOT starting a number is member access: op('x').par.gain.
    if (char === "." && !/[0-9]/.test(input[index + 1] ?? "")) {
      tokens.push({ kind: "dot", at: index, end: index + 1 });
      index += 1;
      continue;
    }

    if ((char >= "0" && char <= "9") || char === ".") {
      const start = index;
      while (index < input.length) {
        const next = input[index] as string;
        const isDigit = next >= "0" && next <= "9";
        const isExponent =
          (next === "e" || next === "E") &&
          index > start &&
          /[0-9.]/.test(input[index - 1] as string);
        const isExponentSign =
          (next === "+" || next === "-") && (input[index - 1] === "e" || input[index - 1] === "E");
        if (!isDigit && next !== "." && !isExponent && !isExponentSign) break;
        index += 1;
      }
      const text = input.slice(start, index);
      const value = Number(text);
      if (!Number.isFinite(value)) return `"${text}" is not a number`;
      tokens.push({ kind: "number", value, at: start, end: index });
      continue;
    }

    return `unexpected character "${char}"`;
  }

  return tokens;
}

interface Cursor {
  tokens: Token[];
  index: number;
  /** The text the tokens were cut from, for a refusal that quotes it. */
  source: string;
}

const peek = (cursor: Cursor): Token | undefined => cursor.tokens[cursor.index];

/**
 * Thrown internally only; the public functions convert it into a rejection.
 *
 * ⚠ NOT an `Error` subclass, and that is the whole point (T1176). Every failure here is
 * ORDINARY CONTROL FLOW on the app's hottest path, not an exception: §V108 says an
 * expression that cannot resolve falls back to its retained static, so a document is
 * *expected* to produce one of these per unresolvable expression per compile. The
 * frameless STRUCTURAL compile — the one a knob turn runs, sixty times a second — has no
 * `time` and no `frame` in scope, so every clock-reading expression in the document fails
 * by design on every commit.
 *
 * Constructing an `Error` captures a stack trace, and capturing one per expression per
 * compile cost 21.2% OF E55'S ENTIRE COMPILE — measured without editing anything, by
 * flipping `Error.stackTraceLimit` between 10 and 0 in alternating rounds of the same
 * process (E13 1.4%, E33 12.3%, E55 21.2%: the effect scales with how many expressions
 * the document holds, which is what makes it the stack and not the block's noise), and
 * the `stackTraceLimit` lever buys 0% once this class stops extending `Error` — which is
 * how the fix is known to be the same fix. Nothing ever reads the stack:
 * both catch sites below convert this into `{ ok: false, reason }` immediately, and it
 * cannot escape the module — `fail` is called only from the parser and the evaluator, and
 * both of their entry points catch it.
 */
class ParseFailure {
  readonly kind: ExpressionFailureKind;
  readonly message: string;
  readonly suggestion: string | undefined;
  readonly subject: string | undefined;
  constructor(kind: ExpressionFailureKind, message: string, suggestion: string | undefined, subject: string | undefined) {
    this.kind = kind;
    this.message = message;
    this.suggestion = suggestion;
    this.subject = subject;
  }
}

/** §T1641b: every failure names its kind at the site that knows it. */
function fail(
  kind: ExpressionFailureKind,
  reason: string,
  about: { suggestion?: string | undefined; subject?: string | undefined } = {},
): never {
  throw new ParseFailure(kind, reason, about.suggestion, about.subject);
}

function failureOf(thrown: ParseFailure): ExpressionFailure {
  return {
    ok: false,
    kind: thrown.kind,
    reason: thrown.message,
    ...(thrown.suggestion === undefined ? {} : { suggestion: thrown.suggestion }),
    ...(thrown.subject === undefined ? {} : { subject: thrown.subject }),
  };
}

const COMPARISONS = new Set(["==", "!=", "<", "<=", ">", ">="]);

/**
 * T628: comparisons, one precedence level BELOW additive — `frame % 120 == 0` parses
 * as `(frame % 120) == 0` with no parentheses, which is the pulse idiom this grammar
 * existed without. The result is 1 or 0 (the evaluator's contract is finite numbers;
 * there is no boolean type), so comparisons compose with arithmetic: `(t > 2) * gain`.
 * Left-associative like everything here; `a < b < c` therefore means `(a < b) < c` —
 * write the conjunction as a product instead: `(a < b) * (b < c)`.
 */
function parseComparison(cursor: Cursor): ExpressionAst {
  let left = parseAdditive(cursor);
  for (;;) {
    const token = peek(cursor);
    if (token === undefined || token.kind !== "op" || !COMPARISONS.has(token.value)) break;
    cursor.index += 1;
    left = { kind: "binary", operator: token.value, left, right: parseAdditive(cursor) };
  }
  return left;
}

function parseAdditive(cursor: Cursor): ExpressionAst {
  let left = parseMultiplicative(cursor);
  for (;;) {
    const token = peek(cursor);
    if (token === undefined || token.kind !== "op") break;
    if (token.value !== "+" && token.value !== "-") break;
    cursor.index += 1;
    left = { kind: "binary", operator: token.value, left, right: parseMultiplicative(cursor) };
  }
  return left;
}

function parseMultiplicative(cursor: Cursor): ExpressionAst {
  let left = parseUnary(cursor);
  for (;;) {
    const token = peek(cursor);
    if (token === undefined || token.kind !== "op") break;
    if (token.value !== "*" && token.value !== "/" && token.value !== "%") break;
    cursor.index += 1;
    left = { kind: "binary", operator: token.value, left, right: parseUnary(cursor) };
  }
  return left;
}

function parseUnary(cursor: Cursor): ExpressionAst {
  const token = peek(cursor);
  if (token !== undefined && token.kind === "op" && (token.value === "-" || token.value === "+")) {
    cursor.index += 1;
    return { kind: "unary", operator: token.value, operand: parseUnary(cursor) };
  }
  return parsePower(cursor);
}

function parsePower(cursor: Cursor): ExpressionAst {
  const base = parsePrimary(cursor);
  const token = peek(cursor);
  if (token !== undefined && token.kind === "op" && token.value === "^") {
    cursor.index += 1;
    // Right-associative, and the exponent may itself be signed: 2^-2.
    return { kind: "binary", operator: "^", left: base, right: parseUnary(cursor) };
  }
  return base;
}

function parsePrimary(cursor: Cursor): ExpressionAst {
  const token = peek(cursor);
  if (token === undefined) fail("syntax", "expression ended early");
  if (token.kind === "number") {
    cursor.index += 1;
    return { kind: "number", value: token.value };
  }
  if (token.kind === "identifier") {
    cursor.index += 1;
    const next = peek(cursor);
    if (next !== undefined && next.kind === "paren" && next.value === "(") {
      if (token.value === "op") return parseOpReference(cursor);
      if (token.value === PARENT_FUNCTION) return parseParentReference(cursor, token.at);
      return parseCall(cursor, token.value);
    }
    return { kind: "variable", name: token.value };
  }
  if (token.kind === "paren" && token.value === "(") {
    cursor.index += 1;
    const inner = parseComparison(cursor);
    const closing = peek(cursor);
    if (closing === undefined || closing.kind !== "paren" || closing.value !== ")") {
      fail("syntax", "missing closing parenthesis");
    }
    cursor.index += 1;
    return inner;
  }
  fail("syntax", `unexpected "${describeToken(token)}"`);
}

const describeToken = (token: Token): string =>
  token.kind === "dot"
    ? "."
    : token.kind === "comma"
      ? ","
      : token.kind === "string"
        ? `'${token.value}'`
        : String(token.value);

/** One argument of a call the grammar refused, as the author wrote it. */
interface WrittenArgument {
  /** Verbatim. */
  readonly text: string;
  /** Ready to stand as an operand: parenthesised unless it is one term. */
  readonly operand: string;
}

/** One term: a number, a name, a parenthesised group, a call, or an `op()` reference. */
function isOneTerm(tokens: readonly Token[]): boolean {
  if (tokens.length === 1) return true;
  const [first, second] = tokens;
  const opens = (token: Token | undefined): boolean => token?.kind === "paren" && token.value === "(";
  const open = opens(first) ? 0 : first?.kind === "identifier" && opens(second) ? 1 : -1;
  if (open < 0) return false;
  let depth = 0;
  let close = -1;
  for (let index = open; index < tokens.length && close < 0; index += 1) {
    const token = tokens[index];
    if (token?.kind !== "paren") continue;
    depth += token.value === "(" ? 1 : -1;
    if (depth === 0) close = index;
  }
  if (close < 0) return false;
  // What may follow the closing parenthesis and still be one term: `.par.gain`.
  for (let index = close + 1; index < tokens.length; index += 2) {
    if (tokens[index]?.kind !== "dot" || tokens[index + 1]?.kind !== "identifier") return false;
  }
  return true;
}

/**
 * The arguments of the call the cursor stands on (at its opening paren), cut from the
 * source by commas and parentheses alone, with nothing parsed: the call is being refused,
 * and its arguments may hold what is refused next. Null when they cannot be told apart.
 */
function callArguments(cursor: Cursor): readonly WrittenArgument[] | null {
  const groups: Token[][] = [[]];
  let depth = 0;
  for (let index = cursor.index; index < cursor.tokens.length; index += 1) {
    const token = cursor.tokens[index] as Token;
    if (token.kind === "paren") {
      depth += token.value === "(" ? 1 : -1;
      if (depth === 0) {
        if (groups.length === 1 && groups[0]?.length === 0) return [];
        const written: WrittenArgument[] = [];
        for (const group of groups) {
          const [first, last] = [group[0], group[group.length - 1]];
          if (first === undefined || last === undefined) return null;
          const text = cursor.source.slice(first.at, last.end);
          written.push({ text, operand: isOneTerm(group) ? text : `(${text})` });
        }
        return written;
      }
      if (depth === 1 && token.value === "(") continue;
    }
    if (depth === 1 && token.kind === "comma") groups.push([]);
    else groups[groups.length - 1]?.push(token);
  }
  return null;
}

/**
 * §T1641b — what to write instead of a call to a function the grammar does not have: the
 * rewrite in the author's own operands when the grammar has one on record and the
 * arguments fit it, its general form when they do not, the reason a name is left out, or
 * the function a misspelling most likely meant.
 */
function unknownFunctionRemedy(name: string, written: readonly WrittenArgument[] | null): string | undefined {
  const rewrite = Object.hasOwn(REWRITES, name) ? REWRITES[name] : undefined;
  if (rewrite !== undefined && typeof rewrite !== "string" && written?.length === rewrite.params.length) {
    return `Write ${rewrite.write(written.map((argument) => argument.operand), written.map((argument) => argument.text))}.`;
  }
  const general = rewriteOf(name);
  if (general !== null) return general;
  const near = nearestSpelling(name, functionNames());
  return near === null ? undefined : `Nearest: ${functionSignature(near) ?? near}.`;
}

/**
 * A whitelisted call — the cursor stands ON the opening paren (T370).
 *
 * Both refusals here NAME the problem and what would fix it (§V288). An unknown name
 * lists the whole whitelist rather than saying "not available": `sin(time)` is the first
 * thing anyone types into an expression field, and a user who types `smoothstep` deserves
 * to learn where the boundary is from the tool rather than from trial and error. Arity is
 * checked HERE, once per parse, so the per-frame evaluation never re-validates it.
 */
function parseCall(cursor: Cursor, name: string): ExpressionAst {
  const spec = Object.hasOwn(FUNCTIONS, name) ? FUNCTIONS[name] : undefined;
  if (spec === undefined) {
    fail("syntax", `unknown function "${name}" (available: ${functionNames().join(", ")})`, {
      subject: name,
      suggestion: unknownFunctionRemedy(name, callArguments(cursor)),
    });
  }
  cursor.index += 1; // consume "("
  const args: ExpressionAst[] = [];
  const empty = peek(cursor);
  if (empty !== undefined && empty.kind === "paren" && empty.value === ")") {
    cursor.index += 1;
  } else {
    for (;;) {
      args.push(parseComparison(cursor));
      const next = peek(cursor);
      if (next !== undefined && next.kind === "comma") {
        cursor.index += 1;
        continue;
      }
      if (next !== undefined && next.kind === "paren" && next.value === ")") {
        cursor.index += 1;
        break;
      }
      fail("syntax", `missing closing parenthesis in ${functionSignature(name) ?? name}`);
    }
  }
  if (args.length !== spec.params.length) {
    fail(
      "syntax",
      `${name}() takes ${spec.params.length} argument${spec.params.length === 1 ? "" : "s"}` +
        `, got ${args.length}: ${functionSignature(name) ?? name}`,
    );
  }
  return { kind: "call", name, args };
}

/**
 * `op('name').par.gain` — the cursor stands ON the opening paren (§V127, T221).
 * Recognised so references can be STORED (and rename-rewritten, §V128) before the
 * cross-node read path exists; `evaluateAst` names the gap until then.
 */
function parseOpReference(cursor: Cursor): ExpressionAst {
  cursor.index += 1; // consume "("
  const name = peek(cursor);
  if (name === undefined || name.kind !== "string" || name.value.length === 0) {
    fail("syntax", "op() takes a quoted node name: op('noise1')");
  }
  cursor.index += 1;
  const closing = peek(cursor);
  if (closing === undefined || closing.kind !== "paren" || closing.value !== ")") {
    fail("syntax", "op() takes exactly one quoted node name");
  }
  cursor.index += 1;

  const path: string[] = [];
  for (;;) {
    const dot = peek(cursor);
    if (dot === undefined || dot.kind !== "dot") break;
    cursor.index += 1;
    const member = peek(cursor);
    if (member === undefined || member.kind !== "identifier") {
      fail("syntax", "expected a member name after \".\"");
    }
    cursor.index += 1;
    path.push(member.value);
  }
  if (path.length === 0) fail("syntax", "an op() reference must read something: op('noise1').par.gain");
  return { kind: "opRef", name: name.value, path };
}

/** VN36: the one name `parent(` is spelled with. A bare `parent` stays a variable name. */
export const PARENT_FUNCTION = "parent";

/**
 * `parent(n).par.key[.component]` — the cursor stands ON the opening paren (VN36, §V81).
 *
 * Stricter than `op()` on purpose. `op()` takes any member path and leaves the reader to
 * refuse one it cannot read, because the target's type decides what it has. A component's
 * page has parameters and nothing else (a component's channels are read through
 * `op('<instance>').chan`), so every other shape is known wrong while the author is still
 * typing, and is refused here with the form to write.
 */
function parseParentReference(cursor: Cursor, at: number): ExpressionAst {
  cursor.index += 1; // consume "("
  let hops = 1;
  const count = peek(cursor);
  if (count !== undefined && count.kind === "number") {
    if (!Number.isInteger(count.value) || count.value < 1) {
      fail("syntax", `parent() counts components outward from 1: parent(1) is the one this node is in, not parent(${count.value})`);
    }
    hops = count.value;
    cursor.index += 1;
  }
  const closing = peek(cursor);
  if (closing === undefined || closing.kind !== "paren" || closing.value !== ")") {
    fail("syntax", "parent() takes nothing, or how many components out as a whole number: parent(), parent(2)");
  }
  cursor.index += 1;

  const path: string[] = [];
  let end = closing.end;
  for (;;) {
    const dot = peek(cursor);
    if (dot === undefined || dot.kind !== "dot") break;
    cursor.index += 1;
    const member = peek(cursor);
    if (member === undefined || member.kind !== "identifier") fail("syntax", "expected a member name after \".\"");
    cursor.index += 1;
    path.push(member.value);
    end = member.end;
  }
  const shape = "parent().par.<parameter>, or one component of it, as parent().par.color.r";
  if (path[0] !== "par") {
    fail("syntax", path.length === 0 ? `parent() must read a parameter: ${shape}` : `parent() reads parameters only (.par), not .${path[0]}`, {
      suggestion: `Write ${shape}. A component's channels are read as op('<instance>').chan.<channel>.`,
    });
  }
  if (path.length < 2 || path.length > 3) fail("syntax", `name one parameter: ${shape}`);
  return { kind: "parentRef", hops, path, at, end };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════
 * THE PARSE MEMO (T1172) — KEYED BY THE SOURCE TEXT, SO IT CANNOT OUTLIVE AN EDIT
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * `evaluateAst` exists because "parse once, evaluate per frame" is the right shape, and
 * the docblock below it has said so since T202. Nothing on the per-frame path ever did
 * it: `resolveStored` calls `evaluateExpression`, which parses first, so every expression
 * in an animated document was re-tokenised and re-parsed sixty times a second — and
 * §T1172 measured PARSE AT 82% OF THE COST OF EVALUATING ONE. This is that docblock's
 * promise, kept where every caller gets it instead of at one call site that remembers to.
 *
 * ⚠ The key is the trimmed source text and nothing else. An expression's AST is a pure
 * function of the characters it was written with, so an edit is a different key and a hit
 * can only ever be the parse of the very text asked about — there is no invalidation to
 * forget. The FAILURE is cached too, and deliberately: a document holding a typo re-parses
 * it every frame exactly like a working one, and the reason string is as pure a function
 * of the input as the tree is.
 *
 * ⚠ THIS MAKES THE AST SHARED, AND IT IS ALREADY TREATED AS IMMUTABLE. `evaluateNode`
 * reads it; `parameter-dependencies.ts` walks it; `reference.ts`, `validate.ts`,
 * `expression-range.ts` and `parameter-mode.tsx` inspect it. Nothing writes to a node, and
 * nothing may start — a mutation would now reach every later reader of the same text.
 *
 * FIFO past a cap, for the same reason the reflection memo (T1172) is: the working set is
 * the distinct expressions in one document, and the only way past the cap is somebody
 * TYPING one, where every keystroke mints a new key and the oldest entry is the coldest.
 *
 * ⚠ THE CAP MUST SIT ABOVE A REAL DOCUMENT'S WORKING SET, OR FIFO DEFEATS THE CACHE
 * (T1767b). At 512 it did not: `projects/silk-medusa` holds 646 distinct expression
 * strings, so every frame evicted entries the same frame needed and each statement was
 * parsed again, sixty times a second — measured at about 1.8 ms a frame on that
 * document and about 4 ms on its audio variant (548 in the value graph alone). A cache
 * smaller than the set cycling through it hits nothing. 4096 entries is a few megabytes
 * of AST at most and is the cap; a document past it thrashes again, which is the row's
 * open half.
 */
const PARSE_CACHE_LIMIT = 4096;
const parsedBySource = new Map<string, ParseResult>();

export function parseExpression(input: string): ParseResult {
  const trimmed = input.trim();
  if (trimmed === "") return { ok: false, kind: "syntax", reason: "empty" };

  const hit = parsedBySource.get(trimmed);
  if (hit !== undefined) return hit;

  const read = parse(trimmed);
  const parsed: ParseResult = read.ok ? { ...read, ast: internAst(read.ast) } : read;
  parsedBySource.set(trimmed, parsed);
  if (parsedBySource.size > PARSE_CACHE_LIMIT) {
    const oldest = parsedBySource.keys().next();
    if (oldest.done !== true) parsedBySource.delete(oldest.value);
  }
  return parsed;
}

function parse(trimmed: string): ParseResult {
  const tokens = tokenize(trimmed);
  if (!Array.isArray(tokens)) return { ok: false, kind: "syntax", reason: tokens };
  if (tokens.length === 0) return { ok: false, kind: "syntax", reason: "empty" };

  const cursor: Cursor = { tokens, index: 0, source: trimmed };
  try {
    const ast = parseComparison(cursor);
    if (cursor.index !== tokens.length) {
      return { ok: false, kind: "syntax", reason: "trailing input after the expression" };
    }
    return { ok: true, ast };
  } catch (thrown) {
    // Whatever the parser refuses is syntax, whichever site said so.
    if (thrown instanceof ParseFailure) return { ...failureOf(thrown), kind: "syntax" };
    // A parser bug must degrade to "rejected", never to a crashed editor.
    return { ok: false, kind: "syntax", reason: "could not parse the expression" };
  }
}

/**
 * T1720b — ONE OBJECT PER STRUCTURE.
 *
 * Every subtree a parse produces is replaced by the canonical object for its structure, so
 * `sin(time * 3) * 10` written in fifty expressions is one tree, and a reader that remembers
 * subtrees (`SubtreeMemory`) evaluates it once a frame. sentinel-bot's expressions are 91 %
 * repeats by tree node (§T1684b). A key names a node's kind, its own fields and its
 * children's canonical ids, so two keys are equal only for equal structures; spans
 * (`parentRef.at`/`end`) are fields like any other. The tree is immutable already (see the
 * parse memo above), which is what makes sharing it legal. Past the cap the table starts
 * again: later parses then share less, never wrongly.
 */
const INTERN_LIMIT = 65_536;
let interned = new Map<string, ExpressionAst>();
const internIds = new WeakMap<ExpressionAst, number>();
let nextInternId = 0;

export function internAst(ast: ExpressionAst): ExpressionAst {
  let node: ExpressionAst;
  let key: string;
  switch (ast.kind) {
    case "number":
      node = ast;
      key = Object.is(ast.value, -0) ? "n-0" : `n${String(ast.value)}`;
      break;
    case "variable":
      node = ast;
      key = `v${ast.name}`;
      break;
    case "opRef":
      node = ast;
      key = `o${JSON.stringify([ast.name, ast.path])}`;
      break;
    case "parentRef":
      node = ast;
      key = `p${JSON.stringify([ast.hops, ast.path, ast.at, ast.end])}`;
      break;
    case "call": {
      const args = ast.args.map(internAst);
      node = { ...ast, args };
      key = `c${ast.name}(${args.map(idOf).join(",")})`;
      break;
    }
    case "unary": {
      const operand = internAst(ast.operand);
      node = { ...ast, operand };
      key = `u${ast.operator}${idOf(operand)}`;
      break;
    }
    case "binary": {
      const left = internAst(ast.left);
      const right = internAst(ast.right);
      node = { ...ast, left, right };
      key = `b${ast.operator}${idOf(left)},${idOf(right)}`;
      break;
    }
  }
  const known = interned.get(key);
  if (known !== undefined) return known;
  if (interned.size >= INTERN_LIMIT) interned = new Map();
  interned.set(key, node);
  internIds.set(node, nextInternId++);
  return node;
}

function idOf(ast: ExpressionAst): number {
  return internIds.get(ast) as number;
}

/** Parse-once, evaluate-per-frame: bound parameters keep the AST and call this each frame. */
export function evaluateAst(
  ast: ExpressionAst,
  scope: ExpressionScope = {},
  readNode?: NodeReferenceReader,
  /** T1793b: a caller with no reader may still remember subtrees, for as long as ITS scope holds still. */
  memory: SubtreeMemory | undefined = readNode?.subtrees,
): EvaluateResult {
  try {
    const value = evaluateNode(ast, scope, readNode, memory);
    if (!Number.isFinite(value)) return { ok: false, kind: "value", reason: "result is not a finite number" };
    return { ok: true, value };
  } catch (thrown) {
    if (thrown instanceof ParseFailure) return failureOf(thrown);
    return { ok: false, kind: "value", reason: "could not evaluate the expression" };
  }
}

function evaluateNode(
  ast: ExpressionAst,
  scope: ExpressionScope,
  readNode: NodeReferenceReader | undefined,
  memory: SubtreeMemory | undefined,
): number {
  // T1720b: a leaf costs less than the lookup; a failure throws past the store and is not kept.
  if (memory === undefined || ast.kind === "number" || ast.kind === "variable") return evaluateFresh(ast, scope, readNode, memory);
  const kept = memory.values.get(ast);
  if (kept !== undefined) return kept;
  const fired = memory.fired();
  const value = evaluateFresh(ast, scope, readNode, memory);
  if (memory.fired() === fired) memory.values.set(ast, value);
  return value;
}

function evaluateFresh(
  ast: ExpressionAst,
  scope: ExpressionScope,
  readNode: NodeReferenceReader | undefined,
  memory: SubtreeMemory | undefined,
): number {
  switch (ast.kind) {
    case "number":
      return ast.value;
    case "variable": {
      const value = Object.hasOwn(scope, ast.name) ? scope[ast.name] : undefined;
      if (value === undefined) {
        const known = Object.keys(scope).sort().join(", ");
        fail("name", known === "" ? `unknown name "${ast.name}"` : `unknown name "${ast.name}" (available: ${known})`, {
          subject: ast.name,
        });
      }
      // A name the scope HAS, holding no finite number: this frame's fault, not the text's.
      if (!Number.isFinite(value)) fail("value", `"${ast.name}" is not a finite number here`);
      return value;
    }
    case "opRef": {
      /**
       * T316 — the cross-node read, completing §V148's round trip.
       *
       * A caller with no reader is one that cannot resolve a graph: a bare
       * `evaluateExpression` in a test, the completion probe, a preview of an expression
       * typed into a field before it is attached to anything. That case keeps saying so
       * rather than inventing a value, because the alternative — resolving to 0 — is a
       * number that looks like an answer.
       */
      if (readNode === undefined) {
        fail("reference.noGraph", `node references need a graph to read (op('${ast.name}'))`);
      }
      const read = readNode(ast.name, ast.path);
      if (!read.ok) fail(`reference.${read.kind ?? "unreadable"}`, read.reason, { suggestion: read.suggestion });
      return read.value;
    }
    case "parentRef":
      // VN36: the flattener rewrites every one inside a component to an `op()` read of the
      // instance it names, so one that gets here is outside any. A number here would be one
      // that looks like an answer.
      return fail("reference.unreadable", `parent() reads a published parameter of the component a node is in, and this expression is not inside one`, {
        suggestion: "Use parent() in a node inside a component, or read the parameter with op('<name>').par.<key>.",
      });
    case "call": {
      const spec = FUNCTIONS[ast.name];
      // Unreachable through `parseExpression`, which refuses both cases. Reachable
      // through a hand-built AST, and a wrong-arity call must fail loud rather than read
      // a missing argument as zero.
      if (spec === undefined) fail("syntax", `unknown function "${ast.name}"`, { subject: ast.name });
      if (ast.args.length !== spec.params.length) {
        fail("syntax", `${ast.name}() takes ${spec.params.length} arguments, got ${ast.args.length}`);
      }
      return spec.apply(ast.args.map((arg) => evaluateNode(arg, scope, readNode, memory)));
    }
    case "unary": {
      const operand = evaluateNode(ast.operand, scope, readNode, memory);
      return ast.operator === "-" ? -operand : operand;
    }
    case "binary": {
      const left = evaluateNode(ast.left, scope, readNode, memory);
      const right = evaluateNode(ast.right, scope, readNode, memory);
      switch (ast.operator) {
        case "+":
          return left + right;
        case "-":
          return left - right;
        case "*":
          return left * right;
        case "%":
        case "/":
          if (right === 0) fail("value", "division by zero");
          return ast.operator === "/" ? left / right : left % right;
        case "^":
          return left ** right;
        // T628: 1/0, never a boolean — the contract is finite numbers, and 1/0 is
        // what lets a comparison drive an amount: `(frame % 120 == 0) * kick`.
        case "==":
          return left === right ? 1 : 0;
        case "!=":
          return left === right ? 0 : 1;
        case "<":
          return left < right ? 1 : 0;
        case "<=":
          return left <= right ? 1 : 0;
        case ">":
          return left > right ? 1 : 0;
        case ">=":
          return left >= right ? 1 : 0;
      }
    }
  }
}

/** One-shot convenience for text entry: parse and evaluate in a single call. */
export function evaluateExpression(
  input: string,
  scope: ExpressionScope = {},
  readNode?: NodeReferenceReader,
): EvaluateResult {
  const parsed = parseExpression(input);
  if (!parsed.ok) return parsed;
  return evaluateAst(parsed.ast, scope, readNode);
}
