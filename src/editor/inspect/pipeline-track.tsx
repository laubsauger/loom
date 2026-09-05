import { Fragment, useMemo } from "react";
import type { PipelinePassRow, PipelineTrack, PipelineTrackLane } from "./pipeline-model.ts";
import styles from "./pipeline.module.css";

/**
 * THE FRAME TAPE — one frame of GPU work, as a Gantt chart (T1188).
 *
 * ## Why this is not a second drawing of the node graph
 *
 * The graph pane already draws the DAG: live, in the user's own layout, with previews,
 * parameters and node colour. A smaller copy of it in here would compete with the
 * original and add nothing — and, worse, it would be unable to say any of the three
 * things this screen exists to say. A DAG has no SEQUENCE, and the plan is a strict
 * list. A DAG has no notion of STORAGE, so two node outputs sharing one buffer — one of
 * the compiler's most surprising decisions — has no edge to be drawn as. And a DAG that
 * drew §V285's synthesized closing edge would draw it exactly like a wire the user
 * placed, which is the confusion the reference exists to remove.
 *
 * Put time on x and storage on y and all three stop needing to be annotated, because
 * they become shapes:
 *
 *  - ENCODE ORDER is the x axis. The lanes are sorted by first touch, so the frame reads
 *    as a staircase and the eye gets the order without reading a number.
 *  - REUSE is two segments in one lane, with a visible gap where the storage changes
 *    hands. E54's `scratch:mesh:@points` holds four different nodes' work in one frame
 *    (T1076's packed copy-on-write) and there is nowhere else in the product to see it.
 *  - THE LOOP is a lane that is OPEN AT BOTH ENDS: a dashed run entering from before
 *    column 0 into the pass that reads last frame's value, and a dashed run leaving the
 *    write toward the next frame. The value visibly does not begin or end inside the
 *    frame, which is what a temporal edge actually is.
 *
 * ## Nothing here is picture-only
 *
 * Every fact the tape draws is also a sentence in the findings above it, and every lane
 * label is real DOM text in the gutter rather than SVG text. The diagram is an
 * illustration of the report, never the sole carrier of it.
 */

/** Column pitch, and the width of the mark drawn in it. */
const COL = 15;
const TICK = 11;
/** Lane pitch and bar height. Tight on purpose: this app's chrome is an instrument. */
const LANE = 16;
const BAR = 10;
/** The pass-kind strip above the lanes, with room for a column number every fifth pass. */
const HEADER = 30;
/** Number every fifth column, so "the swap at 15, read at 17" can be found by eye. */
const RULER = 5;
/** How far the "arrives from the previous frame" run reaches past column 0. */
const OVERHANG = 10;

const PASS_TONE: Readonly<Record<PipelinePassRow["kind"], string>> = {
  effect: "filter",
  draw: "render",
  dispatch: "points",
  counter: "utility",
  swap: "temporal",
  loop: "utility",
};

/** Storage kind → the app's own family colour, so a lane wears the colour its data wears. */
const LANE_TONE: Readonly<Record<PipelineTrackLane["kind"], string>> = {
  target: "texture",
  pingPong: "temporal",
  ring: "temporal",
  externalTexture: "input",
  buffer: "points",
  bufferPair: "points",
  sampler: "texture",
};

function laneNote(lane: PipelineTrackLane): string {
  const notes: string[] = [lane.detail];
  if (lane.aliased) notes.push(`reused by ${lane.segments.length} nodes`);
  if (lane.loopBack !== null) {
    notes.push(`read at pass ${lane.loopBack.readColumn + 1}, written at pass ${lane.loopBack.writeColumn + 1} — previous frame`);
  }
  if (lane.terminal) notes.push("leaves the frame");
  if (lane.stranded) notes.push("written and never read");
  return notes.join(" · ");
}

export interface PipelineTrackViewProps {
  readonly track: PipelineTrack;
  readonly passes: readonly PipelinePassRow[];
}

