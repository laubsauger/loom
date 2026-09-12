import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PORT_FAMILY_VAR, portFamilyColor } from "./ports.ts";

const SRC = fileURLToPath(new URL("..", import.meta.url));
const TOKENS = join(SRC, "ui", "tokens.css");
const tokensCss = readFileSync(TOKENS, "utf8");

/** Literal colors: #rgb, #rgba, #rrggbb, #rrggbbaa. */
const HEX = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g;
/** Color functions — the other way to smuggle a literal past the tokens. */
const COLOR_FN =
  /\b(?:rgba?|hsla?|color-mix|oklch|oklab|lch|lab|hwb|light-dark)\((?:[^()]|\([^()]*\))*\)/g;

/**
 * A color function is only a violation if it introduces a LITERAL. Deriving from a token —
 * `color-mix(in srgb, var(--port-color) 30%, transparent)` — is exactly what the tokens
 * are for, and there is no other way to express a translucent tint of a themed colour.
 * So a call is allowed when every colour argument is a var() or a colour keyword.
 */
const TOKEN_DERIVED = /^\w[\w-]*\((?:[^()]|var\([^()]*\))*\)$/;
function introducesLiteral(call: string): boolean {
  if (!TOKEN_DERIVED.test(call)) return true;
  const withoutVars = call.replace(/var\([^()]*\)/g, "");
  // Anything left that looks like a colour is a literal; numbers, percentages,
  // colour-space keywords and `transparent`/`currentColor` are not.
  return /#[0-9a-fA-F]{3,}|\b(?:rgba?|hsla?|oklch|oklab|lch|lab|hwb)\(/.test(withoutVars);
}

function collect(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      collect(path, out);
      continue;
    }
    // "Component file" = anything that renders or styles.
    if (!/\.(tsx|ts|css)$/.test(entry.name)) continue;
    if (/\.test\.(ts|tsx)$/.test(entry.name)) continue;
    if (path === TOKENS) continue;
    out.push(path);
  }
  return out;
}

/**
 * Escape hatch for files that legitimately COMPUTE a colour from data rather than
 * theming with one — a colour-picker swatch turning a ColorParameter into a CSS
 * colour, for example. Such a file must carry the marker below with a reason, so the
 * exception is visible and reviewable instead of being an unnoticed hole in the guard.
 *
 *   // v17-allow-dynamic-color: swatch renders the user's colour parameter value
 */
const ALLOW_MARKER = /v17-allow-dynamic-color:\s*\S+/;

describe("V17 — dark-only theme, every color comes from a token", () => {
  const files = collect(SRC);

  it("scans a non-trivial number of component files", () => {
    // Guards the guard: a broken walker must not silently pass.
    expect(files.length).toBeGreaterThan(5);
  });

  it("every dynamic-colour exemption states a reason", () => {
    // Guards the escape hatch: a bare marker with no reason does not count.
    const bare = files.filter((file) => {
      const text = readFileSync(file, "utf8");
      return text.includes("v17-allow-dynamic-color") && !ALLOW_MARKER.test(text);
    });
    expect(bare).toEqual([]);
  });

  it.each(files.map((file) => [relative(SRC, file), file]))(
    "%s declares no literal color",
    (_name, file) => {
      const source = readFileSync(file, "utf8");
      // A file that computes colours from data may opt out with a stated reason.
      // Hex literals are never exempt — only colour FUNCTIONS built from values.
      const allowsDynamic = ALLOW_MARKER.test(source);
      expect(source.match(HEX) ?? []).toEqual([]);
      if (!allowsDynamic) {
        const literalCalls = (source.match(COLOR_FN) ?? []).filter(introducesLiteral);
        expect(literalCalls).toEqual([]);
      }
    },
  );

  it("keeps the literal palette in tokens.css only", () => {
    expect((tokensCss.match(HEX) ?? []).length).toBeGreaterThan(10);
  });

  it("defines the §C palette exactly", () => {
    const palette: Record<string, string> = {
      // Lifted from #0b0e14 (2096a6f): a preview tile's content is often pure black, so
      // the tile, the node body and the canvas ground collapsed into one shape. This test
      // is the reason the palette cannot drift silently — it caught that commit.
      // Widened at T708; the SEPARATION between them is gated below, which is the part
      // that survives the next deliberate re-pin of these values.
      "--bg-void": "#131821",
      "--bg-panel": "#161b25",
      "--bg-raise": "#232937",
      "--line": "#2e3646",
      "--divider-line": "#293040",
      "--line-hot": "#404a5f",
      "--text": "#d6dce8",
      "--text-dim": "#8d95a7",
      "--signal": "#f2a03d",
      "--warn": "#fbbf24",
      "--error": "#ff5c57",
      "--ok": "#34d399",
    };
    for (const [token, value] of Object.entries(palette)) {
      expect(tokensCss).toContain(`${token}: ${value};`);
    }
  });

  it("defines the type scale, radius and hairline the spec fixes", () => {
    for (const declaration of [
      "--fs-micro: 10px",
      "--fs-meta: 11px",
      "--fs-ui: 12px",
      "--fs-body: 13px",
      "--fs-title: 16px",
      "--fs-display: 22px",
      "--lh-ui: 1.35",
      "--lh-prose: 1.55",
      "--radius: 3px",
      "--radius-none: 0",
      "--hairline: 1px",
      "--tracking-display: -0.01em",
    ]) {
      expect(tokensCss).toContain(declaration);
    }
  });

  it("never falls back to Inter, and keeps a real fallback stack (T3)", () => {
    expect(tokensCss).not.toMatch(/--font-(?:ui|mono):[^;]*\bInter\b/s);
    expect(tokensCss).toContain('"Archivo Variable"');
    expect(tokensCss).toContain('"JetBrains Mono Variable"');
    // A stack, not a single face: sans-serif / monospace endpoints are present.
    expect(tokensCss).toMatch(/--font-ui:[^;]*sans-serif;/s);
    expect(tokensCss).toMatch(/--font-mono:[^;]*monospace;/s);
  });
});

