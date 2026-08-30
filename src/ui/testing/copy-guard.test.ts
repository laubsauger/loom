import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Guards §V90/§V91/§V92 so inline prose cannot creep back into chrome one track at a
 * time — exactly how it arrived (T178). No single change here was ever the problem;
 * the accumulation was.
 *
 * Scope is `.tsx` components under this track's owned surfaces (`src/ui`, `src/editor`
 * minus the live `src/editor/inspector`, `src/app`) — where CHROME renders. Diagnostic
 * and audit *content* is legitimately long and lives in `.ts` logic (`RuntimeDiagnostic`
 * messages, command descriptions); scanning render output rather than every string in
 * the codebase is what keeps that content out of this guard's way without an allowlist
 * entry for each one.
 *
 * A string is flagged as "sentence-shaped" — a decorative-prose smell, not a hard rule
 * about English grammar — when it contains a full sentence break (". ") or exceeds 60
 * characters. `NoSubstitutionTemplateLiteral`s are checked the same way; any literal
 * with a `${}` substitution is skipped, because its rendered length cannot be judged
 * statically and once a value is interpolated the string is usually a label plus data
 * (§V90 explicitly keeps values, units, counts).
 *
 * The allowlist is the one place this rule bends, and it is deliberately short: each
 * entry is a real, named exception (a diagnostic embedded directly in a component
 * rather than routed through `RuntimeDiagnostic`, mostly), so adding one is a visible
 * decision a reviewer can see and question — not a way to quietly launder new prose
 * past the guard.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../../../");
const SURFACE_DIRS = ["src/ui", "src/editor", "src/app"];
const EXCLUDE_DIR_SEGMENTS = new Set(["inspector", "testing"]);
const SENTENCE_LEN = 60;

/**
 * Explicit, short, visible-on-diff. Each entry names the file (repo-relative) and the
 * exact string it excuses — genuinely long content (a device-capability warning, an
 * autosave failure explanation) that is the PANE'S DATA, not decorative chrome, and
 * that nobody has yet routed through a `RuntimeDiagnostic`/notice object instead of an
 * inline literal.
 */
const ALLOWLIST: ReadonlyArray<{ file: string; text: string }> = [
  {
    file: "src/app/dock-panes.tsx",
    text: "The graph, the inspector and the shader editor still work — the document is the source of truth and does not need a device. Rendering and compile validation stay off until one is available.",
  },
  {
    file: "src/app/dock-panes.tsx",
    text: "This device is below the Tier B baseline (rgba16float, compute, storage buffers). Expect missing features rather than a working render.",
  },
  {
    file: "src/app/dock-panes.tsx",
    text: "Select a node with a WGSL source parameter — Custom WGSL — to edit its shader.",
  },
  {
    file: "src/app/dock-panes.tsx",
    text: "WGSL is checked when the graph compiles on a device; there is no standalone shader compile yet.",
  },
  {
    file: "src/editor/component/component-inspector.tsx",
    text: "This component is not installed. Its values are preserved and will work again once the package that defines it is available.",
  },
  {
    file: "src/editor/component/component-inspector.tsx",
    text: "is available. This instance stays on v",
  },
  {
    file: "src/editor/inspect/node-info-popup.tsx",
    text: "feature, so per-pass GPU spans cannot be measured. No timing is estimated in its place.",
  },
  {
    file: "src/editor/inspect/node-info-popup.tsx",
    text: "This node materializes no texture in the current plan, so it has no resolution, format or memory of its own.",
  },
  {
    file: "src/editor/inspect/performance-panel.tsx",
    text: "feature, so per-pass GPU spans are unavailable. Nothing is estimated in their place — a CPU-side figure would be a different measurement wearing the same label.",
  },
  {
    file: "src/editor/inspect/performance-panel.tsx",
    text: "compiler/memory-budget — the plan&apos;s estimated texture memory exceeds the project budget. Lower a node&apos;s resolution, or raise the budget in project settings.",
  },
  {
    file: "src/editor/menus/context-menu-host.tsx",
    text: "This command is not available yet — no track has registered it.",
  },
  {
    file: "src/app/app-shell.tsx",
    text: "Drag a divider to resize, double-click it to reset. A focused divider resizes with the arrow keys and collapses with Enter.",
  },
  {
    file: "src/app/app.tsx",
    text: "Editing still works. Open this in Chrome or Edge 128+ on a machine with WebGPU to render.",
  },
  {
    file: "src/app/app.tsx",
    text: "The device was lost and the automatic rebuilds gave up. Your document is untouched.",
  },
  {
    file: "src/app/app.tsx",
    text: "Save to a file to keep your work — nothing is being snapshotted in the background.",
  },
  {
    file: "src/app/app.tsx",
    text: "They are kept exactly as saved and shown read-only rather than edited blind.",
  },
  {
    file: "src/app/side-panes.tsx",
    text: "kept exactly as saved and written back unchanged, so nothing is lost — but this build cannot show a control over",
  },
  {
    file: "src/app/top-bar.tsx",
    text: "Detected WebGPU capability tier. Baseline is B.",
  },
  {
    // T399. The Agents tab's one long line, and it is a CONSENT statement, not chrome:
    // the snippet below it hands an external process write access to the open document,
    // so what that process may do is spelled out at the point of the decision. A tooltip
    // is the wrong home for the sentence a user is agreeing to. Everything else on that
    // tab was cut to a label; this is the piece that may not be.
    file: "src/editor/help/mcp-setup.tsx",
    text: "An external MCP client starts this server as a subprocess and gets the same tools the in-app agent has: read the graph, add and rewire nodes, edit parameters and shader source, compile, and undo.",
  },
];

