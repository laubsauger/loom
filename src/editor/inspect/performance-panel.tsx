import { useCallback, useMemo, useRef } from "react";
import { UNAVAILABLE_COST } from "@runtime/telemetry/index.ts";
import type {
  CategoryRollup,
  CostBucket,
  FrameTimingBucket,
  NodeCostRow,
  PassTimingRow,
  TelemetrySnapshot,
  TelemetrySource,
} from "@runtime/telemetry/index.ts";
import { useStoreSelector } from "@ui/hooks/use-store-selector.ts";
import { useVisibleSubscribe } from "@ui/hooks/use-visible-subscribe.ts";
import type { Subscribe } from "@ui/hooks/use-visible-subscribe.ts";
import { formatBytes, formatCost, formatMs } from "./format.ts";
import type { FormattedMs } from "./format.ts";
import styles from "./inspect.module.css";

/**
 * The performance dock tab (T41, §I.ui, §V16, §V24, §V86).
 *
 * Everything on this pane is a fact the system already knows: the plan's pass and
 * resource counts, `plan.estimatedResourceBytes` against the project memory budget, the
 * backend's `lastBuild` reuse accounting, and per-pass GPU spans.
 *
 * The per-pass table is the point of the tab. A single frame-time number tells you the
 * frame is slow; it does not tell you which pass to look at, which is the only question
 * worth asking. So the rows carry the pass id, the node's source path (§V82 — the place
 * the user can navigate to, not the flattened id) and its span.
 *
 * §V86 is visible here rather than hidden: when the device reports no timestamp query the
 * ms column reads "unavailable" on every row. It does not read 0.000, and it does not
 * quietly substitute CPU encode time, which on a real workload differs by more than an
 * order of magnitude and would send someone optimising a pass that costs nothing.
 *
 * WHY the absence happened is NOT stated here (B172/§T1012). It used to be, four lines
 * under the `timestamp query` row of the block above and contradicting it. It now lives
 * beside that row, in `GpuStatusCard`, rendered from `timing-note.tsx` — one sentence, one
 * place, derived from the fact it describes.
 *
 * READBACK (T278, §V185) sits beside the frame cost because it is a frame cost: N Analyze
 * nodes are N GPU→CPU round trips every frame, and someone who drops twenty of them has to
 * SEE why it got slow rather than guess. Two numbers are on the surface — how many, how
 * many bytes — and the per-node attribution is one disclosure down, because "which node" is
 * the second question and §V90 says the panel shows what someone acts on first.
 *
 * COST (T256) is the one thing Notch's profiler does better than TD's: CPU and GPU on the
 * same row. The pair says which machine the frame is waiting on, which neither number says
 * alone. The CATEGORY rollup is on the surface and the per-node rows are one disclosure
 * down, because "filters cost 11 ms" narrows the search before any individual row has to be
 * read — and because sixty node rows permanently open is the §V90 failure this pane is most
 * prone to.
 *
 * The hub, not this component, owns the rate: it notifies at most 10 times a second
 * (§V16). What re-renders on a tick is keyed on what READS (T1239, §V939): the pane's
 * STRUCTURE — which sections, which rows — follows the plan and the build and re-renders
 * only when one of those changes; every live number is its own subscriber that re-renders
 * only when ITS text moved. And nothing here renders while the pane is hidden: the
 * subscription is gated on the pane's visibility, and the moment the pane is shown again
 * every subscriber re-reads the hub, so the first paint is current (§V86).
 */

/** The hub, or a fixture standing in for it. */
interface SnapshotSource {
  readonly subscribe: Subscribe;
  readonly snapshot: () => TelemetrySnapshot;
}

/** `BackendStatus`'s own switch, restated so this module never imports the backend. */
export type CookPolicyValue = "always" | "auto";

export interface PerformancePanelProps {
  readonly telemetry: TelemetrySource | null;
  /**
   * The cook policy the backend is running (T326, §V157). Omitted, no control renders.
   *
   * §V92a puts device and build diagnostics on THIS surface rather than a content one,
   * and a bisect switch is exactly that: the thing you reach for when you suspect cooking
   * is producing a wrong frame in the wild.
   */
  readonly cookPolicy?: CookPolicyValue | undefined;
  readonly onCookPolicyChange?: ((policy: CookPolicyValue) => void) | undefined;
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "warn" | undefined;
}) {
  return (
    <div className={styles.stat}>
      <span className={styles.statLabel}>{label}</span>
      <span className={styles.statValue} {...(tone === undefined ? {} : { "data-tone": tone })}>
        {value}
      </span>
    </div>
  );
}

