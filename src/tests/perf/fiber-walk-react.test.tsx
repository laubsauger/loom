import { act, useState } from "react";
import { describe, expect, it } from "vitest";
import { PERFORMED_WORK, classifyWalk, walkCommit } from "./fiber-walk.ts";
import type { PerfFiber, WalkResult } from "./fiber-walk.ts";

/**
 * T1260 — THE GATE AGAINST CAUSE 1: `PERFORMED_WORK` still being the bit the INSTALLED
 * react-dom sets.
 *
 * The row named two candidates for the harness's empty commit groups, and the first was
 * "React 19's fiber flags moved". They had not; the blank was the walk being switched off
 * for idle windows. But nothing in the tree would have TOLD us if they had — a moved bit
 * makes the walk find nothing, and finding nothing printed the same empty column as
 * measuring nothing. `classifyWalk` now calls that state "blind" at run time; this test
 * makes it fail at BUILD time instead, so a React upgrade that moves the flag turns the
 * suite red rather than quietly hollowing out the next perf report.
 *
 * It works the way the harness does: install the devtools global hook BEFORE react-dom is
 * evaluated (React's `injectInternals` reads it at module scope), render a real component
 * with real react-dom, force a real update, and walk the real fiber root React hands the
 * hook. If `walkCommit` cannot see that render, the walk is broken against this react-dom
 * — which is exactly the fact the harness needs and could not previously state.
 */

interface CommitCapture {
  readonly walks: WalkResult[];
}

/** Installs the hook and imports react-dom afterwards, as `page-hooks.ts` does in the page. */
async function renderWithHook(): Promise<{ capture: CommitCapture; bump: () => void; container: HTMLElement }> {
  const capture: CommitCapture = { walks: [] };
  (globalThis as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown }).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    renderers: new Map<number, unknown>(),
    supportsFiber: true,
    isDisabled: false,
    inject: () => 1,
    checkDCE: () => {},
    onCommitFiberRoot: (_id: number, root: { current: PerfFiber }) => {
      capture.walks.push(walkCommit(root, PERFORMED_WORK));
    },
    onCommitFiberUnmount: () => {},
    onPostCommitFiberRoot: () => {},
    on: () => {},
    off: () => {},
    emit: () => {},
    sub: () => () => {},
  };
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = await import("react-dom/client");

  let bump = (): void => {};
  function Counter(): React.JSX.Element {
    const [n, setN] = useState(0);
    bump = () => {
      setN((value) => value + 1);
    };
    return <span data-testid="counter">{n}</span>;
  }
  function Shell(): React.JSX.Element {
    return (
      <div>
        <Counter />
      </div>
    );
  }

  const container = document.createElement("div");
  document.body.appendChild(container);
  const reactRoot = createRoot(container);
  await act(async () => {
    reactRoot.render(<Shell />);
  });
  return { capture, bump: () => bump(), container };
}

describe("walkCommit against the installed react-dom", () => {
  it("sees a component React actually re-rendered — the flag bit is still PERFORMED_WORK", async () => {
    const { capture, bump, container } = await renderWithHook();
    expect(capture.walks.length).toBeGreaterThan(0);
    const mountWalk = capture.walks.length;

    // A state update in `Counter` and nothing else. React MUST render `Counter`; the DOM
    // proves it did, so a walk that reports no `Counter` is the instrument, not the app.
    await act(async () => {
      bump();
    });

    expect(container.querySelector('[data-testid="counter"]')?.textContent).toBe("1");
    const updates = capture.walks.slice(mountWalk);
    expect(updates.length).toBeGreaterThan(0);
    const counterRenders = updates.reduce((sum, walk) => sum + (walk.counts["Counter"] ?? 0), 0);
    expect(counterRenders).toBeGreaterThan(0);

    // And the harness's own verdict on those commits must be "measured", never "blind":
    // this is the assertion that goes red if a React upgrade moves the flag.
    expect(classifyWalk(updates.map((walk) => walk.performed)).kind).toBe("measured");
  });

  it("does not report the untouched part of the tree as re-rendered", async () => {
    // The other half of trusting the number: the walk must not count `Shell`, which bailed
    // out. Over-counting is how this walk failed before the clone rule (every commit
    // "rendered" the whole canvas), and an over-counting walk can never go blind, so the
    // blind check alone would not catch it.
    const { capture, bump } = await renderWithHook();
    const mountWalk = capture.walks.length;

    await act(async () => {
      bump();
    });

    const updates = capture.walks.slice(mountWalk);
    const shellRenders = updates.reduce((sum, walk) => sum + (walk.counts["Shell"] ?? 0), 0);
    expect(shellRenders).toBe(0);
  });
});
