import type { CDPSession, Page } from "@playwright/test";
import type { TraceEvent } from "../../perf/trace-parser.ts";

/**
 * A Chromium trace with the V8 sampling profiler attached, over CDP (T1235).
 *
 * `Tracing.start` with `transferMode: "ReportEvents"` streams `Tracing.dataCollected`
 * batches to us and ends with `Tracing.tracingComplete`. The categories are the ones the
 * DevTools Performance panel itself records, so the event names the parser looks for are
 * the ones DevTools' own timeline is built on — verified against a real capture before
 * the parser's names were finalised (see `trace-parser.ts` header).
 */
export const TRACE_CATEGORIES = [
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
  "disabled-by-default-v8.cpu_profiler",
  "v8.execute",
  "blink.user_timing",
  "toplevel",
  "__metadata",
].join(",");

export interface Tracer {
  readonly session: CDPSession;
  /** Trace-clock µs of `performance.now()` zero in the page, for cross-referencing. */
  stop(): Promise<TraceEvent[]>;
}

export async function startTrace(page: Page): Promise<Tracer> {
  const session = await page.context().newCDPSession(page);
  const events: TraceEvent[] = [];
  // Playwright types the payload as `{ [key: string]: string }[]`; the events are the
  // Chrome trace-event JSON objects the parser expects, so the cast is a re-typing, not a
  // conversion.
  session.on("Tracing.dataCollected", (payload) => {
    for (const event of payload.value as unknown as TraceEvent[]) events.push(event);
  });
  const complete = new Promise<void>((resolve) => session.once("Tracing.tracingComplete", () => resolve()));
  // `recordAsMuchAsPossible`: the default `recordUntilFull` buffer silently dropped the
  // tail of a 9 s pan/zoom over 200 nodes (13k Paint events), and with it the end mark.
  await session.send("Tracing.start", {
    categories: TRACE_CATEGORIES,
    transferMode: "ReportEvents",
    options: "sampling-frequency=1000,record-as-much-as-possible",
    bufferUsageReportingInterval: 0,
  });
  return {
    session,
    async stop() {
      await session.send("Tracing.end");
      await complete;
      await session.detach();
      return events;
    },
  };
}

/**
 * The page's monotonic clock in TRACE µs. Trace timestamps are CLOCK_MONOTONIC-ish µs
 * on the same base `performance.timeOrigin` derives from, so a harness that marks
 * `performance.now()` at a scenario's edges can cut the trace at those marks. The
 * relationship is read at runtime (one `performance.mark` shows up as a
 * `blink.user_timing` event with a trace `ts`), never assumed.
 */
export async function markTrace(page: Page, name: string): Promise<number> {
  return page.evaluate((markName) => {
    performance.mark(markName);
    return performance.now();
  }, name);
}

/** Finds a `performance.mark` in the trace and returns its trace-clock µs. */
export function traceTsOfMark(events: readonly TraceEvent[], name: string): number {
  for (const event of events) {
    if (event.name === name && event.cat.includes("blink.user_timing")) return event.ts;
  }
  throw new Error(`performance.mark("${name}") did not reach the trace`);
}
