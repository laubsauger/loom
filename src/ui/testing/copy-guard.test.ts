import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { buildNotices } from "../../app/use-model-inference.ts";
import { effectiveParameterSchema } from "../../domain/parameters/resolve.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { DEFAULT_BINDINGS } from "../../editor/keymap/defaults.ts";

describe("T424 — product metadata describes Loom without prior-product comparisons", () => {
  it("checks rendered catalogue and shortcut text, not implementation comments or shader source", () => {
    const findings: string[] = [];
    let inspected = 0;
    const visit = (value: unknown, path: string) => {
      if (value === null || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        if (["title", "label", "description"].includes(key) && typeof child === "string") {
          inspected++;
          if (/\b(?:TD|TouchDesigner)\b/i.test(child)) findings.push(`${path}.${key}: ${child}`);
        } else visit(child, `${path}.${key}`);
      }
    };
    visit(allNodeDefinitions, "nodes");
    visit(DEFAULT_BINDINGS, "shortcuts");
    expect(inspected).toBeGreaterThan(100);
    expect(findings).toEqual([]);
  });
});

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
  /**
   * T461 — the HELP PANEL is where an explanation belongs, and this one cannot be a
   * tooltip.
   *
   * §V90's rule is that help is on demand, carried by the label. These two sentences are
   * IN the on-demand surface: the expression help is opened deliberately, and this is the
   * moment an author picks between `time` and `abstime`. Picking wrong is silent —
   * `time * 90` is correct for one lap of a bounded timeline and snaps back at every out
   * point after that — so a chip showing a number cannot carry it and neither can a
   * tooltip on a name the author has not hovered.
   */
  {
    file: "src/editor/help/expression-help.tsx",
    text: "follow the timeline and restart at the in point when it loops.",
  },
  {
    file: "src/editor/help/expression-help.tsx",
    text: "keep counting, so use them for anything that must not snap back.",
  },
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
    // T492: the pane serves every code-KIND parameter now, and its empty state says so.
    text: "Select a node with a code parameter — a Custom WGSL shader, a point kernel, a spawn hook, an attribute schema.",
  },
  {
    file: "src/app/dock-panes.tsx",
    text: "WGSL is checked when the graph compiles on a device; there is no standalone shader compile yet.",
  },
  {
    file: "src/app/dock-panes.tsx",
    // T492: the JSON subjects' twin of the sentence above — a diagnostic fact, not decor.
    text: "JSON is checked when the graph compiles; a schema that does not parse refuses by name.",
  },
  {
    file: "src/app/dock-panes.tsx",
    // T505: the expression subjects' member of the same trio.
    text: "Expressions are checked as you commit; an unparseable one refuses with its reason.",
  },
  {
    file: "src/editor/inspect/node-info-popup.tsx",
    text: "This node materializes no texture in the current plan, so it has no resolution, format or memory of its own.",
  },
  {
    file: "src/editor/inspect/node-info-popup.tsx",
    // T645/§V329: a DIAGNOSTIC fact about this node — a take over it will not reproduce —
    // stated where someone asks "is what I am looking at current?", with the route to
    // making it reproduce named rather than merely withheld (§V403). Same class as the
    // `timestamp-query` note above: not decoration, and not repeatable as a tooltip
    // because the reader needs it at the moment they read the node's other facts.
    text: "This node reads a live device, so what it captures depends on when a frame ran. A take will not reproduce; record the input to a file and play that back locked to the timeline.",
  },
  {
    file: "src/editor/inspect/performance-panel.tsx",
    text: "compiler/memory-budget — the plan&apos;s estimated texture memory exceeds the project budget. Lower a node&apos;s resolution, or raise the budget in project settings.",
  },
  {
    file: "src/editor/menus/context-menu-host.tsx",
    text: "This command is not available yet — no track has registered it.",
  },
  /**
   * B79 — pane CONTENT, and the most load-bearing sentence in the app.
   *
   * §V90 sends explanation to a tooltip carried by a label. There is no label here and no
   * hover to give: the pane this replaces has just stopped, and the reader's actual first
   * question is not "what broke" but "did I just lose my graph". Before this existed the
   * answer was a white screen, and a user with no answer reloads the tab — which is the one
   * action that DOES lose it. So this is a diagnostic, in the surface, at the moment it is
   * needed, and it cannot be moved anywhere on demand.
   */
  {
    file: "src/ui/primitives/error-boundary.tsx",
    text: "The rest of the app is still running and your graph has not been changed.",
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
  /**
   * T1121/B179 — the two halves of the notice that says the picture is not the edit.
   *
   * Same class as the GPU-halt and autosave entries above it: a NOTICE OBJECT's own
   * message and detail, which is the strip's data rather than decoration around it. It
   * cannot be a tooltip or a `?` handle — nothing on screen looks wrong while it is
   * true, so there is no label for the reader to hover and no reason for them to
   * suspect there is anything to ask about. That silence is exactly the bug (§B179).
   */
  {
    file: "src/app/app.tsx",
    text: "Output stale — this document has errors, so the last version that compiled is still rendering.",
  },
  {
    file: "src/app/app.tsx",
    text: "What you see is not your latest edit. Fix the errors in Problems and it catches up.",
  },
  /**
   * T1278 — the two ways a shareable example link can fail, said to the person who was
   * SENT it.
   *
   * Same class as every notice-object entry above: the strip's own data, not decoration
   * around it. And the least tooltip-able copy in the app — the reader did not choose this
   * app's state, has no label on screen to hover, and by construction nothing looks wrong,
   * because the alternative to saying it is handing them a plausible document (the
   * starter) with no reason to doubt it. Both lines open by naming what did NOT happen,
   * because "nothing was opened" is the fact the recipient has to act on: they go back to
   * the sender rather than discussing the wrong graph.
   */
  {
    file: "src/app/app.tsx",
    text: "Nothing was opened. The Examples pane lists what ships here.",
  },
  {
    file: "src/app/app.tsx",
    text: "Nothing was opened. This is a broken build rather than a broken link.",
  },
  {
    file: "src/app/side-panes.tsx",
    text: "kept exactly as saved and written back unchanged, so nothing is lost — but this build cannot show a control over",
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
  {
    // T1110/T1111. The second long line on the same tab, and it is there because THIS TAB
    // is where the owner's wrong inference was formed: the only place in the app naming the
    // helper's command named it as an agent thing, and he read "Person Mask needs
    // `pnpm mcp:serve`" as "Person Mask needs an agent protocol". Correcting that needs the
    // sentence, not a label — a tooltip would hide the correction behind the misreading it
    // is correcting. It sits under the snippet, where a reader has already been told what
    // the agent door is for, and it is the last thing the tab says.
    file: "src/editor/help/mcp-setup.tsx",
    text: "That one process is also Loom&rsquo;s device helper: OSC, a laser DAC and Person Mask reach hardware through it, with the same pairing code, and need no agent and no MCP client. For devices alone, with no MCP server:",
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

/**
 * ═══════════════════════════════════════════════════════════════════════════════════
 * §V852 — A BANNER IS ONE SENTENCE, AND THAT IS A BUDGET, NOT A STYLE NOTE
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * The owner, on the model notices: "again we have this huge amount of text and prose and
 * blah blah blah for the banners… No one is gonna read half a fucking book when they want
 * to see what's going on. Make that a rule."
 *
 * The guard above scans `.tsx` chrome and deliberately exempts `.ts` logic, because
 * diagnostic CONTENT is legitimately long. A notice is the exception to that exception: it
 * is content by construction and chrome by placement, and it is the one surface that
 * appears unbidden across the top of the app. Every clause in the banner it replaced had
 * been added for a real reason — name the picture (B156), point at the rate (§T754),
 * promote the reason (§T965) — and each defended itself in isolation. The LENGTH was
 * emergent, which is why only a ceiling stops it: reviewing clause by clause asking "is
 * this true?" always answers yes.
 *
 * So this is a BEHAVIOURAL gate rather than a source scan: it builds every notice the model
 * seam can produce and measures what a person would actually read. A new state cannot dodge
 * it by living in a file the walk above does not visit.
 */
describe("§V852 — model notices fit in one sentence", () => {
  /** One short sentence. Longer than a scannable line, and nobody reads it. */
  const MESSAGE_BUDGET = 90;
  /** A `detail` is a fragment of DATA (a size, a reason), never a second paragraph. */
  const DETAIL_BUDGET = 80;

  const targets = [
    {
      nodeId: "depth1",
      channel: "depth1",
      kind: { nodeType: "depth", label: "Depth", neutralPicture: "flat grey" },
      descriptor: { id: "d", label: "Depth Anything V2", bytes: 99_060_839 },
      size: [8, 8],
    },
    {
      nodeId: "cut1",
      channel: "cut1",
      kind: {
        nodeType: "matte",
        label: "Matte",
        neutralPicture: "zero everywhere",
        coverage: () => 0,
      },
      descriptor: { id: "m", label: "MODNet quantized", bytes: 6_612_345 },
      size: [8, 8],
    },
  ];
  const acquisition = { acquire: () => undefined, cancel: () => {} };

  /** Every state the seam can be in, so the budget covers the whole surface. */
  const cases: ReadonlyArray<[string, unknown, unknown]> = [
    ["no model", { d: { kind: "absent" }, m: { kind: "absent" } }, {}],
    [
      "downloading",
      { d: { kind: "downloading", received: 1_000, total: 99_060_839 }, m: { kind: "downloading", received: 1, total: 2 } },
      {},
    ],
    [
      "download failed",
      { d: { kind: "failed", reason: "the network went away" }, m: { kind: "failed", reason: "the network went away" } },
      {},
    ],
    [
      "computing the first result",
      { d: { kind: "ready" }, m: { kind: "ready" } },
      { depth1: { kind: "waiting" }, cut1: { kind: "waiting" } },
    ],
    [
      "the run failed",
      { d: { kind: "ready" }, m: { kind: "ready" } },
      {
        depth1: { kind: "failed", reason: "no execution provider could load this model" },
        cut1: { kind: "failed", reason: "no execution provider could load this model" },
      },
    ],
    [
      "running and claiming nothing",
      { d: { kind: "ready" }, m: { kind: "ready" } },
      { depth1: { kind: "running", claimsNothing: false }, cut1: { kind: "running", claimsNothing: true } },
    ],
  ];

  it("says everything it has to say in one sentence, in every state", () => {
    let measured = 0;
    for (const [name, states, health] of cases) {
      const notices = buildNotices(targets as never, states as never, acquisition, health as never);
      for (const notice of notices) {
        measured += 1;
        const where = `${name}: ${notice.id}`;
        expect(notice.message.length, `${where} — message is ${notice.message.length} chars`).toBeLessThanOrEqual(
          MESSAGE_BUDGET,
        );
        // A full stop mid-string is a second sentence wearing one string's clothes, which
        // is exactly the shape the four-sentence banner had.
        expect(notice.message, `${where} — message is more than one sentence`).not.toMatch(/\. \S/);
        if (notice.detail === undefined) continue;
        expect(notice.detail.length, `${where} — detail is ${notice.detail.length} chars`).toBeLessThanOrEqual(
          DETAIL_BUDGET,
        );
        expect(notice.detail, `${where} — detail is more than one sentence`).not.toMatch(/\. \S/);
      }
    }
    // The gate must be MEASURING something: a `buildNotices` that returned nothing would
    // satisfy every assertion above and prove no rule at all.
    expect(measured).toBeGreaterThan(6);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════
 * §V852 EXTENDED TO REFERENCE COPY — A DESCRIPTION IS NOT A DOCUMENT (T1055)
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * §V852's ceiling above is a BANNER budget: 90 characters, one sentence, because a notice
 * appears unbidden while someone is trying to see what is going on. A node's `description`
 * is a different artefact and MUST NOT inherit that number. It is pull, not push — nobody
 * reads it unless they went looking — and the population proves the project means it:
 * MEASURED over all 115 installed definitions (T1055),
 *
 *   485 description strings (115 node, 293 parameter, 77 port)
 *   total    median  96   p75 207   p90 419   p95 572   p99 1239   max 3539
 *   lede     median  50   p75  79   p90 124   p95 151   p99  252   max  553
 *
 * — and there is NO CLIFF in any dimension (total length, first sentence, longest
 * sentence, or bytes per file: the worst file holds 13.7 % of the prose, spread over 38).
 * A banner-shaped ceiling anywhere in the 90-160 range flags 19-96 EXISTING strings — at
 * the banner's own 90, a FIFTH of the population — and §V852's allowlist is required to
 * SHRINK, not to become the population. So the honest
 * reading is that the long tail is the house style for reference copy and not a defect,
 * and this gate does not argue with it.
 *
 * What it does rule on is the point where the field has outgrown itself. These strings
 * have exactly ONE human surface — a native `title=` attribute, on the node library card
 * (`node-library.tsx`), the node search row (`node-search.tsx`) and the inspector's
 * parameter label (`control-row.tsx`). A `title` tooltip cannot be scrolled, cannot be
 * selected, and dismisses the moment the pointer moves. Nothing else renders this text:
 * `help/node-reference.ts` DERIVES `description` for the help panel and `help-panel.tsx`
 * never renders it, and `PortDefinition.description` reaches no chrome at all (it is read
 * only by the agent manifest tools). So past about a thousand characters the field stops
 * being a description of a thing and becomes a document about it — and this schema has
 * nowhere to put a document: enum options carry a `value` and a `label` and no prose of
 * their own, which is how `matte.model` came to hold four models' measured comparisons,
 * eighteen sentences, in one balloon on one label.
 *
 * ∴ the budget is a THOUSAND characters, ~11x the banner's, and the list below is the
 * decision it forces: eleven fields over it today, each named, each with the split that
 * would retire it. THE FIX IS A SPLIT, NEVER A CUT (§V403) — every one of these carries
 * measured numbers with their machine and date attached, and shortening one by deleting
 * its evidence would be a worse outcome than the length. The list must only ever get
 * shorter: an entry that comes back under budget FAILS here, so retiring one is visible.
 */
describe("§V852/T1055 — a node's reference copy is a description, not a document", () => {
  /**
   * Eleven times the banner's 90. Not a style rule about sentences: the point at which the
   * text needs a surface this schema does not have.
   */
  const BUDGET = 1000;

  /**
   * Over budget TODAY, and each entry names what it is really two of. Every one of these
   * is answering more than one question in a field that can only answer one.
   */
  const OVER_BUDGET: ReadonlyArray<{ id: string; split: string }> = [
    {
      id: "matte.model",
      split:
        "four models' measured comparisons — brightness cliff, provider times, licences — in " +
        "one enum's prose, because a `ParameterOption` carries a `value` and a `label` and no " +
        "text of its own. Each model's paragraph wants to live beside its own option.",
    },
    {
      id: "matte.backend",
      split:
        "what the control asks for, plus the METHOD for unfamiliar hardware (pin each provider " +
        "in turn, read the info popup). The method is one fact about this node and `matte.model` " +
        "states it a second time.",
    },
    {
      id: "matte.downsampleRatio",
      split:
        "what the ratio does, plus a restatement of the measured times that are ALREADY in the " +
        "option labels this description hangs under.",
    },
    {
      id: "movieFileIn",
      split:
        "what it plays (formats, stills, the refusal of EXR/.hdr), plus the free-run vs " +
        "TIMELINE-ANCHORED playhead contract (§V436). The second belongs on Play Mode — the " +
        "control that makes the choice — where `audioFileIn` repeats it verbatim.",
    },
    {
      id: "audioIn",
      split:
        "the channel catalogue, plus the tempo CLAIM and what bpmConfidence is worth. " +
        "`audioIn.tempoMode` already carries the second in its own 246 characters.",
    },
    {
      id: "audioFileIn",
      split:
        "three: the transport, the channel catalogue, and the tempo + playhead contract. Its own " +
        "`extend`, `tempoMode` and `syncOffset` already hold pieces of the last one.",
    },
    {
      id: "audioPattern",
      split:
        "its own synthesized beat, plus a restatement of the whole Audio In channel catalogue " +
        "('publishes EVERY channel Audio In does'). One catalogue, written out in two nodes.",
    },
    {
      id: "midiIn",
      split:
        "the channel contract and what is NOT read, plus the learn/Range/Toggle flow. The flow " +
        "belongs on the Controls parameters, which is where the reader is standing when they need it.",
    },
    {
      id: "oscIn",
      split:
        "the channel contract and the helper requirement, plus the per-row Address/Rest and " +
        "multi-argument addressing rules — the same split `midiIn` needs, in the same shape.",
    },
    {
      id: "pointKernel.kernel",
      split:
        "the ctx CLOCK contract (absTime/absFrame vs time/frameIndex), plus the struct Params " +
        "knobs contract. The clock half is a node-level fact and is duplicated verbatim in " +
        "`pointKernelAdvanced.kernel`.",
    },
    {
      id: "pointKernelAdvanced.kernel",
      split: "the same two as `pointKernel.kernel`, carrying the same duplicated clock contract.",
    },
  ];

  interface Copy {
    readonly id: string;
    readonly text: string;
  }

  /**
   * Every user-facing prose field a definition declares, keyed by where a reader meets it.
   *
   * §V1014: this walks the `NodeDefinition` CONTRACT's own `description` fields rather than
   * grepping for `description:`, because that name is also worn by command metadata, agent
   * tool copy and `decoderConfig.description` (a byte array).
   *
   * §T903/§V814: the schema comes through `effectiveParameterSchema`, once per enum option,
   * because a PER-INSTANCE control has prose too — `matte.downsampleRatio` is 1067 characters
   * that only exist while RVM is the chosen model, and a declared-schema sweep reports it
   * clean. The funnel is also why this file needs no entry in the raw-schema-read ledger.
   */
  function collectCopy(): Copy[] {
    const out: Copy[] = [];
    const add = (id: string, text: unknown) => {
      if (typeof text !== "string") return;
      const flat = text.replace(/\s+/g, " ").trim();
      if (flat.length > 0) out.push({ id, text: flat });
    };
    const seen = new Set<string>();
    const addOnce = (id: string, text: unknown) => {
      if (seen.has(id)) return;
      seen.add(id);
      add(id, text);
    };
    for (const definition of allNodeDefinitions) {
      add(definition.type, definition.description);
      for (const port of definition.inputs) add(`${definition.type}.in:${port.id}`, port.description);
      for (const port of definition.outputs) add(`${definition.type}.out:${port.id}`, port.description);
      const base = effectiveParameterSchema(definition, {});
      // `asset` and `pulse` declare no `default` (a binding and an event, not values), so the
      // stored document omits them; nothing here branches on either.
      const defaults = Object.fromEntries(
        Object.entries(base).flatMap(([key, schema]) =>
          schema.type === "asset" || schema.type === "pulse" ? [] : [[key, schema.default]],
        ),
      );
      // One stored document per enum option, not the cross product: a per-instance schema is
      // chosen by ONE enum (the model, the backend), and the cross product would buy nothing
      // for the cost of exploding.
      const schemas = [base];
      for (const [key, schema] of Object.entries(base)) {
        if (schema.type !== "enum") continue;
        for (const option of schema.options) {
          schemas.push(effectiveParameterSchema(definition, { ...defaults, [key]: option.value }));
        }
      }
      for (const schema of schemas) {
        for (const [key, parameter] of Object.entries(schema)) {
          addOnce(`${definition.type}.${key}`, parameter.description);
        }
      }
    }
    return out;
  }

  it("keeps every description inside the budget, and the over-budget list only shrinks", () => {
    const copy = collectCopy();
    // The gate must be MEASURING something: an empty registry would satisfy every
    // assertion below and prove no rule at all (§V968, and the notices gate's own shape).
    expect(copy.length, "the definition walk found no reference copy at all").toBeGreaterThan(400);

    const over = copy.filter((entry) => entry.text.length > BUDGET);
    const named = new Set(OVER_BUDGET.map((entry) => entry.id));
    const unexpected = over.filter((entry) => !named.has(entry.id));
    if (unexpected.length > 0) {
      const report = unexpected
        .map((entry) => `  ${entry.id}  ${entry.text.length} chars (budget ${BUDGET})`)
        .join("\n");
      throw new Error(
        `${unexpected.length} node description(s) over the reference-copy budget (§V852, T1055). ` +
          `This text has one surface — a native \`title\` tooltip that cannot be scrolled or ` +
          `selected — and past ${BUDGET} characters it is a document in a balloon. SPLIT it ` +
          `(it is answering two questions; give the second one its own parameter, port or ` +
          `node description), do NOT cut it: the measured numbers and their machines are the ` +
          `point of this prose:\n${report}`,
      );
    }

    // §V852: the list SHRINKS. An entry that came back under budget is a retirement, and it
    // has to be deleted here rather than left to make the list look like more work than it is.
    const lengths = new Map(copy.map((entry) => [entry.id, entry.text.length]));
    for (const entry of OVER_BUDGET) {
      // The list may only grow by a NAMED decision: an entry whose `split` is empty is an
      // exemption nobody argued for, which is how an allowlist becomes the population.
      expect(entry.split.length, `${entry.id} is exempted without naming its split`).toBeGreaterThan(40);
      const length = lengths.get(entry.id);
      expect(length, `${entry.id} is named over-budget but no longer exists`).not.toBeUndefined();
      expect(
        length,
        `${entry.id} is ${String(length)} chars, inside the ${BUDGET} budget — delete its OVER_BUDGET entry`,
      ).toBeGreaterThan(BUDGET);
    }
  });
});
