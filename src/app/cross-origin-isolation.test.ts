import { describe, expect, it } from "vitest";

import { decideIsolationStep } from "./cross-origin-isolation.ts";
import type { IsolationEnvironment } from "./cross-origin-isolation.ts";

/**
 * T1048 — the reload budget, stated as a table nobody can widen by accident.
 *
 * ## What is actually at stake
 *
 * `decideIsolationStep` is the only thing standing between "one reload on the first hosted
 * visit" and "a page that reloads forever". A reload loop is not a slow page; it is a site
 * that cannot be used at all, and it appears only in the deployment this repo cannot run
 * locally — so the budget is proved here, by enumeration, rather than watched for in
 * production. `src/tests/e2e/cross-origin-isolation.spec.ts` then counts real document
 * loads in a real Chromium against a header-less server, which is the other half: this
 * file proves the decision, that one proves the wiring around it.
 *
 * ## Why the whole environment space, and not the interesting rows
 *
 * The dangerous input is not one row, it is the SHAPE of the space: `register` — the only
 * branch that reloads — must be unreachable whenever the tab has already spent its reload,
 * for every combination of the other flags. A test of three hand-picked cases proves
 * nothing about the fourth, and the space is 32 rows, so it is walked in full.
 */

const FLAGS = ["isolated", "hosted", "serviceWorkers", "canRemember", "reloadAttempted"] as const;

/** All 2^5 environments. */
function everyEnvironment(): IsolationEnvironment[] {
  const rows: IsolationEnvironment[] = [];
  for (let bits = 0; bits < 1 << FLAGS.length; bits += 1) {
    const row: Record<string, boolean> = {};
    FLAGS.forEach((flag, index) => {
      row[flag] = (bits & (1 << index)) !== 0;
    });
    rows.push(row as unknown as IsolationEnvironment);
  }
  return rows;
}

describe("T1048 — the isolation shim reloads at most once, and never in development", () => {
  it("never asks to register once a reload has already been attempted — all 16 such rows", () => {
    const spent = everyEnvironment().filter((row) => row.reloadAttempted);
    expect(spent).toHaveLength(16);
    for (const row of spent) {
      // This is the loop proof's first half. `armCrossOriginIsolation` writes the flag
      // BEFORE calling `location.reload()`, so the load that follows a reload always
      // arrives with `reloadAttempted: true` — and no such load may ask for another one.
      expect(decideIsolationStep(row).kind, JSON.stringify(row)).not.toBe("register");
    }
  });

  it("asks to register on exactly one shape: hosted, un-isolated, capable, and unspent", () => {
    const asking = everyEnvironment().filter((row) => decideIsolationStep(row).kind === "register");
    expect(asking).toEqual([
      {
        isolated: false,
        hosted: true,
        serviceWorkers: true,
        canRemember: true,
        reloadAttempted: false,
      },
    ]);
  });

  it("does nothing at all in a dev build, even when the dev page is somehow un-isolated", () => {
    // The requirement is not "dev happens to be isolated so the branch is unreachable" —
    // it is that local work must never depend on a service worker or inherit the reload.
    // So the dev answer has to hold with `isolated: false`, which is the case this asserts.
    expect(
      decideIsolationStep({
        isolated: false,
        hosted: false,
        serviceWorkers: true,
        canRemember: true,
        reloadAttempted: false,
      }),
    ).toEqual({ kind: "not-hosted" });
  });

  it("stands down rather than reloading when a reload could not be remembered", () => {
    // Storage that throws (private windows, blocked site data) is the ONLY way a reload
    // could repeat, because the flag is where "already tried" lives. So it disables the
    // attempt instead of proceeding hopefully.
    const step = decideIsolationStep({
      isolated: false,
      hosted: true,
      serviceWorkers: true,
      canRemember: false,
      reloadAttempted: false,
    });
    expect(step.kind).toBe("unsupported");
    expect(step.kind === "unsupported" && step.why).toContain("sessionStorage");
  });

  it("degrades to the un-isolated page where service workers do not exist", () => {
    const step = decideIsolationStep({
      isolated: false,
      hosted: true,
      serviceWorkers: false,
      canRemember: true,
      reloadAttempted: false,
    });
    expect(step.kind).toBe("unsupported");
    expect(step.kind === "unsupported" && step.why).toContain("navigator.serviceWorker");
  });

  it("says gave-up — not isolated — when the shim ran and the page is still not isolated", () => {
    // §V827's rule applied to this feature: a shim that fails must SAY it failed. The
    // boot path turns this into a console warning and the node info popup keeps reporting
    // the worker's own measurement, so nothing anywhere claims threads it does not have.
    const step = decideIsolationStep({
      isolated: false,
      hosted: true,
      serviceWorkers: true,
      canRemember: true,
      reloadAttempted: true,
    });
    expect(step.kind).toBe("gave-up");
  });

  it("returns isolated whenever the page already is, so a host with real headers is left alone", () => {
    const isolatedRows = everyEnvironment().filter((row) => row.isolated);
    for (const row of isolatedRows) {
      expect(decideIsolationStep(row)).toEqual({ kind: "isolated" });
    }
  });
});
