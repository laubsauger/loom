import type { Page } from "@playwright/test";
import { PERFORMED_WORK, walkCommit } from "../../perf/fiber-walk.ts";
import type { PerfFiber, WalkResult } from "../../perf/fiber-walk.ts";

/**
 * What the harness plants in the page before the app loads (T1235).
 *
 * 1. A minimal React DevTools hook. React's `injectInternals` looks for
 *    `__REACT_DEVTOOLS_GLOBAL_HOOK__` at module-evaluation time and, when it has
 *    `supportsFiber`, calls `onCommitFiberRoot(rendererId, root)` after every commit.
 *    That is the one place a commit can be COUNTED and its fibers walked without
 *    touching app code. The walk is gated (`window.__perf.walk`) because it is not free
 *    and its own cost must not land in the idle scenarios; when on, it counts every
 *    fiber that carries `PerformedWork` by component name.
 * 2. Two CPU-spin references of fixed WORK (iteration counts, not durations), §V929's
 *    "two references of different cost in the same run". Their reading is the machine's
 *    speed at that moment; the harness takes them before every block.
 *
 * Every function here is named `__perf…` so the trace parser can charge its samples to
 * `harness` rather than to the app.
 *
 * ⚠ T1260 — WHEN THE WALK IS OFF, `performed` AND `signature` ARE `null`, NOT `-1`/`""`.
 * The gate above means most windows carry no render counts, and the old sentinels made
 * "not measured" indistinguishable from "measured, found nothing" by the time the numbers
 * reached the report. Nothing downstream may collapse the two again.
 */
export async function installPageHooks(page: Page): Promise<void> {
  /*
   * The walk itself is injected as SOURCE (T1260): an init script is serialised, so it
   * cannot close over an import, and duplicating the walk inline would leave the version
   * `fiber-walk.test.ts` proves and the version the browser runs free to drift apart.
   * This script runs before the one below, which reads the function off the window.
   */
  await page.addInitScript({ content: `window.__perfWalkCommit = ${walkCommit.toString()};` });
  await page.addInitScript((performedWorkBit: number) => {
    const perf = {
      commits: [] as Array<{ t: number; actualDuration: number; performed: number | null; signature: string | null }>,
      walk: false,
      renders: new Map<string, number>(),
      spins: { cheap: [] as number[], dear: [] as number[] },
    };
    (window as unknown as { __perf: typeof perf }).__perf = perf;

    type Walker = (root: { current: PerfFiber }, bit: number) => WalkResult;
    const __perfWalk = (window as unknown as { __perfWalkCommit: Walker }).__perfWalkCommit;

    const hook = {
      renderers: new Map<number, unknown>(),
      supportsFiber: true,
      isDisabled: false,
      inject(renderer: unknown): number {
        const id = hook.renderers.size + 1;
        hook.renderers.set(id, renderer);
        return id;
      },
      checkDCE(): void {},
      onCommitFiberRoot(_id: number, root: { current: PerfFiber & { actualDuration?: number } }): void {
        const walked = perf.walk ? __perfWalk(root, performedWorkBit) : null;
        if (walked !== null) {
          for (const [name, count] of Object.entries(walked.counts)) perf.renders.set(name, (perf.renders.get(name) ?? 0) + count);
        }
        perf.commits.push({
          t: performance.now(),
          actualDuration: root.current.actualDuration ?? Number.NaN,
          performed: walked === null ? null : walked.performed,
          signature: walked === null ? null : walked.signature,
        });
      },
      onCommitFiberUnmount(): void {},
      onPostCommitFiberRoot(): void {},
      on(): void {},
      off(): void {},
      emit(): void {},
      sub(): () => void {
        return () => {};
      },
    };
    (window as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__: typeof hook }).__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;

    // Fixed work: a float loop the optimiser cannot fold (the result is published).
    function __perfSpin(iterations: number): number {
      const start = performance.now();
      let acc = 0.5;
      for (let index = 0; index < iterations; index += 1) acc = acc * 1.0000001 + Math.sin(index) * 1e-9;
      (window as unknown as { __perfSink: number }).__perfSink = acc;
      return performance.now() - start;
    }
    (window as unknown as { __perfSpin: typeof __perfSpin }).__perfSpin = __perfSpin;
  }, PERFORMED_WORK);
}

export interface CommitRecord {
  readonly t: number;
  readonly actualDuration: number;
  /** Fibers that carried `PerformedWork`, or `null` when the walk was off (T1260). */
  readonly performed: number | null;
  /** The commit's shape, `""` when nothing rendered, `null` when the walk was off. */
  readonly signature: string | null;
}

/** Drains the commit log and the per-component render counts collected since the last drain. */
export async function drainReactCounts(page: Page): Promise<{ commits: CommitRecord[]; renders: Record<string, number> }> {
  return page.evaluate(() => {
    const perf = (window as unknown as { __perf: { commits: CommitRecord[]; renders: Map<string, number> } }).__perf;
    const commits = perf.commits.splice(0);
    const renders = Object.fromEntries(perf.renders);
    perf.renders.clear();
    return { commits, renders };
  });
}

export async function setFiberWalk(page: Page, on: boolean): Promise<void> {
  await page.evaluate((flag) => {
    (window as unknown as { __perf: { walk: boolean } }).__perf.walk = flag;
  }, on);
}

/** Iteration counts chosen so the pair reads ≈1 ms and ≈20 ms on the reference machine. */
export const SPIN_CHEAP = 60_000;
export const SPIN_DEAR = 1_200_000;

export interface ControlReading {
  readonly cheapMs: number[];
  readonly dearMs: number[];
}

/** The two references, five times each, read in the page. */
export async function readControls(page: Page): Promise<ControlReading> {
  return page.evaluate(
    ({ cheap, dear }) => {
      const spin = (window as unknown as { __perfSpin: (n: number) => number }).__perfSpin;
      const cheapMs: number[] = [];
      const dearMs: number[] = [];
      for (let index = 0; index < 5; index += 1) {
        cheapMs.push(spin(cheap));
        dearMs.push(spin(dear));
      }
      return { cheapMs, dearMs };
    },
    { cheap: SPIN_CHEAP, dear: SPIN_DEAR },
  );
}
