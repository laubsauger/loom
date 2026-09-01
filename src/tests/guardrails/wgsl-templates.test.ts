import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * WGSL carried in a TypeScript template literal (T729, §V685).
 *
 * Two defects live here, they have broken this tree twice in one day through two
 * different workers, and the OWNER sees both because their dev server runs on this
 * checkout. They are opposites, and the quiet one is the dangerous one.
 *
 * ## The loud one: an unescaped backtick
 *
 * A backtick inside the WGSL — almost always in PROSE, a comment writing `vec2f(bool)`
 * with the markdown habit of quoting code — ends the template early. Everything after it
 * becomes TypeScript, and the error lands wherever that first fails to parse. Today's
 * instance reported `Expected ";" but found "vec2f"` and pointed at line 167 of a
 * COMMENT, which is three lines below the actual backtick and reads like a WGSL problem.
 * The reader looks in the wrong place, in a file they may not have written.
 *
 * ## The quiet one: `${` in a comment, which is the reason this file exists
 *
 * `${` inside a template does not error. It INTERPOLATES. Injecting constants that way is
 * legitimate and four shipped example shaders do exactly that — `${CINDER_SCOUTS}u` is how
 * a kernel and its TypeScript agree about a number. So this cannot ban `${`.
 *
 * What is never legitimate is a substitution inside a WGSL COMMENT. Nobody computes a
 * comment; a `${` there is prose that got evaluated. It compiles, it ships, and the kernel
 * is not the one on the screen — which is §V147's family with the evidence destroyed,
 * because the source and the shader that ran no longer say the same thing.
 *
 * The detector is exported and tested against KNOWN-BAD FIXTURES below, not only run over
 * the tree. A scan that passes because nothing is currently wrong cannot be told apart
 * from one that cannot fail (§V461).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../..");

export interface TemplateOffence {
  readonly kind: "unparseable" | "substitution-in-comment";
  readonly detail: string;
}