export function PipelineTrackView({ track, passes }: PipelineTrackViewProps) {
  const lanes = useMemo(
    () =>
      [...track.lanes].sort(
        (a, b) => (a.segments[0]?.from ?? 0) - (b.segments[0]?.from ?? 0) || a.resourceId.localeCompare(b.resourceId),
      ),
    [track.lanes],
  );

  if (passes.length === 0 || lanes.length === 0) return null;

  const width = passes.length * COL + OVERHANG * 2;
  const height = HEADER + lanes.length * LANE;
  const x = (column: number): number => OVERHANG + column * COL;

  return (
    <section className={styles.tape} aria-label="Frame tape">
      <div className={styles.tapeGrid}>
        <div className={styles.gutter}>
          <div className={styles.gutterHead} style={{ height: HEADER }}>
            storage
          </div>
          {lanes.map((lane) => (
            <div
              key={lane.resourceId}
              className={styles.gutterLane}
              style={{ height: LANE }}
              title={`${lane.resourceId} — ${laneNote(lane)}`}
              data-lane-row={lane.resourceId}
              data-aliased={lane.aliased}
              data-loopback={lane.loopBack !== null}
              data-terminal={lane.terminal}
              data-stranded={lane.stranded}
            >
              <span className={styles.gutterSwatch} data-tone={LANE_TONE[lane.kind]} />
              <span className={styles.gutterName}>{lane.resourceId}</span>
              {lane.aliased ? <span className={styles.gutterBadge}>×{lane.segments.length}</span> : null}
            </div>
          ))}
        </div>

        <div className={styles.tapeScroll}>
          <svg
            className={styles.tapeSvg}
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            role="img"
          >
            <title>One frame: {passes.length} passes left to right, {lanes.length} resources top to bottom</title>

            {/* The pass strip. Kind is the colour; the tooltip is the name. */}
            <g data-role="passes">
              {passes.map((pass, column) => (
                <Fragment key={pass.id}>
                  {column === 0 || (column + 1) % RULER === 0 ? (
                    <text className={styles.ruler} x={x(column)} y={9}>
                      {column + 1}
                    </text>
                  ) : null}
                  <rect
                    data-pass={pass.id}
                    data-kind={pass.kind}
                    className={styles.passTick}
                    data-tone={PASS_TONE[pass.kind]}
                    x={x(column)}
                    y={HEADER - TICK - 4}
                    width={TICK}
                    height={TICK}
                    rx={1}
                  >
                    <title>{`${column + 1}. ${pass.kind} — ${pass.label} (${pass.id})`}</title>
                  </rect>
                </Fragment>
              ))}
            </g>

            {/* Substep loops: the tape rewinds over this span (T387). */}
            <g data-role="loops">
              {track.loops.map((loop) => (
                <Fragment key={loop.loopId}>
                  <path
                    data-loop={loop.loopId}
                    className={styles.loopBracket}
                    d={`M ${x(loop.from) + TICK / 2} ${HEADER - 3} V ${height - 2} M ${x(loop.to) + TICK / 2} ${HEADER - 3} V ${height - 2}`}
                  />
                  <text
                    className={styles.loopLabel}
                    x={x(loop.from) + TICK / 2 + 3}
                    y={HEADER - 6}
                  >
                    ×{loop.count}
                  </text>
                </Fragment>
              ))}
            </g>

            {lanes.map((lane, row) => {
              const top = HEADER + row * LANE;
              const mid = top + LANE / 2;
              const barY = top + (LANE - BAR) / 2;
              return (
                <g
                  key={lane.resourceId}
                  className={styles.lane}
                  data-lane={lane.resourceId}
                  data-tone={LANE_TONE[lane.kind]}
                  data-aliased={lane.aliased}
                  data-stranded={lane.stranded}
                >
                  <rect className={styles.laneRule} x={0} y={top} width={width} height={LANE} />

                  {/* Arrives from before the frame started: §V285's closing edge. */}
                  {lane.loopBack === null ? null : (
                    <path
                      data-loopback-in={lane.resourceId}
                      className={styles.crossing}
                      d={`M 0 ${mid} H ${x(lane.loopBack.readColumn)}`}
                    />
                  )}

                  {lane.segments.map((segment, index) => (
                    <Fragment key={segment.id}>
                      {/* Where the storage CHANGES HANDS. Point tenancies are often one
                          or two columns wide, so without an explicit divider the reuse
                          reads as scattered marks rather than as a handover. */}
                      {index === 0 ? null : (
                        <rect
                          data-handover={segment.id}
                          className={styles.handover}
                          x={x(segment.from) - 2}
                          y={top + 1}
                          width={1}
                          height={LANE - 2}
                        />
                      )}
                      <rect
                        data-segment={segment.id}
                        data-owner={segment.nodeId ?? ""}
                        className={styles.segment}
                        x={x(segment.from)}
                        y={barY}
                        width={x(segment.to) + TICK - x(segment.from)}
                        height={BAR}
                        rx={1}
                      >
                        <title>{`${lane.resourceId} holds ${segment.label} from pass ${segment.from + 1} to ${segment.to + 1}`}</title>
                      </rect>
                      {segment.marks.map((mark) => (
                        <rect
                          key={`${segment.id}:${mark.column}:${mark.kind}`}
                          data-mark={mark.kind}
                          className={styles.mark}
                          x={x(mark.column)}
                          y={mark.kind === "read" ? barY : top + 1}
                          width={TICK}
                          height={mark.kind === "swap" ? LANE - 2 : mark.kind === "read" ? BAR : LANE - 2}
                          rx={1}
                        />
                      ))}
                    </Fragment>
                  ))}

                  {/* Leaves toward the next frame, or out of the plan entirely. */}
                  {lane.loopBack === null ? null : (
                    <path
                      data-loopback-out={lane.resourceId}
                      className={styles.crossing}
                      d={`M ${x(lane.loopBack.writeColumn) + TICK} ${mid} H ${width}`}
                    />
                  )}
                  {lane.terminal ? (
                    <path
                      data-terminal={lane.resourceId}
                      className={styles.exit}
                      d={`M ${x(lane.segments[lane.segments.length - 1]?.to ?? 0) + TICK + 2} ${mid - 3} l 5 3 l -5 3 z`}
                    />
                  ) : null}
                </g>
              );
            })}
          </svg>
        </div>
      </div>

      <ul className={styles.legend}>
        <li><span className={styles.key} data-key="write" /> written</li>
        <li><span className={styles.key} data-key="read" /> read</li>
        <li><span className={styles.key} data-key="use" /> bound (direction not stated by the plan)</li>
        <li><span className={styles.key} data-key="swap" /> ping-pong swap</li>
        <li><span className={styles.key} data-key="crossing" /> crosses the frame boundary</li>
        <li><span className={styles.key} data-key="alias" /> one resource, several nodes</li>
      </ul>
    </section>
  );
}
