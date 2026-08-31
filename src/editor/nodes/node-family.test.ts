import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { PORT_FAMILY_VAR } from "@ui/ports.ts";
import { FAMILY_TINT_VAR, NODE_FAMILIES, familyForKind, nodeFamilyOf } from "./node-family.ts";
import type { NodeFamily } from "./node-family.ts";

/**
 * T712 — the node body's type-family tint, bounded at BOTH ends and measured.
 *
 * The owner asked for "a very very subtle hint of different background color", twice, and
 * the two halves of that pull against each other: too weak and it is invisible, which is
 * §T664 (a control made so quiet nobody could find it); too strong and it stops being a
 * hint (§V90). Neither bound is safe to leave to taste, so both are numbers here.
 *
 * The technique is HUE AT CONSTANT LUMINANCE, and that is the third assertion. Separating
 * families by brightness would say some of them are nearer or more important than others,
 * which is false — they are peers. Equal-L hue is the only honest way to carry a peer
 * distinction, and "equal" has to be checked or it drifts the first time someone nudges a
 * token by eye.
 *
 * Distances are in CIE Lab, whose a/b plane is where a hue shift at fixed lightness lives.
 */

const TOKENS = readFileSync(
  fileURLToPath(new URL("../../ui/tokens.css", import.meta.url)),
  "utf8",
);

/** At least this far apart, or the families cannot be told from each other (§T664). */
const MIN_FAMILY_SEPARATION = 5;
/** At most this far from the node surface, or it is decoration rather than a hint (§V90). */
const MAX_TINT_FROM_SURFACE = 9;
/** The tint is a HUE shift; this is how much lightness it is allowed to borrow. */
const MAX_LIGHTNESS_DRIFT = 0.5;

