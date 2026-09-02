import { describe, expect, it } from "vitest";
import { listExamples, listStarterComponentFiles } from "./catalogue.ts";

/**
 * §T897's class gate: zero `driven` bindings in anything we ship. The mode is retired —
 * a channel read is an expression term (`op('name').chan.low`) — and the builders emit
 * the expression form directly, so a driven slot reappearing in a regenerated loom means
 * a builder or a hand-rolled slot regressed past the migration. Wild documents still
 * PARSE driven (the load-time upgrade owns them); shipping one would teach the old form
 * by example.
 */
describe("no shipped file carries a driven binding (§T897)", () => {
  const files = [...listExamples(), ...listStarterComponentFiles()];

  it("sweeps every shipped loom", () => {
    expect(files.length).toBeGreaterThan(40); // the guard on the guard
  });

  it.each(files.map((file) => file.fileName))("%s emits no driven mode or binding", (fileName) => {
    const file = files.find((entry) => entry.fileName === fileName);
    expect(file).toBeDefined();
    expect(file?.text.includes('"mode": "driven"')).toBe(false);
    expect(file?.text.includes('"kind": "driven"')).toBe(false);
  });
});