/** Is the offset inside a WGSL comment, given everything before it? */
function commentStateAt(before: string): "line" | "block" | "code" {
  const lastNewline = before.lastIndexOf("\n");
  const line = before.slice(lastNewline + 1);
  // Block comments win: a `//` inside an open block is not a second comment.
  const opens = (before.match(/\/\*/g) ?? []).length;
  const closes = (before.match(/\*\//g) ?? []).length;
  if (opens > closes) return "block";
  if (line.includes("//")) return "line";
  return "code";
}

/** WGSL, not just any template — a shader has functions and attributes. */
function looksLikeWgsl(text: string): boolean {
  return /\bfn\s+\w+\s*\(/.test(text) && /@(compute|fragment|vertex|group|builtin)/.test(text);
}

export function wgslTemplateOffences(source: string, fileName: string): TemplateOffence[] {
  const parsed = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  // `transpileModule` rather than the SourceFile's own `parseDiagnostics`: that property
  // is INTERNAL to TypeScript and absent from the public types, so reading it would work
  // today and break silently on an upgrade — a gate that stops gating is worse than none.
  // This route is public, and for an unterminated template the diagnostic is syntactic.
  const diagnostics =
    ts.transpileModule(source, {
      reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.Latest },
    }).diagnostics ?? [];
  if (diagnostics.length > 0) {
    const first = diagnostics[0];
    const at = first?.start ?? 0;
    const { line } = parsed.getLineAndCharacterOfPosition(Math.min(at, source.length));
    return [
      {
        kind: "unparseable",
        detail:
          `does not parse (first error at line ${line + 1}: ` +
          `${ts.flattenDiagnosticMessageText(first?.messageText, " ")}). ` +
          `In a file carrying WGSL the usual cause is an UNESCAPED BACKTICK in shader prose — ` +
          `a comment quoting code the markdown way — which ends the template early and makes ` +
          `the rest parse as TypeScript. The reported line is where parsing gave up, not where ` +
          `the backtick is: search the shader text for \` and escape it as \\\`.`,
      },
    ];
  }

  const offences: TemplateOffence[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isTemplateExpression(node) && looksLikeWgsl(node.getText())) {
      let before = node.head.text;
      for (const span of node.templateSpans) {
        const state = commentStateAt(before);
        if (state !== "code") {
          const { line } = parsed.getLineAndCharacterOfPosition(span.expression.getStart());
          offences.push({
            kind: "substitution-in-comment",
            detail:
              `line ${line + 1}: \${${span.expression.getText()}} sits inside a WGSL ` +
              `${state} comment. It INTERPOLATES rather than erroring, so the shader that runs is ` +
              `not the shader in the file. Move it into code, or write the text without \${.`,
          });
        }
        before += span.literal.text;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return offences;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.ts$/.test(entry)) out.push(full);
  }
  return out;
}

/** Where WGSL is authored as a TypeScript constant. */
const WGSL_HOMES = ["nodes/shaders", "examples"];

describe("§V685 — WGSL in a template literal (T729)", () => {
  const files = WGSL_HOMES.flatMap((home) => sourceFiles(resolve(SRC, home)));

  it("walks the files that actually carry shader text", () => {
    // §V461's other half: if this list ever empties, every assertion below passes for the
    // wrong reason and nobody notices.
    expect(files.length).toBeGreaterThan(10);
  });

  it("every file parses, so no unescaped backtick has ended a shader early", () => {
    const offenders = files
      .flatMap((file) =>
        wgslTemplateOffences(readFileSync(file, "utf8"), file)
          .filter((offence) => offence.kind === "unparseable")
          .map((offence) => `${relative(SRC, file)} ${offence.detail}`),
      );
    expect(offenders).toEqual([]);
  });

  it("no substitution hides inside a WGSL comment, where it would run without showing", () => {
    const offenders = files
      .flatMap((file) =>
        wgslTemplateOffences(readFileSync(file, "utf8"), file)
          .filter((offence) => offence.kind === "substitution-in-comment")
          .map((offence) => `${relative(SRC, file)} ${offence.detail}`),
      );
    expect(offenders).toEqual([]);
  });
});

describe("the detector can actually fail (§V461)", () => {
  /**
   * Built from the REAL defect, not an imagined one (§V566): this is today's
   * `transforms.wgsl.ts` breakage in miniature — a comment quoting `vec2f(bool)` the way
   * one writes markdown, three lines above where the parser gave up.
   */
  it("catches the backtick that broke the tree today", () => {
    const source = [
      "export const WGSL = `@compute @workgroup_size(1)",
      "fn main() {",
      "  /* `vec2f(bool)` is not a WGSL constructor — use vec2<bool>. */",
      "  let x = 1.0;",
      "}`;",
    ].join("\n");
    const offences = wgslTemplateOffences(source, "transforms.wgsl.ts");
    expect(offences.map((o) => o.kind)).toContain("unparseable");
    expect(offences[0]?.detail).toContain("UNESCAPED BACKTICK");
  });

  it("catches a substitution inside a line comment", () => {
    const source = [
      "const SIZE = 8;",
      "export const WGSL = `@compute @workgroup_size(1)",
      "fn main() {",
      "  // grid is ${SIZE} wide",
      "  let x = 1.0;",
      "}`;",
    ].join("\n");
    const offences = wgslTemplateOffences(source, "x.wgsl.ts");
    expect(offences.map((o) => o.kind)).toEqual(["substitution-in-comment"]);
    expect(offences[0]?.detail).toContain("line comment");
  });

  it("catches a substitution inside a block comment", () => {
    const source = [
      "const SIZE = 8;",
      "export const WGSL = `@compute @workgroup_size(1)",
      "fn main() {",
      "  /* the grid is",
      "     ${SIZE} wide */",
      "  let x = 1.0;",
      "}`;",
    ].join("\n");
    const offences = wgslTemplateOffences(source, "x.wgsl.ts");
    expect(offences.map((o) => o.kind)).toEqual(["substitution-in-comment"]);
    expect(offences[0]?.detail).toContain("block comment");
  });

  it("LEAVES ALONE the legitimate constant injection four shaders depend on", () => {
    // `${CINDER_SCOUTS}u` is how a kernel and its TypeScript agree about a number. A gate
    // that banned `${` outright would redden four shipped examples and teach everyone to
    // disable it.
    const source = [
      "const SCOUTS = 8;",
      "export const WGSL = `@compute @workgroup_size(1)",
      "const SCOUTS: u32 = ${SCOUTS}u;",
      "fn main() { let x = 1.0; }`;",
    ].join("\n");
    expect(wgslTemplateOffences(source, "cinder.wgsl.ts")).toEqual([]);
  });

  it("ignores templates that are not shaders, even where a `//` precedes a substitution", () => {
    // The fixture must be able to trip the comment rule, or it proves nothing about WGSL
    // detection: the first version used SQL `--` comments, so it passed whether or not the
    // shader check existed. Generated JS is the honest case — a `//` comment before an
    // interpolation there is ordinary and must not be flagged.
    const source = [
      "const version = 3;",
      "export const banner = `function boot() {",
      "  // built from revision ${version}",
      "  return 1;",
      "}`;",
    ].join("\n");
    expect(wgslTemplateOffences(source, "not-a-shader.ts")).toEqual([]);
  });

  it("does not flag a `//` that is inside a WGSL string rather than a comment", () => {
    // A URL or a divide is not a comment. Over-flagging here would be the same disease as
    // under-flagging: a gate people learn to work around.
    const source = [
      "const K = 2.0;",
      "export const WGSL = `@compute @workgroup_size(1)",
      "fn main() { let x = 1.0 / ${K}; }`;",
    ].join("\n");
    expect(wgslTemplateOffences(source, "x.wgsl.ts")).toEqual([]);
  });
});