function lab(hex: string): [number, number, number] {
  const linear = [1, 3, 5]
    .map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as number[];
  const [r, g, b] = linear as [number, number, number];
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (t * (24389 / 27) + 16) / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** The value `tokens.css` actually declares — never a copy kept in this file. */
function token(name: string): [number, number, number] {
  const match = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(TOKENS);
  if (match === null) throw new Error(`${name} is not declared in tokens.css`);
  return lab(match[1] as string);
}

/** Chroma distance — the a/b plane, which is where a constant-lightness hue shift lives. */
function chromaDistance(a: readonly number[], b: readonly number[]): number {
  return Math.hypot((a[1] as number) - (b[1] as number), (a[2] as number) - (b[2] as number));
}

describe("T712 — every family declares a tint, and the mapping cannot go stale", () => {
  it("gives EVERY port kind a family — the whole union, not just the ones in use", () => {
    /*
     * The `satisfies Record<PortKind, NodeFamily>` in node-family.ts is what makes a new
     * port kind a COMPILE error until it declares a family. This is its runtime shadow,
     * and it is asserted over `PORT_FAMILY_VAR` — itself exhaustively typed over
     * `PortKind` — rather than over the kinds shipped nodes happen to use.
     *
     * That distinction is the point. Only eight kinds appear on a port today (camera,
     * light, material, pointset, projector, scene, texture2d, value); the other seven are
     * declared and unused. A test that walked the registry would have said nothing about
     * them, and the first node to output a `buffer` would have arrived untinted.
     */
    const kinds = Object.keys(PORT_FAMILY_VAR) as Array<keyof typeof PORT_FAMILY_VAR>;
    // Guards the guard: an empty list would make this vacuous.
    expect(kinds.length).toBeGreaterThan(10);
    for (const kind of kinds) {
      expect(NODE_FAMILIES, `${kind} has no family`).toContain(familyForKind(kind));
    }
  });

  it("actually tints the nodes that ship, in every family that has any", () => {
    // Non-vacuity from the other side: the mapping being total is worthless if it lands
    // every shipped node in one bucket. Measured today: texture 48, value 16, points 14,
    // spatial 8, and two sinks correctly claiming none.
    const registry = createNodeRegistry(allNodeDefinitions).view();
    const counts = new Map<string, number>();
    for (const definition of registry.list()) {
      const family = nodeFamilyOf(definition) ?? "(none)";
      counts.set(family, (counts.get(family) ?? 0) + 1);
    }
    for (const family of ["texture", "value", "points", "spatial"]) {
      expect(counts.get(family) ?? 0, `no shipped node is in ${family}`).toBeGreaterThan(0);
    }
    // And the distinction the owner asked for is a real split, not 90% one colour.
    expect(counts.get("texture")).toBeLessThan(registry.list().length * 0.8);
  });

  it("declares a token for every family and no orphans", () => {
    expect(Object.keys(FAMILY_TINT_VAR).sort()).toEqual([...NODE_FAMILIES].sort());
    for (const name of Object.values(FAMILY_TINT_VAR)) {
      expect(TOKENS).toMatch(new RegExp(`${name}:\\s*#[0-9a-f]{6};`));
    }
  });

  it("reads a node's family off its own primary output", () => {
    const registry = createNodeRegistry(allNodeDefinitions).view();
    // Spot the four the owner named, by the nodes they actually are.
    expect(nodeFamilyOf(registry.get("noise"))).toBe("texture");
    expect(nodeFamilyOf(registry.get("lfo"))).toBe("value");
    // And a SINK claims no family rather than defaulting into one: it produces no
    // payload, so there is nothing for a tint to be about.
    const sink = registry.list().find((definition) => definition.outputs.length === 0);
    expect(sink).toBeDefined();
    expect(nodeFamilyOf(sink)).toBeNull();
    expect(nodeFamilyOf(undefined)).toBeNull();
  });
});

describe("T712 — the tint is bounded at both ends and carries no lightness", () => {
  const surface = token("--bg-raise");
  const tints = new Map<NodeFamily, [number, number, number]>(
    NODE_FAMILIES.map((family) => [family, token(FAMILY_TINT_VAR[family])]),
  );

  it("shifts HUE, not brightness — every family sits at the node surface's lightness", () => {
    /*
     * The technique, asserted rather than described. A tint set that separated families by
     * lightness would satisfy both bounds below perfectly well and would still be wrong:
     * the brighter families would read as nearer or more important, and these are peers.
     */
    for (const [family, tint] of tints) {
      expect(Math.abs((tint[0] as number) - (surface[0] as number))).toBeLessThanOrEqual(
        MAX_LIGHTNESS_DRIFT,
      );
      void family;
    }
  });

  it("keeps every family at least MIN apart from every other", () => {
    // §T664's failure is the one this prevents: made quiet, became invisible. A pair that
    // collapses here is two families a person cannot tell apart.
    for (const [a, tintA] of tints) {
      for (const [b, tintB] of tints) {
        if (a === b) continue;
        expect(
          chromaDistance(tintA, tintB),
          `${a} and ${b} are indistinguishable`,
        ).toBeGreaterThanOrEqual(MIN_FAMILY_SEPARATION);
      }
    }
  });

  it("keeps every family within MAX of the node surface", () => {
    // §V90, and the owner's word twice: a hint, not a colour-coded spreadsheet. This is
    // the bound that a well-meaning "make it clearer" would break.
    for (const [family, tint] of tints) {
      expect(
        chromaDistance(tint, surface),
        `${family} has left the node surface behind`,
      ).toBeLessThanOrEqual(MAX_TINT_FROM_SURFACE);
    }
  });

  it("does not collide with the carriers that already mean something", () => {
    /*
     * The tint paints the BODY; the status edge, the status dot, the selection ring and
     * the error border paint the furniture over it. This asserts the one way they could
     * still be confused — a tint that had drifted close enough to a SIGNAL colour to read
     * as that state. The signal colours are far off the surface by design, so this is
     * comfortable today and would catch a tint set pushed toward them.
     */
    for (const meaningful of ["--signal", "--error", "--ok", "--warn", "--component"]) {
      const carrier = token(meaningful);
      for (const [family, tint] of tints) {
        expect(
          chromaDistance(tint, carrier),
          `${family} has drifted into ${meaningful}`,
        ).toBeGreaterThan(MAX_TINT_FROM_SURFACE * 2);
      }
    }
  });
});