/**
 * T708 — the SURFACE LADDER has a numeric floor.
 *
 * The bug this replaces was not a wrong colour, it was a colour difference too small to
 * see: --bg-void and --bg-panel differed by rgb(2,2,2), so the 3px pane gutter documented
 * under --divider could not be perceived and every pane read as one sheet. Pinning the
 * hexes (above) catches an ACCIDENTAL edit, but it cannot catch the failure mode that
 * actually happened — someone deliberately re-tuning the palette and re-pinning it just
 * as flat. Only a floor on the SEPARATION does that, so this is the gate that matters.
 *
 * The measure is CIE L*, not raw rgb distance: L* is uniform in perceived lightness, so
 * "4 units apart" means the same thing at the dark end of the ramp as at the light end,
 * which raw channel deltas emphatically do not. The floors are stated as constants rather
 * than inlined so that raising or lowering the bar is a visible, reviewable edit.
 */
const MIN_SURFACE_STEP = 4; // adjacent rungs of the structural ladder
const MIN_STATE_STEP = 3; // a hover/active state against the surface it covers
const MIN_LINE_STEP = 4; // a hairline against the lightest surface it rules
const MIN_DOT_STEP = 15; // the graph dot grid against the graph void

/** sRGB hex -> CIE L* (D65). */
function lightness(hex: string): number {
  const channels = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  const linear = channels.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const y = 0.2126729 * linear[0]! + 0.7151522 * linear[1]! + 0.072175 * linear[2]!;
  return y <= 216 / 24389 ? y * (24389 / 27) : Math.cbrt(y) * 116 - 16;
}

/** The value tokens.css actually declares — never a copy of it kept in this file. */
function tokenLightness(name: string): number {
  const match = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(tokensCss);
  if (match === null) throw new Error(`${name} is not declared in tokens.css as a 6-digit hex`);
  return lightness(match[1]!);
}

