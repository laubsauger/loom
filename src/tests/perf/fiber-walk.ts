/**
 * The perf harness's React commit walk, and the one place that decides what a MISSING
 * render count means (T1235 for the walk, T1260 for the meaning).
 *
 * `walkCommit` lives here rather than inline in `page-hooks.ts`'s init script for one
 * reason: an init script is serialised to source, so anything it uses must be
 * self-contained — and a function that is self-contained can also be run in node against
 * a synthetic fiber tree. `page-hooks.ts` injects `walkCommit.toString()`; `fiber-walk.test.ts`
 * imports and calls it. Both exercise THE SAME function, so a test that says the walk can
 * see PerformedWork is a statement about the walk the browser runs.
 *
 * ⚠ `walkCommit` must stay free of imports, module-scope references and closures — it is
 * `toString()`d into a page that has none of them. That is why the flag bit arrives as an
 * argument instead of reading `PERFORMED_WORK` directly.
 *
 * §T1260's actual bug was never the walk: it was that "the walk was off for this window"
 * and "the walk ran and found nothing" reached the report as the SAME empty cell, and a
 * third state — "the walk ran and can no longer see" — would have printed the same empty
 * cell too. `classifyWalk` makes the three distinguishable and `assertWalkNotBlind` makes
 * the third fatal (§V936: the check is what makes the number safe — do not skip it).
 */

/**
 * React's `PerformedWork` flag: `0b1` in `ReactFiberFlags.js`, set by `beginWork` on every
 * fiber that actually rendered. Verified against the INSTALLED react-dom (19.2.8): five
 * `workInProgress.flags |= 1` sites in `react-dom-client.development.js`, all of them in
 * the function/class/memo `beginWork` paths, each guarded by `didReceiveUpdate`.
 */
export const PERFORMED_WORK = 1;

/** The subset of a React fiber the walk touches. */
export interface PerfFiber {
  readonly child: PerfFiber | null;
  readonly sibling: PerfFiber | null;
  readonly alternate: PerfFiber | null;
  readonly flags: number;
  readonly type: unknown;
  readonly tag: number;
}

export interface WalkResult {
  /** How many fibers carried `PerformedWork` in this commit. */
  readonly performed: number;
  /** The commit's shape: its three most-rendered components, so commits group by kind. */
  readonly signature: string;
  /** Per-component render counts for this commit. */
  readonly counts: Record<string, number>;
}

/*
 * Which fibers did work in THIS commit. Two facts make this more than a flag check: a
 * fiber's flags are reset when it is cloned for a new render, but a subtree with no
 * pending work is NOT cloned — the new fiber keeps pointing at the old children, whose
 * PerformedWork bit is whatever their LAST render left. So the walk descends only where
 * the child pointer changed against the alternate (the rule React DevTools uses), and
 * counts PerformedWork inside that. Measured without the rule: every commit "rendered"
 * ~1750 fibers, the whole canvas, which was the stale bit.
 */
export function walkCommit(root: { readonly current: PerfFiber }, performedWorkBit: number): WalkResult {
  function nameOf(fiber: PerfFiber): string {
    const type = fiber.type as { displayName?: string; name?: string; render?: { name?: string }; type?: { name?: string } } | string | null;
    if (type === null || type === undefined) return `#${fiber.tag}`;
    if (typeof type === "string") return `<${type}>`;
    return type.displayName ?? type.name ?? type.render?.name ?? type.type?.name ?? `#${fiber.tag}`;
  }
  let performed = 0;
  const counts: Record<string, number> = {};
  const stack: PerfFiber[] = [];
  if (root.current.child) stack.push(root.current.child);
  while (stack.length > 0) {
    const fiber = stack.pop()!;
    if ((fiber.flags & performedWorkBit) !== 0) {
      performed += 1;
      const name = nameOf(fiber);
      counts[name] = (counts[name] ?? 0) + 1;
    }
    if (fiber.sibling) stack.push(fiber.sibling);
    const cloned = fiber.alternate === null || fiber.child !== fiber.alternate.child;
    if (fiber.child && cloned) stack.push(fiber.child);
  }
  const signature = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, count]) => `${name}×${count}`)
    .join(" ");
  return { performed, signature, counts };
}

/**
 * What a window's commit records are actually telling us. `null` in `performed` means the
 * walk was OFF for that commit — the idle scenarios run it off so its cost cannot land in
 * the frame numbers they exist to measure — and that is a different fact from a zero.
 */
export type WalkVerdict =
  | { readonly kind: "no-commits" }
  | { readonly kind: "not-walked"; readonly commits: number }
  | { readonly kind: "blind"; readonly commits: number }
  | { readonly kind: "measured"; readonly commits: number; readonly walked: number; readonly fibers: number };

export function classifyWalk(performed: readonly (number | null)[]): WalkVerdict {
  if (performed.length === 0) return { kind: "no-commits" };
  const walked = performed.filter((value): value is number => value !== null);
  if (walked.length === 0) return { kind: "not-walked", commits: performed.length };
  const fibers = walked.reduce((sum, value) => sum + value, 0);
  // The walk ran over real commits and not one fiber anywhere carried the flag. React does
  // not commit a root without rendering something, so this is the instrument, not the app:
  // the flag bit moved, the fiber shape changed, or the hook is being handed the wrong
  // object. Whatever it is, every render number downstream is missing rather than zero.
  if (fibers === 0) return { kind: "blind", commits: performed.length };
  return { kind: "measured", commits: performed.length, walked: walked.length, fibers };
}

/** The one sentence the harness and the summary both print for a verdict. */
export function walkVerdictLine(verdict: WalkVerdict): string {
  switch (verdict.kind) {
    case "no-commits":
      return "no React commits in the window";
    case "not-walked":
      return `renders NOT MEASURED — the fiber walk was off for this window (${verdict.commits} commits went uncounted; the idle scenarios keep it off so its cost stays out of the frame numbers)`;
    case "blind":
      return `⚠⚠ FIBER WALK BLIND — ${verdict.commits} commits were walked and NOT ONE fiber carried PerformedWork. React committed work the walk cannot see: check the flag bit in src/tests/perf/fiber-walk.ts against the installed react-dom. Every render number for this window is MISSING, not zero`;
    case "measured":
      return `${verdict.walked} of ${verdict.commits} commits walked, ${verdict.fibers} fibers rendered`;
  }
}

/**
 * §V936 — the check that makes the number safe. A blind walk must stop the run: a harness
 * that reports nothing where something provably happened is worse than one that crashes,
 * because the nothing gets read as a result.
 */
export function assertWalkNotBlind(label: string, verdict: WalkVerdict): void {
  if (verdict.kind === "blind") throw new Error(`${label}: ${walkVerdictLine(verdict)}`);
}

/**
 * Older harness runs wrote `-1` for "not walked" and `""` for "no signature", which is the
 * ambiguity §T1260 removed. Reading one of those files back should not be a second way to
 * get the wrong answer.
 */
export function normaliseLegacyPerformed(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return value < 0 ? null : value;
}
