import { describe, expect, it } from "vitest";

import { SCHEMA_VERSION } from "../types/schemas.ts";
import {
  DOCUMENT_MIGRATIONS,
  migrateProjectDocument,
  validateMigrationLadder,
} from "./document-migrations.ts";
import type { DocumentMigration, RawDocument } from "./types.ts";

/**
 * T43 — the schema-migration ladder.
 *
 * The failure this suite exists to prevent is the quiet one: a document that ran two of
 * three steps and was then saved back over the user's file. Every assertion below is some
 * form of "when the ladder is wrong, NOTHING is applied and somebody is told why".
 *
 * The ladder ships empty at schemaVersion 1, so the steps here are synthetic. That is the
 * point of testing the mechanism rather than the contents: the first real migration will
 * be written under time pressure, against files that already exist.
 */

function step(from: number, to: number, apply: (doc: RawDocument) => void): DocumentMigration {
  return {
    from,
    to,
    description: `v${from} → v${to}`,
    migrate(document) {
      apply(document);
      return document;
    },
  };
}

function fileAt(version: number, extra: RawDocument = {}): unknown {
  return { schemaVersion: version, name: "Test", ...extra };
}

describe("the shipped ladder is internally consistent", () => {
  it("has no gap, no duplicate start and no backwards step", () => {
    expect(validateMigrationLadder(DOCUMENT_MIGRATIONS)).toEqual([]);
  });

  it("can carry any version it claims to support up to the current one", () => {
    const starts = DOCUMENT_MIGRATIONS.map((migration) => migration.from);
    for (const from of starts) {
      const result = migrateProjectDocument(fileAt(from));
      expect(result.ok, `no path from schemaVersion ${from} to ${SCHEMA_VERSION}`).toBe(true);
    }
  });
});

describe("an ordered chain runs in order", () => {
  const migrations = [
    step(1, 2, (doc) => void (doc["trail"] = [1])),
    step(2, 3, (doc) => (doc["trail"] as number[]).push(2)),
    step(3, 4, (doc) => (doc["trail"] as number[]).push(3)),
  ];

  it("applies every step and stamps the final version", () => {
    const result = migrateProjectDocument(fileAt(1), { migrations, targetVersion: 4 });
    if (!result.ok) throw new Error(result.reason);

    expect(result.document["trail"]).toEqual([1, 2, 3]);
    expect(result.document["schemaVersion"]).toBe(4);
    expect(result.applied.map((step) => `${step.from}->${step.to}`)).toEqual(["1->2", "2->3", "3->4"]);
  });

  it("starts from the document's own version, not from the bottom", () => {
    const result = migrateProjectDocument(fileAt(3, { trail: [1, 2] }), { migrations, targetVersion: 4 });
    if (!result.ok) throw new Error(result.reason);
    expect(result.document["trail"]).toEqual([1, 2, 3]);
  });

  it("never mutates the caller's object", () => {
    const source = fileAt(1) as RawDocument;
    migrateProjectDocument(source, { migrations, targetVersion: 4 });
    expect(source["trail"]).toBeUndefined();
    expect(source["schemaVersion"]).toBe(1);
  });

  it("runs the steps in ladder order even when they are declared out of order", () => {
    const shuffled = [migrations[2], migrations[0], migrations[1]] as DocumentMigration[];
    const result = migrateProjectDocument(fileAt(1), { migrations: shuffled, targetVersion: 4 });
    if (!result.ok) throw new Error(result.reason);
    expect(result.document["trail"]).toEqual([1, 2, 3]);
  });
});

