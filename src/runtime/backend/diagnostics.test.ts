import { describe, expect, it } from "vitest";

import { BackendDiagnosticCode, backendDiagnostic, createDiagnosticHub } from "./diagnostics.ts";

/**
 * T99: a per-frame diagnostic (stale-plan warning at 60fps, a failing pass) must not
 * flood listeners or the log. Identical repeats inside the window are counted and
 * summarized; distinct messages always surface, because two different invalid passes in
 * one compile are two findings, not a repeat.
 */

describe("diagnostic hub dedupe", () => {
  const warn = (message: string) =>
    backendDiagnostic("warning", BackendDiagnosticCode.planNotCurrent, message);

  it("collapses identical repeats inside the window", () => {
    let clock = 0;
    const hub = createDiagnosticHub({ now: () => clock });
    const seen: string[] = [];
    hub.subscribe((d) => seen.push(d.message));

    for (let i = 0; i < 60; i += 1) {
      clock = i * 16;
      hub.report(warn("frame skipped"));
    }

    expect(seen).toEqual(["frame skipped"]);
    expect(hub.log).toHaveLength(1);
  });

  it("summarizes the suppressed count once the window reopens", () => {
    let clock = 0;
    const hub = createDiagnosticHub({ now: () => clock });
    const seen: string[] = [];
    hub.subscribe((d) => seen.push(d.message));

    hub.report(warn("frame skipped"));
    clock = 500;
    hub.report(warn("frame skipped"));
    hub.report(warn("frame skipped"));
    clock = 1500;
    hub.report(warn("frame skipped"));

    expect(seen).toEqual(["frame skipped", "frame skipped (2 repeat(s) suppressed)"]);
  });

  it("never suppresses distinct messages sharing a code", () => {
    const hub = createDiagnosticHub({ now: () => 0 });
    const seen: string[] = [];
    hub.subscribe((d) => seen.push(d.message));

    hub.report(warn('pass "a" is invalid'));
    hub.report(warn('pass "b" is invalid'));

    expect(seen).toHaveLength(2);
  });

  it("treats the same message on different nodes as distinct", () => {
    const hub = createDiagnosticHub({ now: () => 0 });
    const seen: number[] = [];
    hub.subscribe(() => seen.push(1));

    hub.report({ severity: "error", code: "x", message: "boom", nodeId: "node-1" });
    hub.report({ severity: "error", code: "x", message: "boom", nodeId: "node-2" });

    expect(seen).toHaveLength(2);
  });
});
