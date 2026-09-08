import type { Page } from "@playwright/test";

/**
 * What the harness plants in the page before the app loads (T1235).
 *
 * 1. A minimal React DevTools hook. React's `injectInternals` looks for
 *    `__REACT_DEVTOOLS_GLOBAL_HOOK__` at module-evaluation time and, when it has
 *    `supportsFiber`, calls `onCommitFiberRoot(rendererId, root)` after every commit.
 *    That is the one place a commit can be COUNTED and its fibers walked without
 *    touching app code. The walk is gated (`window.__perf.walk`) because it is not free
 *    and its own cost must not land in the idle scenarios; when on, it counts every
 *    fiber that carries `PerformedWork` (flags & 1) by component name.
 * 2. Two CPU-spin references of fixed WORK (iteration counts, not durations), §V929's
 *    "two references of different cost in the same run". Their reading is the machine's
 *    speed at that moment; the harness takes them before every block.
 *
 * Every function here is named `__perf…` so the trace parser can charge its samples to
 * `harness` rather than to the app.
 */
export async function installPageHooks(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const perf = {
      commits: [] as Array<{ t: number; actualDuration: number; performed: number; signature: string }>,
      walk: false,
      renders: new Map<string, number>(),
      spins: { cheap: [] as number[], dear: [] as number[] },
    };
    (window as unknown as { __perf: typeof perf }).__perf = perf;

    function __perfNameOf(fiber: { type: unknown; tag: number }): string {
      const type = fiber.type as { displayName?: string; name?: string; render?: { name?: string }; type?: { name?: string } } | string | null;
      if (type === null || type === undefined) return `#${fiber.tag}`;
      if (typeof type === "string") return `<${type}>`;
      return type.displayName ?? type.name ?? type.render?.name ?? type.type?.name ?? `#${fiber.tag}`;
    }

    /*
     * Which fibers did work in THIS commit. Two facts make this more than a flag check:
     * a fiber's flags are reset when it is cloned for a new render, but a subtree with
     * no pending work is NOT cloned — the new fiber keeps pointing at the old children,
     * whose PerformedWork bit is whatever their LAST render left. So the walk descends
     * only where the child pointer changed against the alternate (the rule React
     * DevTools uses), and counts PerformedWork inside that. Measured without the rule:
     * every commit "rendered" ~1750 fibers, the whole canvas, which was the stale bit.
     */
    interface Fiber {
      child: Fiber | null;
      sibling: Fiber | null;
      alternate: Fiber | null;
      flags: number;
      type: unknown;
      tag: number;
    }
    function __perfWalk(root: { current: Fiber }): { performed: number; signature: string } {
      let performed = 0;
      const local = new Map<string, number>();
      const stack: Fiber[] = [];
      if (root.current.child) stack.push(root.current.child);
      while (stack.length > 0) {
        const fiber = stack.pop()!;
        if ((fiber.flags & 1) !== 0) {
          performed += 1;
          const name = __perfNameOf(fiber);
          local.set(name, (local.get(name) ?? 0) + 1);
        }
        if (fiber.sibling) stack.push(fiber.sibling);
        const cloned = fiber.alternate === null || fiber.child !== fiber.alternate.child;
        if (fiber.child && cloned) stack.push(fiber.child);
      }
      for (const [name, count] of local) perf.renders.set(name, (perf.renders.get(name) ?? 0) + count);
      // The commit's "shape": its three most-rendered components, so commits can be
      // grouped by what kind of update they were.
      const signature = [...local]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([name, count]) => `${name}×${count}`)
        .join(" ");
      return { performed, signature };
    }

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
      onCommitFiberRoot(_id: number, root: { current: Fiber & { actualDuration?: number } }): void {
        const walked = perf.walk ? __perfWalk(root) : { performed: -1, signature: "" };
        perf.commits.push({ t: performance.now(), actualDuration: root.current.actualDuration ?? Number.NaN, ...walked });
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
  });
}

export interface CommitRecord {
  readonly t: number;
  readonly actualDuration: number;
  readonly performed: number;
  readonly signature: string;
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