/**
 * T1243 — the frame's GPU time is the submit's EXTENT and the per-pass sum is a second,
 * separate reading. The two differ on Apple GPUs (passes overlap, so the sum overstates
 * the frame), which is why the sum is shown beside the frame and never as it. When the
 * hub had no extent to give, `basis` is "passes" and the frame figure IS the sum — the
 * label says so rather than letting a fallback pass for a measurement.
 */
function frameGpuText(frame: FrameTimingBucket): string {
  const text = formatMs(frame).text;
  return frame.basis === "passes" ? `${text} (pass sum)` : text;
}

function passSumText(frame: FrameTimingBucket): string {
  if (frame.passSumMs === undefined) return "—";
  return formatMs({ ...frame, gpuMs: frame.passSumMs }).text;
}

/** One live reading: re-renders only when the selected text changed. */
function useLiveText(source: SnapshotSource, select: (snapshot: TelemetrySnapshot) => string) {
  return useStoreSelector(source.subscribe, source.snapshot, select);
}

function LiveStat({
  source,
  label,
  select,
}: {
  source: SnapshotSource;
  label: string;
  select: (snapshot: TelemetrySnapshot) => string;
}) {
  return <Stat label={label} value={useLiveText(source, select)} />;
}

export function PerformancePanel({
  telemetry,
  cookPolicy,
  onCookPolicyChange,
}: PerformancePanelProps) {
  const root = useRef<HTMLDivElement>(null);
  const subscribe = useVisibleSubscribe(
    root,
    useCallback(
      (listener: () => void) => telemetry?.subscribe(listener) ?? (() => {}),
      [telemetry],
    ),
  );
  const source = useMemo<SnapshotSource | null>(
    () => (telemetry === null ? null : { subscribe, snapshot: () => telemetry.snapshot() }),
    [telemetry, subscribe],
  );

  if (source === null) {
    return (
      <div className={styles.performance}>
        <p className={styles.note}>No telemetry attached</p>
      </div>
    );
  }

  return (
    <div ref={root} className={styles.performance} data-testid="performance-panel">
      <PerformanceSections
        source={source}
        {...(cookPolicy === undefined ? {} : { cookPolicy })}
        {...(onCookPolicyChange === undefined ? {} : { onCookPolicyChange })}
      />
    </div>
  );
}

/**
 * Per-snapshot row lookup, built once per snapshot object however many cells read it.
 * (A per-row selector on the hub itself would make this unnecessary — T1243's API.)
 */
interface RowIndex {
  readonly nodes: ReadonlyMap<string, NodeCostRow>;
  readonly categories: ReadonlyMap<string, CategoryRollup>;
  readonly passes: ReadonlyMap<string, PassTimingRow>;
}

const rowIndexes = new WeakMap<TelemetrySnapshot, RowIndex>();

function rowIndex(snapshot: TelemetrySnapshot): RowIndex {
  let index = rowIndexes.get(snapshot);
  if (index === undefined) {
    index = {
      nodes: new Map(snapshot.nodes.map((row) => [row.nodeId, row])),
      categories: new Map(snapshot.categories.map((row) => [row.category, row])),
      passes: new Map(snapshot.passes.map((row) => [row.passId, row])),
    };
    rowIndexes.set(snapshot, index);
  }
  return index;
}

const sameText = (a: FormattedMs, b: FormattedMs): boolean => a.text === b.text;

/** A cost cell. An absent measurement is a word, never a digit (§V86). */
function CostCell({
  source,
  select,
}: {
  source: SnapshotSource;
  select: (snapshot: TelemetrySnapshot) => CostBucket;
}) {
  const formatted = useStoreSelector(
    source.subscribe,
    source.snapshot,
    (snapshot) => formatCost(select(snapshot)),
    sameText,
  );
  return (
    <td className={`${styles.numeric} ${formatted.absent ? styles.absent : ""}`.trim()}>
      {formatted.text}
    </td>
  );
}

