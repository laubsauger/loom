/** React 19 development tracks serialize component details into User Timing.
 * Browsers retain those entries indefinitely; a live editor accumulates hundreds
 * of thousands. DevTools tracing records the events independently of this buffer.
 * Keep custom timings intact, including names shared with React. This policy
 * intentionally gives up retrospective getEntries/buffered-observer history for
 * exclusively recognized React names, not the recorded profiler trace.
 */
function isReactMeasure(entry: PerformanceEntry): boolean {
  if (entry.entryType !== "measure") return false;
  const detail: unknown = (entry as PerformanceMeasure).detail;
  if (!detail || typeof detail !== "object" || !("devtools" in detail)) return false;
  const tools = detail.devtools;
  if (!tools || typeof tools !== "object") return false;
  return ("track" in tools && tools.track === "Components ⚛") ||
    ("trackGroup" in tools && tools.trackGroup === "Scheduler ⚛");
}

/** Development document bootstrap only; disconnect on hot replacement. */
export function startReactTimingRetention(): () => void {
  const observer = new PerformanceObserver(list => {
    const names = new Set(list.getEntries().filter(isReactMeasure).map(entry => entry.name));
    for (const name of names) {
      // clearMeasures is name-wide. An older custom measure may not be in this
      // delivery batch, so inspect the whole current name group before clearing.
      if (performance.getEntriesByName(name, "measure").every(isReactMeasure)) performance.clearMeasures(name);
    }
  });
  observer.observe({ type: "measure", buffered: true });
  return () => observer.disconnect();
}