describe("T708 — adjacent surfaces are separated by a perceptible amount", () => {
  it("reads the ladder out of tokens.css, so a re-tuned palette is re-measured", () => {
    // Guards the guard: if the regex stopped matching, every assertion below would be
    // measuring nothing. A ladder that does not rise is not a ladder.
    const ladder = ["--bg-sunken", "--bg-void", "--bg-panel", "--bg-raise"].map(tokenLightness);
    expect(ladder).toHaveLength(4);
    expect([...ladder].sort((a, b) => a - b)).toEqual(ladder);
  });

  it.each([
    // Only the pairs that actually MEET on screen carry the floor. --bg-void is the app
    // backdrop and is occluded everywhere by a pane or the canvas, so it is held in
    // ladder ORDER (above) but not to a perceptual step — a floor on an invisible pair
    // would be a number nobody can check by looking, and it would have blocked the
    // owner's tightening of the two visible ends for no reason anyone could see.
    ["--bg-sunken", "--bg-panel"], // the graph well against every pane around it
    ["--bg-panel", "--bg-raise"], // a pane against the nodes, menus and popovers on it
  ])("%s and %s are at least 4 L* apart", (darker, lighter) => {
    expect(tokenLightness(lighter) - tokenLightness(darker)).toBeGreaterThanOrEqual(
      MIN_SURFACE_STEP,
    );
  });

  it("draws the pane seam LIGHTER than both surfaces it separates", () => {
    /*
     * The inverted relationship, gated rather than remembered. T491 made the seam
     * RECESSED — 3px of --bg-void showing between panes — and T708 first widened the
     * ladder while keeping it recessed. The owner looked at that and reversed it: "the
     * vertical dividers and horizontal ones should BE lighter and not be almost black."
     *
     * A floor written as "adjacent surfaces must differ" cannot express this. It is
     * satisfied just as well by a seam DARKER than its neighbours, which is precisely
     * the design that was rejected — so the separation is asserted with a direction.
     * The seam divides a pane from another pane, and a pane from the graph well, so it
     * must clear the lightest and the darkest of those.
     */
    const seam = tokenLightness("--divider-line");
    for (const surface of ["--bg-panel", "--bg-sunken", "--bg-void"]) {
      expect(seam - tokenLightness(surface)).toBeGreaterThanOrEqual(MIN_SURFACE_STEP);
    }
    // And the drag/hover state has to brighten further, not darken back past the seam.
    expect(tokenLightness("--line-hot")).toBeGreaterThan(seam);
  });

  it("separates each interaction state from the surface it covers", () => {
    expect(tokenLightness("--bg-hover") - tokenLightness("--bg-panel")).toBeGreaterThanOrEqual(
      MIN_STATE_STEP,
    );
    // --bg-active is the highlighted row inside a menu, and a menu is --bg-raise.
    expect(tokenLightness("--bg-active") - tokenLightness("--bg-raise")).toBeGreaterThanOrEqual(
      MIN_STATE_STEP,
    );
  });

  it("keeps a hairline visible on the lightest surface it rules", () => {
    expect(tokenLightness("--line") - tokenLightness("--bg-raise")).toBeGreaterThanOrEqual(
      MIN_LINE_STEP,
    );
    expect(tokenLightness("--line-hot") - tokenLightness("--line")).toBeGreaterThanOrEqual(
      MIN_LINE_STEP,
    );
  });

  it("keeps the graph dot grid visible against the graph void", () => {
    // A far bigger floor than a surface step, and deliberately so: the dots are a 1.5px
    // radius on a 16px pitch, so they are mostly antialiased edge. A separation that
    // reads across a whole pane does not read across a sub-pixel dot — which is how the
    // grid went missing while --line was, on paper, "ten L* above the ground".
    expect(tokenLightness("--graph-dot") - tokenLightness("--bg-sunken")).toBeGreaterThanOrEqual(
      MIN_DOT_STEP,
    );
  });

  it("keeps dim text legible against every surface it is set on", () => {
    // Widening the ladder lifts the surfaces under the text; without raising --text-dim
    // with them this rebalance would have bought contrast between panes by spending it
    // on the 11px meta text inside them.
    const contrast = (a: string, b: string) => {
      const luminance = (hex: string) => {
        const channels = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
        const [r, g, bl] = channels.map((c) =>
          c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
        );
        return 0.2126729 * r! + 0.7151522 * g! + 0.072175 * bl!;
      };
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi! + 0.05) / (lo! + 0.05);
    };
    const hex = (name: string) => new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(tokensCss)![1]!;
    for (const surface of ["--bg-panel", "--bg-raise"]) {
      expect(contrast(hex("--text-dim"), hex(surface))).toBeGreaterThanOrEqual(4.5);
    }
  });
});

/**
 * T853 — the pane's CHROME BAND is a different value from the body it labels.
 *
 * The owner asked for "a tiny little bit of a different shade", and the three rounds
 * before this one all overshot upward. So both bounds are gated, not just the presence of
 * a difference: a band that collapses back onto the body is the bug being fixed, and a
 * band that climbs toward --bg-raise is the failure the owner has already rejected three
 * times. The floor is deliberately BELOW T708's 4 L* surface step — those are structural
 * rungs meant to read across a whole pane, this is a 24px strip already separated by a
 * hairline, and "tiny" is the requirement rather than a compromise.
 */