function PassMsCell({ source, passId }: { source: SnapshotSource; passId: string }) {
  const ms = useStoreSelector(
    source.subscribe,
    source.snapshot,
    (snapshot) => {
      const row = rowIndex(snapshot).passes.get(passId);
      return row === undefined
        ? formatMs({ availability: "unavailable", gpuMs: null, passCount: 1, nodeCount: 0 })
        : formatMs({
            availability: row.availability,
            gpuMs: row.gpuMs,
            passCount: 1,
            nodeCount: row.nodeId === null ? 0 : 1,
          });
    },
    sameText,
  );
  return (
    <td className={`${styles.numeric} ${ms.absent ? styles.absent : ""}`.trim()}>{ms.text}</td>
  );
}

/**
 * Per-node CPU and GPU cost with category rollups (T256, §V86).
 *
 * Both halves degrade honestly and INDEPENDENTLY: a device with no `timestamp-query` shows
 * "unavailable" in the gpu column while the cpu column keeps working, and vice versa.
 * Neither ever shows 0.000 ms for a measurement that does not exist — a zero reads as
 * "free" and sends someone optimising the wrong node, which is the whole reason §V86 makes
 * absence a first-class state rather than a default value.
 */
function CostSection({
  source,
  snapshot,
}: {
  source: SnapshotSource;
  snapshot: TelemetrySnapshot;
}) {
  const measuring = snapshot.timingAvailable || snapshot.cpuTimingAvailable;
  return (
    <section aria-label="Cost">
      <h3 className={styles.blockTitle}>cost by category</h3>
      {snapshot.categories.length === 0 ? (
        <p className={styles.note}>No nodes in the current plan.</p>
      ) : !measuring ? (
        // §V91: name the STATE, and only the state. A table of sixty "unavailable" cells is
        // not information, it is the same word sixty times — and WHY there is no timing is
        // already said once, in the gpu block above, beside the capability it qualifies.
        <p className={styles.note}>No timing on this device</p>
      ) : (
        <>
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">category</th>
                  <th scope="col" className={styles.numeric}>
                    nodes
                  </th>
                  <th scope="col" className={styles.numeric}>
                    cpu ms
                  </th>
                  <th scope="col" className={styles.numeric}>
                    gpu ms
                  </th>
                </tr>
              </thead>
              <tbody>
                {snapshot.categories.map((rollup) => (
                  <tr key={rollup.category}>
                    <td>{rollup.category}</td>
                    <td className={styles.numeric}>{rollup.nodeCount}</td>
                    <CostCell
                      source={source}
                      select={(s) =>
                        rowIndex(s).categories.get(rollup.category)?.cpu ?? UNAVAILABLE_COST
                      }
                    />
                    <CostCell
                      source={source}
                      select={(s) =>
                        rowIndex(s).categories.get(rollup.category)?.gpu ?? UNAVAILABLE_COST
                      }
                    />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details className={styles.disclosure}>
            <summary className={styles.summary}>per node</summary>
            <div className={styles.tableScroll}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">node</th>
                    <th scope="col">category</th>
                    <th scope="col" className={styles.numeric}>
                      passes
                    </th>
                    <th scope="col" className={styles.numeric}>
                      cpu ms
                    </th>
                    <th scope="col" className={styles.numeric}>
                      gpu ms
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.nodes.map((row) => (
                    <tr key={row.nodeId}>
                      <td>{row.sourcePath ?? row.label ?? row.nodeId}</td>
                      <td>{row.category}</td>
                      <td className={styles.numeric}>{row.passCount}</td>
                      <CostCell
                        source={source}
                        select={(s) => rowIndex(s).nodes.get(row.nodeId)?.cpu ?? UNAVAILABLE_COST}
                      />
                      <CostCell
                        source={source}
                        select={(s) => rowIndex(s).nodes.get(row.nodeId)?.gpu ?? UNAVAILABLE_COST}
                      />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </section>
  );
}

/**
 * Readback cost per frame, with per-node attribution (T278, §V185).
 *
 * Two readings, deliberately not merged. The BUDGET is what the compiled graph asks for
 * every frame and is the number a user can act on — deleting an Analyze node lowers it.
 * PERFORMED is the backend's own counter of round trips that actually happened, and it is
 * shown only when something is counting: "—" means nobody reported, which is a different
 * fact from a backend reporting none, and collapsing the two would hide a readback path
 * that is not running at all.
 */
function ReadbackSection({
  source,
  snapshot,
}: {
  source: SnapshotSource;
  snapshot: TelemetrySnapshot;
}) {
  const { readback } = snapshot;
  return (
    <section aria-label="Readback">
      <h3 className={styles.blockTitle}>readback</h3>
      {readback.count === 0 ? (
        <p className={styles.note}>No readbacks in this plan.</p>
      ) : (
        <>
          <div className={styles.statRow}>
            <Stat label="per frame" value={String(readback.count)} />
            <Stat
              label="bytes / frame"
              value={`${readback.incomplete ? "≥ " : ""}${formatBytes(readback.bytes)}`}
            />
            <LiveStat
              source={source}
              label="performed"
              select={(s) => (s.readback.performed === null ? "—" : String(s.readback.performed))}
            />
          </div>
          <details className={styles.disclosure}>
            <summary className={styles.summary}>per node</summary>
            <div className={styles.tableScroll}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">node</th>
                    <th scope="col">reason</th>
                    <th scope="col" className={styles.numeric}>
                      bytes / frame
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {readback.rows.map((row) => (
                    <tr key={`${row.nodeId}:${row.resourceId}`}>
                      <td>{row.sourcePath ?? row.nodeId}</td>
                      <td>{row.reason}</td>
                      <td
                        className={`${styles.numeric} ${row.bytes === null ? styles.absent : ""}`.trim()}
                      >
                        {row.bytes === null ? "unknown" : formatBytes(row.bytes)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </section>
  );
}

export interface PerformanceViewProps {
  readonly snapshot: TelemetrySnapshot;
  readonly cookPolicy?: CookPolicyValue | undefined;
  readonly onCookPolicyChange?: ((policy: CookPolicyValue) => void) | undefined;
}

/**
 * The cook-policy switch (T326, §V157).
 *
 * §V157 ships this control before any gating and keeps it forever, as the permanent
 * bisect when someone suspects cooking in the wild — flip to "always" and the question
 * becomes "is it cooking?" instead of "is it something else?".
 *
 * It defaults to ALWAYS. That was once because "auto" was incorrect — a one-frame lag at
 * motion onset, §V157's signature failure — and since T340 it is not: values are pushed
 * before the encode that carries them, and the parity oracle compares the value visible at
 * every frame index rather than at the end, which is where the lag used to hide.
 *
 * The default stays because turning the gate on for everyone is a DECISION about what
 * every project does per frame, not a bug fix. Its evidence is the example census, not one
 * measured graph.
 */
function CookPolicyControl({
  policy,
  onChange,
}: {
  policy: CookPolicyValue;
  onChange: (policy: CookPolicyValue) => void;
}) {
  return (
    <div className={styles.stat} aria-label="Cooking">
      <label className={styles.statLabel} htmlFor="cook-policy">
        cooking
      </label>
      <select
        id="cook-policy"
        data-testid="cook-policy"
        className={styles.policySelect}
        value={policy}
        onChange={(event) => onChange(event.target.value as CookPolicyValue)}
      >
        <option value="always">always</option>
        <option value="auto">auto</option>
      </select>
    </div>
  );
}

const NEVER: Subscribe = () => () => {};

/** Pure view over a snapshot — renders from a fixture with no GPU and no hub. */
export function PerformanceView({
  snapshot,
  cookPolicy,
  onCookPolicyChange,
}: PerformanceViewProps) {
  const source = useMemo<SnapshotSource>(
    () => ({ subscribe: NEVER, snapshot: () => snapshot }),
    [snapshot],
  );
  return (
    <div className={styles.performance} data-testid="performance-panel">
      <PerformanceSections
        source={source}
        {...(cookPolicy === undefined ? {} : { cookPolicy })}
        {...(onCookPolicyChange === undefined ? {} : { onCookPolicyChange })}
      />
    </div>
  );
}

/**
 * The pane's structure. Subscribed to the snapshot but keyed on the facts that decide
 * WHICH sections and rows exist — plan, build, the two timing capabilities, the budget
 * verdict — so a tick that only moved numbers does not re-render it. The numbers are
 * `LiveStat` / `CostCell` / `PassMsCell` subscribers of their own.
 */
const sameStructure = (a: TelemetrySnapshot, b: TelemetrySnapshot): boolean =>
  a.plan === b.plan &&
  a.build === b.build &&
  a.timingAvailable === b.timingAvailable &&
  a.cpuTimingAvailable === b.cpuTimingAvailable &&
  a.overBudget === b.overBudget;

const identity = (snapshot: TelemetrySnapshot): TelemetrySnapshot => snapshot;

function PerformanceSections({
  source,
  cookPolicy,
  onCookPolicyChange,
}: {
  source: SnapshotSource;
  cookPolicy?: CookPolicyValue | undefined;
  onCookPolicyChange?: ((policy: CookPolicyValue) => void) | undefined;
}) {
  const snapshot = useStoreSelector(source.subscribe, source.snapshot, identity, sameStructure);
  const { plan, build } = snapshot;

  return (
    <>
      <section aria-label="Frame">
        <h3 className={styles.blockTitle}>frame</h3>
        {/*
          §T1012 — cook policy rides the FRAME row rather than owning a section.
          It is one short value, it belongs to the frame (it says whether every pass cooks
          every frame), and a heading plus a row of its own was most of a screenful of dead
          space for a two-option select. The control itself is unchanged, including its
          `cook-policy` test id and its label association.
        */}
        <div className={styles.statRow}>
          <LiveStat source={source} label="gpu time" select={(s) => frameGpuText(s.frame)} />
          <LiveStat source={source} label="pass sum" select={(s) => passSumText(s.frame)} />
          <LiveStat source={source} label="frames" select={(s) => String(s.framesRendered)} />
          <LiveStat
            source={source}
            label="frame index"
            select={(s) => (s.lastFrameIndex === null ? "—" : String(s.lastFrameIndex))}
          />
          {cookPolicy === undefined || onCookPolicyChange === undefined ? null : (
            <CookPolicyControl policy={cookPolicy} onChange={onCookPolicyChange} />
          )}
        </div>
      </section>

      <CostSection source={source} snapshot={snapshot} />

      <ReadbackSection source={source} snapshot={snapshot} />

      <section aria-label="Plan">
        <h3 className={styles.blockTitle}>plan</h3>
        {plan === null ? (
          <p className={styles.note}>No plan is compiled.</p>
        ) : (
          <div className={styles.statRow}>
            <Stat label="passes" value={String(plan.passes.length)} />
            <Stat label="resources" value={String(plan.resourceCount)} />
            <Stat label="nodes kept" value={String(plan.nodeCount)} />
            <Stat label="nodes pruned" value={String(plan.prunedCount)} />
            <Stat
              label="gpu memory"
              value={formatBytes(plan.estimatedResourceBytes)}
              tone={snapshot.overBudget ? "warn" : undefined}
            />
            <Stat
              label="budget"
              value={plan.memoryBudgetBytes === null ? "—" : formatBytes(plan.memoryBudgetBytes)}
            />
          </div>
        )}
        {snapshot.overBudget ? (
          // §V24: the project memory budget is reported, not silently exceeded. The
          // compiler raises `compiler/memory-budget` for the same condition.
          <p className={styles.note} data-testid="memory-budget-warning">
            compiler/memory-budget — the plan&apos;s estimated texture memory exceeds the
            project budget. Lower a node&apos;s resolution, or raise the budget in project
            settings.
          </p>
        ) : null}
      </section>

      <section aria-label="Last build">
        <h3 className={styles.blockTitle}>last build</h3>
        {build === null ? (
          <p className={styles.note}>Nothing has been built yet.</p>
        ) : (
          <div className={styles.statRow}>
            <Stat label="resources built" value={String(build.resourcesCreated)} />
            <Stat label="resources reused" value={String(build.resourcesReused)} />
            <Stat label="effects built" value={String(build.effectsBuilt)} />
            <Stat label="effects reused" value={String(build.effectsReused)} />
          </div>
        )}
      </section>

      <section aria-label="Passes">
        <h3 className={styles.blockTitle}>passes</h3>
        {snapshot.passes.length === 0 ? (
          <p className={styles.note}>No passes in the current plan.</p>
        ) : (
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">pass</th>
                  <th scope="col">kind</th>
                  <th scope="col">node</th>
                  <th scope="col" className={styles.numeric}>
                    gpu ms
                  </th>
                </tr>
              </thead>
              <tbody>
                {snapshot.passes.map((row) => (
                  <tr key={row.passId}>
                    <td>{row.passId}</td>
                    <td>{row.kind}</td>
                    <td>{row.sourcePath ?? row.nodeId ?? "—"}</td>
                    <PassMsCell source={source} passId={row.passId} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