describe("a broken ladder fails loudly and applies nothing", () => {
  it("refuses when a step in the middle is missing", () => {
    const migrations = [step(1, 2, (doc) => void (doc["a"] = true)), step(3, 4, (doc) => void (doc["b"] = true))];
    const result = migrateProjectDocument(fileAt(1), { migrations, targetVersion: 4 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("No migration from schemaVersion 2 to 3");
    expect(result.diagnostics[0]?.code).toBe("project.migration.missing");
  });

  it("refuses when two steps claim the same starting version", () => {
    const migrations = [step(1, 2, () => undefined), step(1, 3, () => undefined)];
    const result = migrateProjectDocument(fileAt(1), { migrations, targetVersion: 3 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.some((d) => d.code === "project.migration.duplicate")).toBe(true);
  });

  it("refuses a step that goes backwards", () => {
    const migrations = [step(2, 1, () => undefined)];
    expect(validateMigrationLadder(migrations).map((d) => d.code)).toContain("project.migration.backwards");
  });

  it("refuses, rather than half-applies, when a step throws", () => {
    const migrations = [
      step(1, 2, (doc) => void (doc["a"] = true)),
      {
        from: 2,
        to: 3,
        description: "explodes",
        migrate: (): RawDocument => {
          throw new Error("field is not what I assumed");
        },
      },
      step(3, 4, (doc) => void (doc["c"] = true)),
    ];
    const source = fileAt(1) as RawDocument;
    const result = migrateProjectDocument(source, { migrations, targetVersion: 4 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("field is not what I assumed");
    // The half-applied clone was discarded; the caller's document is untouched.
    expect(source["a"]).toBeUndefined();
  });

  it("refuses a document with no usable schemaVersion", () => {
    const result = migrateProjectDocument({ name: "Test" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics[0]?.code).toBe("project.migration.noVersion");
  });

  it("refuses anything that is not an object", () => {
    for (const value of [null, 42, "{}", [1, 2, 3]]) {
      expect(migrateProjectDocument(value).ok).toBe(false);
    }
  });
});

describe("§V68: a document from the future is carried through untouched", () => {
  it("does not try to downgrade it, and says so", () => {
    const result = migrateProjectDocument(fileAt(99, { unknownField: "kept" }), { targetVersion: 1 });
    if (!result.ok) throw new Error(result.reason);

    expect(result.newerThanApp).toBe(true);
    expect(result.applied).toEqual([]);
    expect(result.document["schemaVersion"]).toBe(99);
    expect(result.document["unknownField"]).toBe("kept");
    expect(result.diagnostics[0]?.code).toBe("project.schema.newer");
  });
});

/**
 * The first real rung on the ladder (T353, §V297).
 *
 * A field that keeps its NAME and changes its MEANING is the case the scaffolding was
 * built for, and the dangerous half is not the pin that gets carried over — it is the
 * `false` that used to mean "not pinned" and would now mean "preview off". Read literally,
 * every node a user ever pinned and then unpinned would open with a dark slot.
 */
describe("1 → 2: the preview pin becomes the preview switch", () => {
  const documentWith = (ui: Record<string, unknown>): RawDocument => ({
    schemaVersion: 1,
    graph: { nodes: { n1: { id: "n1", type: "solid", ui } } },
  });

  const uiAfter = (ui: Record<string, unknown>): Record<string, unknown> => {
    const result = migrateProjectDocument(documentWith(ui));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    const nodes = (result.document["graph"] as { nodes: Record<string, { ui: Record<string, unknown> }> }).nodes;
    return nodes["n1"]?.ui ?? {};
  };

  it("turns an old pin into `previewPinned` and leaves the switch alone", () => {
    expect(uiAfter({ preview: true })).toEqual({ previewPinned: true });
  });

  it("DROPS an old `false` rather than reading it as 'preview off'", () => {
    // It meant "not pinned", which is the default. Carrying it forward would disable a
    // preview on the strength of a choice the user never made.
    expect(uiAfter({ preview: false, bypassed: true })).toEqual({ bypassed: true });
  });

  it("leaves a document that never mentioned the flag untouched", () => {
    expect(uiAfter({ collapsed: true })).toEqual({ collapsed: true });
  });

  it("survives a graph whose shape is not what it expects", () => {
    for (const broken of [{ schemaVersion: 1 }, { schemaVersion: 1, graph: null }, { schemaVersion: 1, graph: { nodes: 7 } }]) {
      expect(migrateProjectDocument(broken as RawDocument).ok).toBe(true);
    }
  });
});
