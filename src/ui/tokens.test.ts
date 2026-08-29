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
/** Literal color functions, the other way to smuggle a color past the tokens. */
const COLOR_FN = /\b(?:rgba?|hsla?|color-mix|oklch|oklab|lch|lab|hwb|light-dark)\(/g;

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
      if (!allowsDynamic) expect(source.match(COLOR_FN) ?? []).toEqual([]);
    },
  );

  it("keeps the literal palette in tokens.css only", () => {
    expect((tokensCss.match(HEX) ?? []).length).toBeGreaterThan(10);
  });

  it("defines the §C palette exactly", () => {
    const palette: Record<string, string> = {
      "--bg-void": "#0b0e14",
      "--bg-panel": "#12161f",
      "--bg-raise": "#1a202c",
      "--line": "#232a38",
      "--line-hot": "#384356",
      "--text": "#d6dce8",
      "--text-dim": "#7c8698",
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
