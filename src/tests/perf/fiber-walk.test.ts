import { describe, expect, it } from "vitest";
import {
  PERFORMED_WORK,
  assertWalkNotBlind,
  classifyWalk,
  normaliseLegacyPerformed,
  walkCommit,
  walkVerdictLine,
} from "./fiber-walk.ts";
import type { PerfFiber } from "./fiber-walk.ts";

/**
 * T1260 — the perf harness reported blank `renders`/`signatures` columns for every idle
 * window, and the blank could not be read: it meant "the walk was off for this window",
 * and it would have meant exactly the same thing had React's `PerformedWork` bit moved and
 * the walk gone blind. WHY THAT MATTERS: the whole §T1235 perf tree, and every "we made it
 * faster" claim built on it, is read off these columns. A number that is missing must not
 * look like a number that is zero, because a reader takes zero as evidence.
 *
 * These tests are the browser-free half of that: the SAME `walkCommit` the harness injects
 * into the page, run over a hand-built fiber tree, plus the classifier that decides what a
 * window's records mean. `page-hooks.ts` injects `walkCommit.toString()`, so a walk that
 * passes here is the walk Chromium runs.
 */

interface MutableFiber {
  child: MutableFiber | null;
  sibling: MutableFiber | null;
  alternate: MutableFiber | null;
  flags: number;
  type: unknown;
  tag: number;
}

/** A fiber with a component name, React's own shape: `type` is the function/class. */
function fiber(name: string, options: { flags?: number; child?: MutableFiber | null; sibling?: MutableFiber | null } = {}): MutableFiber {
  return {
    child: options.child ?? null,
    sibling: options.sibling ?? null,
    alternate: null,
    flags: options.flags ?? 0,
    type: { name },
    tag: 0,
  };
}

/**
 * React hands `onCommitFiberRoot` the FiberRoot, whose `current` is the HostRoot — the
 * walk starts at `current.child`, so the tree under test hangs one level down, exactly as
 * it does in the page.
 */
const root = (tree: MutableFiber): { current: PerfFiber } => ({ current: fiber("HostRoot", { child: tree }) as PerfFiber });

describe("walkCommit", () => {
  it("counts every fiber React marked PerformedWork, by component name", () => {
    // HostRoot's child is the tree of this commit: two CostCells and a ValuePlot rendered,
    // a Presence did not.
    const tree = fiber("App", {
      child: fiber("CostCell", {
        flags: PERFORMED_WORK,
        sibling: fiber("CostCell", {
          flags: PERFORMED_WORK,
          sibling: fiber("ValuePlot", { flags: PERFORMED_WORK, sibling: fiber("Presence", { flags: 0 }) }),
        }),
      }),
      flags: PERFORMED_WORK,
    });

    const result = walkCommit(root(tree), PERFORMED_WORK);

    expect(result.performed).toBe(4);
    expect(result.counts).toEqual({ App: 1, CostCell: 2, ValuePlot: 1 });
    expect(result.signature).toBe("CostCell×2 App×1 ValuePlot×1");
  });

  it("does not descend into a subtree React did not clone — that subtree's flags are LAST commit's", () => {
    // The bug this rule exists for: a bailed-out subtree keeps its previous fibers, whose
    // PerformedWork bits are stale. Counting them made every commit "render" the whole
    // canvas. `child === alternate.child` is how a bail-out is recognised.
    const staleChild = fiber("NodeIdentity", { flags: PERFORMED_WORK, sibling: fiber("NodeIdentity", { flags: PERFORMED_WORK }) });
    const bailed = fiber("Canvas", { flags: 0, child: staleChild });
    bailed.alternate = { ...bailed, child: staleChild };
    const tree = fiber("App", { flags: PERFORMED_WORK, child: bailed });

    const result = walkCommit(root(tree), PERFORMED_WORK);

    // App rendered; the two stale NodeIdentity fibers behind the bail-out did not.
    expect(result.performed).toBe(1);
    expect(result.counts).toEqual({ App: 1 });
  });

  it("does descend where the child pointer changed against the alternate", () => {
    // Same shape as the bail-out, one difference: the subtree WAS re-rendered, so its
    // child pointer is a new object. If the rule above swallowed this, the harness would
    // under-report every real render instead of over-reporting bail-outs.
    const fresh = fiber("CostCell", { flags: PERFORMED_WORK });
    const rendered = fiber("Canvas", { flags: PERFORMED_WORK, child: fresh });
    rendered.alternate = { ...rendered, child: fiber("CostCell", { flags: PERFORMED_WORK }) };
    const tree = fiber("App", { flags: PERFORMED_WORK, child: rendered });

    const result = walkCommit(root(tree), PERFORMED_WORK);

    expect(result.performed).toBe(3);
    expect(result.counts).toEqual({ App: 1, Canvas: 1, CostCell: 1 });
  });

  it("goes blind on the wrong flag bit — the failure mode T1260 had to be able to see", () => {
    // This is the red-verify in miniature: hand the same provably-rendering tree a bit
    // React does not use and the walk reports nothing. The point is not that it reports
    // nothing (it must), it is that `classifyWalk` below calls that nothing BLIND.
    const tree = fiber("App", { flags: PERFORMED_WORK, child: fiber("CostCell", { flags: PERFORMED_WORK }) });

    // Derived from the real bit rather than written as a literal, so it stays a DIFFERENT
    // bit whatever `PERFORMED_WORK` is set to — a literal silently stops being wrong the
    // moment someone changes the constant to it.
    const withRealBit = walkCommit(root(tree), PERFORMED_WORK);
    const withWrongBit = walkCommit(root(tree), PERFORMED_WORK << 4);

    expect(withRealBit.performed).toBe(2);
    expect(withWrongBit.performed).toBe(0);
    expect(withWrongBit.signature).toBe("");
  });

  it("names host fibers and anonymous fibers rather than dropping them", () => {
    const host: MutableFiber = { child: null, sibling: null, alternate: null, flags: PERFORMED_WORK, type: "div", tag: 5 };
    const anonymous: MutableFiber = { child: null, sibling: null, alternate: null, flags: PERFORMED_WORK, type: null, tag: 13 };
    host.sibling = anonymous;
    const tree = fiber("App", { flags: 0, child: host });

    const result = walkCommit(root(tree), PERFORMED_WORK);

    expect(result.counts).toEqual({ "<div>": 1, "#13": 1 });
  });
});