describe("T853 — the pane header band differs from the pane body, slightly", () => {
  const MIN_BAND_STEP = 1; // it must be a different value at all
  const MAX_BAND_STEP = 3; // and it must stay under the structural step (4)

  /** Follows `--x: var(--y)` aliases to the hex a token finally resolves to. */
  function resolve(name: string): string {
    for (let hops = 0; hops < 4; hops += 1) {
      const match = new RegExp(`${name}:\\s*([^;]+);`).exec(tokensCss);
      if (match === null) throw new Error(`${name} is not declared in tokens.css`);
      const value = match[1]!.trim();
      if (/^#[0-9a-fA-F]{6}$/.test(value)) return value;
      const alias = /^var\((--[\w-]+)\)$/.exec(value);
      if (alias === null) throw new Error(`${name} is neither a hex nor a plain var() alias: ${value}`);
      name = alias[1]!;
    }
    throw new Error(`${name} aliases in a cycle`);
  }

  it("is an ALIAS onto the ladder, never a colour invented for the band", () => {
    // The whole point of the token: round four re-points one alias instead of eyeballing
    // a fourth hex. A literal here would also mean a new rung nothing else measures.
    expect(/--bg-header:\s*var\(--[\w-]+\);/.test(tokensCss)).toBe(true);
    // Onto a rung that EXISTS — not pinned to which one, because the next round is meant
    // to re-point this alias and the bounds below are what must survive that.
    const ladder = ["--bg-sunken", "--bg-void", "--bg-panel", "--bg-raise"].map(resolve);
    expect(ladder).toContain(resolve("--bg-header"));
  });

  it("differs from the pane body by a small, bounded amount in BOTH directions", () => {
    const step = Math.abs(lightness(resolve("--bg-panel")) - lightness(resolve("--bg-header")));
    expect(step).toBeGreaterThanOrEqual(MIN_BAND_STEP);
    expect(step).toBeLessThanOrEqual(MAX_BAND_STEP);
    // DOWNWARD, and that is the decision being recorded: every previous round of this
    // band was rejected for being too bright, and the rungs above --bg-panel are 5.4 and
    // 6.9 L* away — nothing up there is "a tiny little bit".
    expect(lightness(resolve("--bg-header"))).toBeLessThan(lightness(resolve("--bg-panel")));
  });

  it("is what the pane header and the leaf's tab strip actually paint with", () => {
    // Wiring guard: a token nothing reads is a comment. Both surfaces the owner named
    // must reach it, and neither may fall back to the body fill it is meant to differ from.
    for (const file of ["app/pane.module.css", "app/pane-leaf.module.css"]) {
      const css = readFileSync(join(SRC, ...file.split("/")), "utf8");
      expect(css, `${file} does not paint with --bg-header`).toContain("background: var(--bg-header)");
    }
    // And the seam still reads ABOVE the band, so T708's lit-divider rule is not quietly
    // inverted by lowering the surface next to it.
    expect(lightness(resolve("--divider-line"))).toBeGreaterThan(lightness(resolve("--bg-header")));
  });
});

describe("V26 — port family colors are semantic and complete", () => {
  it("gives every PortType.kind its own token", () => {
    const values = Object.values(PORT_FAMILY_VAR);
    expect(new Set(values).size).toBe(values.length);
    for (const token of values) {
      expect(tokensCss).toMatch(new RegExp(`${token}:\\s*#[0-9a-f]{6};`));
    }
  });

  it("resolves a kind to a var() reference, never to a literal", () => {
    expect(portFamilyColor("texture2d")).toBe("var(--port-texture2d)");
    expect(portFamilyColor("audioFeatures")).toBe("var(--port-audioFeatures)");
    for (const kind of Object.keys(PORT_FAMILY_VAR) as Array<keyof typeof PORT_FAMILY_VAR>) {
      expect(portFamilyColor(kind)).not.toContain("#");
    }
  });

  it("pins the spec-fixed family hues", () => {
    const fixed: Record<string, string> = {
      "--port-texture2d": "#4fd1c5",
      "--port-buffer": "#a78bfa",
      "--port-scalar": "#94a3b8",
      "--port-vector": "#f472b6",
      "--port-matrix": "#fbbf24",
      "--port-pointset": "#60a5fa",
      "--port-camera": "#34d399",
      "--port-event": "#fb7185",
      "--port-audioFeatures": "#c084fc",
    };
    for (const [token, value] of Object.entries(fixed)) {
      expect(tokensCss).toContain(`${token}: ${value};`);
    }
  });
});

describe("V19 — the motion and focus floor is declared in tokens", () => {
  it("zeroes the motion tokens under prefers-reduced-motion", () => {
    const reduced = tokensCss.slice(tokensCss.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toContain("--dur-fast: 0ms");
    expect(reduced).toContain("--motion-scale: 0");
  });

  it("declares a focus ring token used by the base layer", () => {
    expect(tokensCss).toContain("--focus-ring:");
    const base = readFileSync(join(SRC, "ui", "base.css"), "utf8");
    expect(base).toContain(":focus-visible");
    expect(base).toContain("var(--focus-ring)");
    expect(base).toContain("@media (prefers-reduced-motion: reduce)");
  });
});

/**
 * B214 (§V957) — A `var()` NOBODY DEFINED IS A DECLARATION NOBODY APPLIES.
 *
 * `height: var(--space-10)` sat in `editor/nodes/value-plot.module.css` from the day that
 * file was written. `--space-10` is defined nowhere. CSS does not warn about that: the
 * property is computed as the guaranteed-invalid value, the declaration is dropped at
 * used-value time, and the element simply lays out as though the line had never been
 * typed. Every value node's curve has therefore been sized by its SVG's intrinsic ratio —
 * i.e. by the node's width — for a year, and nothing anywhere went red. The V17 scan above
 * reads the same files and could not see it, because a reference to a token IS the correct
 * shape; only the far end is missing.
 *
 * That is the silent-failure class this gate closes, and it is the same shape as an
 * undefined token RENAMED out from under a consumer — the rename lands green, the
 * consumer keeps the syntax, and the styling quietly stops.
 *
 * ## What counts as defined
 *
 * Everything the tree declares anywhere: `tokens.css`, a component module that sets its
 * own local custom property (`--node-width`), an `@property` rule, a React inline-style
 * object key, a `setProperty` call. Custom properties are NOT scoped by CSS Modules — they
 * are inherited through the DOM at runtime — so "defined somewhere in the tree" is the
 * only claim a static walk can honestly make. That makes this gate DELIBERATELY
 * conservative: it catches the token that exists NOWHERE, not the one defined on an
 * element that happens not to be an ancestor. A false positive here would get the gate
 * deleted; a missed cousin of the bug would not.
 *
 * ## What is not a violation
 *
 * `var(--x, 12px)` states its own answer when `--x` is absent, which is the documented way
 * to reference a property that may not be set (`--slot-aspect`, `--border-color`). Only a
 * reference with NO fallback is a claim that the token exists. Comments are blanked before
 * the scan — this very file discusses `var(--y)` in prose, and a detector that reads prose
 * gets an exemption written for it, which is how a derived list becomes a remembered one.
 *
 * ## Cost
 *
 * One read of every `.css`/`.ts`/`.tsx` under `src`, ~90 ms. `test:gates` runs before every
 * commit and that budget is part of its contract (see `guardrails/gate-list.test.ts`).
 */

/** The token names a source declares — CSS, `@property`, inline-style keys, `setProperty`. */
const DEFINES = /(?:^|[\s;{(,])["'`]?(--[\w-]+)["'`]?\s*:/gm;
const DEFINES_AT_PROPERTY = /@property\s+(--[\w-]+)/g;
const DEFINES_VIA_SCRIPT = /setProperty\(\s*["'`](--[\w-]+)["'`]/g;
/** A reference, plus the character that follows the name: `,` means it carries a fallback. */
const REFERENCES = /var\(\s*(--[\w-]+)\s*([,)])/g;

/**
 * Comments, blanked rather than removed, so a reported line number is the line a reader
 * will find the reference on.
 */
function blankComments(source: string): string {
  const blank = (text: string) => text.replace(/[^\n]/g, " ");
  return source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:])\/\/[^\n]*/g, (match: string, lead: string) => lead + blank(match.slice(lead.length)));
}

function definitionsIn(source: string): string[] {
  const names: string[] = [];
  for (const pattern of [DEFINES, DEFINES_AT_PROPERTY, DEFINES_VIA_SCRIPT]) {
    for (const match of source.matchAll(pattern)) names.push(match[1]!);
  }
  return names;
}

/** Every `var(--x)` with no fallback, with the 1-based line it sits on. */
function bareReferencesIn(source: string): Array<{ token: string; line: number }> {
  const found: Array<{ token: string; line: number }> = [];
  for (const match of source.matchAll(REFERENCES)) {
    if (match[2] === ",") continue;
    const line = source.slice(0, match.index).split("\n").length;
    found.push({ token: match[1]!, line });
  }
  return found;
}

/**
 * KNOWN UNDEFINED — the rest of what the B214 sweep turned up, each one a real dropped
 * declaration and each one someone else's file to fix.
 *
 * This is a DEBT LIST, not a set of legitimate exceptions: every row is a bug awaiting its
 * own row on the board, listed here so this gate can go green on the tree as it stands
 * rather than being landed red (a gate that ships red gets skipped, and a skipped gate is
 * no gate). The list is checked in BOTH directions below, so fixing one of these forces
 * the row out and the list cannot rot into a permanent exemption.
 */
const KNOWN_UNDEFINED: Readonly<Record<string, string>> = {
  // B215 emptied this list: all six references now point at tokens the tree defines.
  // A row here is a shipped defect parked with its reason, never a place to leave one.
};

describe("B214 — every var() reference resolves to a token the tree defines", () => {
  const files = [TOKENS, ...collect(SRC)];
  const sources = new Map(files.map((file) => [file, blankComments(readFileSync(file, "utf8"))]));
  const defined = new Set(
    [...sources.values()].flatMap((source) => definitionsIn(source)),
  );
  const undefinedUses = [...sources]
    .flatMap(([file, source]) =>
      bareReferencesIn(source).map((reference) => ({
        ...reference,
        file: `src/${relative(SRC, file)}`,
      })),
    )
    .filter(({ token }) => !defined.has(token));

  it("scans the whole styled tree and finds the token scale in it", () => {
    // Guards the guard: a walker that read nothing, or a definition regex that matched
    // nothing, would pass every assertion below by finding no references at all.
    expect(files.length).toBeGreaterThan(200);
    expect(defined.size).toBeGreaterThan(100);
    for (const token of ["--space-48", "--bg-panel", "--node-width"]) {
      expect(defined.has(token), `${token} should have been collected as defined`).toBe(true);
    }
  });

  it("reports a reference whose token exists nowhere, naming file, line and token", () => {
    // The detector, shown failing on the literal bug this row was opened for. Held as a
    // fixture rather than as the tree, so this stays red-verified after the tree is fixed.
    const broken = ".canvas {\n  width: 100%;\n  height: var(--space-10);\n}\n";
    expect(bareReferencesIn(blankComments(broken))).toEqual([{ token: "--space-10", line: 3 }]);
    expect(defined.has("--space-10")).toBe(false);
  });

  it("does not report a reference that carries its own fallback", () => {
    // The legitimate case this guard could swallow, taken from the real tree:
    // `--border-color` is referenced once, in node-view.module.css, and defined nowhere —
    // and that is CORRECT, because the reference states what to do without it.
    expect(defined.has("--border-color")).toBe(false);
    const nodeView = sources.get(join(SRC, "editor", "nodes", "node-view.module.css"))!;
    expect(nodeView).toContain("var(--border-color,");
    expect(bareReferencesIn(nodeView).map(({ token }) => token)).not.toContain("--border-color");
  });

  it("does not report a token a module defines for itself", () => {
    // `--node-width` lives in node-view.module.css, never in tokens.css. A gate that only
    // read the token file would flag it, be wrong, and be deleted within the week.
    expect(undefinedUses.map(({ token }) => token)).not.toContain("--node-width");
    // Same for a var read through JS rather than declared in CSS.
    expect(undefinedUses.map(({ token }) => token)).not.toContain("--status-color");
  });

  it("finds no undefined token outside the known-debt list", () => {
    const unexpected = undefinedUses
      .filter(({ file, token }) => KNOWN_UNDEFINED[`${file}:${token}`] === undefined)
      .map(({ file, line, token }) => `${file}:${line} references ${token}, which is defined nowhere`);
    expect(
      unexpected,
      "A var() with no fallback and no definition anywhere in the tree: CSS drops the whole " +
        "declaration silently, so the element lays out as though the line were absent (B214). " +
        "Point it at a token that exists, add the token to ui/tokens.css, or give the " +
        "reference a fallback if it is genuinely optional.",
    ).toEqual([]);
  });

  it("keeps the debt list honest: a row that has been fixed must be deleted", () => {
    const live = new Set(undefinedUses.map(({ file, token }) => `${file}:${token}`));
    for (const [key, reason] of Object.entries(KNOWN_UNDEFINED)) {
      expect(reason.length, `${key} is listed with no reason`).toBeGreaterThan(20);
      expect(
        live,
        `${key} is listed as known-undefined but now resolves — delete the row`,
      ).toContain(key);
    }
  });
});
