import { describe, expect, it } from "vitest";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import { MAX_RETAINED_DIAGNOSTICS, retainDiagnostic } from "./diagnostic-buffer.ts";

/**
 * T596 — the retained diagnostics buffer, and why `slice(-50)` was a log that lies.
 *
 * The backend's hub re-emits a condition that is STILL TRUE once per second, forever,
 * with a running "(N repeat(s) suppressed)" count (T99) — measured live at ~1 every 2s on
 * a graph with one bad preview pass. A ring that appends every report therefore spends all
 * fifty of its slots on one sentence inside a minute and EVICTS every distinct diagnostic
 * behind it. From the outside the log saturates at fifty and stops moving; an agent
 * polling it reads a minute-old warning as the current state, which is what happened to
 * the session that reported this, twice.
 *
 * The property gated here is what a bounded log is for: FIFTY SLOTS HOLD FIFTY DISTINCT
 * CONDITIONS. It fails against the old implementation on the first test — that is the
 * sensitivity (§V461) — and the last two tests are the controls that stop the collapse
 * from becoming over-eager and swallowing information of its own.
 */

const warn = (code: string, message: string, nodeId?: string): RuntimeDiagnostic => ({
  severity: "warning",
  code,
  message,
  ...(nodeId === undefined ? {} : { nodeId }),
});

const codes = (entries: readonly RuntimeDiagnostic[]) => entries.map((entry) => entry.code);

describe("retainDiagnostic (T596)", () => {
  it("a flood of ONE repeating condition does not evict the distinct ones", () => {
    let buffer: readonly RuntimeDiagnostic[] = [];
    for (let i = 0; i < 40; i += 1) buffer = retainDiagnostic(buffer, warn(`distinct-${i}`, `problem ${i}`));

    // The hub's shape exactly: same condition, message growing a suppressed count.
    for (let repeat = 1; repeat <= 500; repeat += 1) {
      buffer = retainDiagnostic(
        buffer,
        warn("backend/unknown-resource", `Pass "p" binds unknown texture "t" (${repeat} repeat(s) suppressed)`),
      );
    }

    // 40 distinct + 1 for the flood. Under `[...current, entry].slice(-50)` the forty are
    // long gone and every slot reads the same sentence.
    expect(buffer).toHaveLength(41);
    expect(codes(buffer).filter((code) => code.startsWith("distinct-"))).toHaveLength(40);
    expect(codes(buffer).filter((code) => code === "backend/unknown-resource")).toHaveLength(1);
  });

  it("keeps the NEWEST report of a repeating condition, and dates it last", () => {
    let buffer: readonly RuntimeDiagnostic[] = [];
    buffer = retainDiagnostic(buffer, warn("backend/x", "the device is unhappy"));
    buffer = retainDiagnostic(buffer, warn("other", "something else"));
    buffer = retainDiagnostic(buffer, warn("backend/x", "the device is unhappy (7 repeat(s) suppressed)"));

    // How many times and how recently both have to survive the collapse, or the one entry
    // left is less informative than the fifty it replaced.
    expect(buffer.map((entry) => entry.message)).toEqual([
      "something else",
      "the device is unhappy (7 repeat(s) suppressed)",
    ]);
  });

  it("still bounds an unbounded stream of DISTINCT conditions, newest kept", () => {
    // The bound is not softened: a genuinely varied stream still cannot grow the heap.
    let buffer: readonly RuntimeDiagnostic[] = [];
    for (let i = 0; i < 200; i += 1) buffer = retainDiagnostic(buffer, warn(`c-${i}`, `m ${i}`));
    expect(buffer).toHaveLength(MAX_RETAINED_DIAGNOSTICS);
    expect(buffer[buffer.length - 1]?.code).toBe("c-199");
    expect(buffer[0]?.code).toBe(`c-${200 - MAX_RETAINED_DIAGNOSTICS}`);
  });

  it("does NOT collapse two different messages under one code", () => {
    // The hub's own rule, kept: two invalid passes in one compile are two conditions and
    // both must stay. A collapse keyed on the code alone would lose one of them, which is
    // the failure this fix would otherwise have introduced.
    let buffer: readonly RuntimeDiagnostic[] = [];
    buffer = retainDiagnostic(buffer, warn("compiler/bad-pass", "pass A is invalid"));
    buffer = retainDiagnostic(buffer, warn("compiler/bad-pass", "pass B is invalid"));
    expect(buffer).toHaveLength(2);
  });

  it("does NOT collapse the same message reported against different nodes", () => {
    let buffer: readonly RuntimeDiagnostic[] = [];
    buffer = retainDiagnostic(buffer, warn("node/stale", "output is stale", "nd_1"));
    buffer = retainDiagnostic(buffer, warn("node/stale", "output is stale", "nd_2"));
    expect(buffer).toHaveLength(2);
  });
});