function isSentenceShaped(text: string): boolean {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length === 0) return false;
  if (trimmed.includes(". ")) return true;
  return trimmed.length > SENTENCE_LEN;
}

function listTsxFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (EXCLUDE_DIR_SEGMENTS.has(entry)) continue;
      listTsxFiles(full, out);
    } else if (entry.endsWith(".tsx") && !entry.endsWith(".test.tsx")) {
      out.push(full);
    }
  }
}

interface Finding {
  file: string;
  line: number;
  text: string;
}

function findSentenceShapedStrings(absPath: string, repoRelative: string): Finding[] {
  const source = readFileSync(absPath, "utf8");
  const sourceFile = ts.createSourceFile(absPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: Finding[] = [];

  function visit(node: ts.Node): void {
    // A thrown/constructed Error's message is a developer-facing contract violation
    // (e.g. "useAppRuntime must be used inside the app composition root."), never
    // something an end user sees in normal operation — out of scope for chrome copy.
    const parent = node.parent as ts.Node | undefined;
    const parentIsErrorConstruction =
      parent !== undefined &&
      (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
      ts.isIdentifier(parent.expression) &&
      /Error$/.test(parent.expression.text);

    if (ts.isStringLiteralLike(node) && !parentIsErrorConstruction) {
      const text = node.text;
      if (isSentenceShaped(text)) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        found.push({ file: repoRelative, line: line + 1, text });
      }
    } else if (ts.isJsxText(node)) {
      const text = node.text;
      if (isSentenceShaped(text)) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        found.push({ file: repoRelative, line: line + 1, text: text.replace(/\s+/g, " ").trim() });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return found;
}

describe("§V90/§V91/§V92 — inline prose does not creep back into chrome (T178)", () => {
  it("finds no sentence-shaped string literal in an owned .tsx file outside the allowlist", () => {
    const files: string[] = [];
    for (const dir of SURFACE_DIRS) listTsxFiles(join(ROOT, dir), files);
    expect(files.length).toBeGreaterThan(20); // sanity: the walk actually found the tree

    const allFindings: Finding[] = [];
    for (const absPath of files) {
      const repoRelative = relative(ROOT, absPath).split("\\").join("/");
      allFindings.push(...findSentenceShapedStrings(absPath, repoRelative));
    }

    const unexpected = allFindings.filter(
      (finding) =>
        !ALLOWLIST.some((entry) => entry.file === finding.file && entry.text === finding.text),
    );

    if (unexpected.length > 0) {
      const report = unexpected
        .map((f) => `  ${f.file}:${f.line}  ${JSON.stringify(f.text)}`)
        .join("\n");
      throw new Error(
        `${unexpected.length} sentence-shaped string(s) found in chrome, outside the allowlist ` +
          `(§V90/§V91/§V92). Move genuine explanation to a tooltip/\`?\` handle, or if this is ` +
          `truly pane content (a diagnostic, not decorative prose), add it to ALLOWLIST as a ` +
          `visible decision:\n${report}`,
      );
    }

    // The allowlist itself must not silently rot into dead entries — that would hide a
    // future removal instead of forcing the next person to look at the list.
    for (const entry of ALLOWLIST) {
      const stillPresent = allFindings.some(
        (finding) => finding.file === entry.file && finding.text === entry.text,
      );
      expect(stillPresent, `stale allowlist entry, no longer found: ${entry.file} ${entry.text}`).toBe(
        true,
      );
    }
  });
});