describe("classifyWalk — a missing number and a zero are different facts", () => {
  it("calls a window whose commits were never walked NOT MEASURED, not zero", () => {
    // The literal T1260 blank: scenarios A and B run with the walk off so its cost stays
    // out of the frame budget they exist to measure. 237 commits happened; none were
    // looked at. Reporting that as "0 renders" would be a lie about the app.
    const verdict = classifyWalk(Array.from({ length: 237 }, () => null));

    expect(verdict).toEqual({ kind: "not-walked", commits: 237 });
    expect(walkVerdictLine(verdict)).toMatch(/NOT MEASURED/);
    expect(walkVerdictLine(verdict)).toContain("237 commits");
    // And it must not stop the run: an unwalked window is the harness working as designed.
    expect(() => assertWalkNotBlind("A idle", verdict)).not.toThrow();
  });

  it("calls a WALKED window that found nothing BLIND, and stops the run", () => {
    // React does not commit a root without rendering something. If the walk ran over real
    // commits and saw not one flagged fiber, the instrument is broken — the flag bit moved,
    // or the hook is being handed something that is not a fiber root. This is the case that
    // used to print an empty column indistinguishable from the one above.
    const verdict = classifyWalk([0, 0, 0, 0]);

    expect(verdict).toEqual({ kind: "blind", commits: 4 });
    expect(walkVerdictLine(verdict)).toMatch(/BLIND/);
    expect(() => assertWalkNotBlind("C knob drag", verdict)).toThrow(/BLIND/);
  });

  it("does not call an empty window blind — no commits is no claim", () => {
    const verdict = classifyWalk([]);

    expect(verdict).toEqual({ kind: "no-commits" });
    expect(() => assertWalkNotBlind("B paused", verdict)).not.toThrow();
  });

  it("reports a walked window that saw work, counting only the commits it looked at", () => {
    // A probe window can hold both: commits from before the walk was switched on (null)
    // and commits after (numbers). The verdict must describe the walked ones.
    const verdict = classifyWalk([null, 16, 0, 234]);

    expect(verdict).toEqual({ kind: "measured", commits: 4, walked: 3, fibers: 250 });
    expect(walkVerdictLine(verdict)).toBe("3 of 4 commits walked, 250 fibers rendered");
    expect(() => assertWalkNotBlind("A probe", verdict)).not.toThrow();
  });

  it("reads a pre-T1260 run's -1 sentinel back as not-measured, not as a fiber count", () => {
    // Harness output is kept and re-summarised. Without this, an old file's -1s sum to a
    // negative and classify as "measured" — a third wrong answer from the same ambiguity.
    const legacy = [-1, -1, -1].map(normaliseLegacyPerformed);

    expect(legacy).toEqual([null, null, null]);
    expect(classifyWalk(legacy)).toEqual({ kind: "not-walked", commits: 3 });
  });
});
