import { afterEach, expect, it, vi } from "vitest";
import { startReactTimingRetention } from "./react-timing-retention.ts";
afterEach(() => vi.unstubAllGlobals());

it("retires only exclusively React-owned name groups and disconnects its observer", () => {
  let callback!: (list: PerformanceObserverEntryList) => void;
  const observe = vi.fn(), disconnect = vi.fn();
  vi.stubGlobal("PerformanceObserver", class {
    constructor(consume: typeof callback) { callback = consume; }
    observe = observe; disconnect = disconnect;
  });
  const entry = (name: string, detail: unknown) => ({ name, entryType: "measure", detail }) as PerformanceMeasure;
  const component = entry("\u200bViewer", { devtools: { track: "Components ⚛" } });
  const scheduler = entry("Render", { devtools: { trackGroup: "Scheduler ⚛" } });
  const collided = entry("Update", { devtools: { trackGroup: "Scheduler ⚛" } });
  const custom = entry("Update", { app: "keep this earlier record" });
  const unrelated = entry("custom", { devtools: { track: "My profiler" } });
  const entries = [component, scheduler, custom, collided, unrelated];
  const clear = vi.fn((name: string) => { for (let i = entries.length - 1; i >= 0; i--) if (entries[i]!.name === name) entries.splice(i, 1); });
  vi.stubGlobal("performance", { clearMeasures: clear,
    getEntriesByName: (name: string) => entries.filter(entry => entry.name === name) });
  const stop = startReactTimingRetention();
  expect(observe).toHaveBeenCalledWith({ type: "measure", buffered: true });
  const delivered = [component, scheduler, collided, unrelated];
  callback({ getEntries: () => delivered,
    getEntriesByName: name => delivered.filter(entry => entry.name === name),
    getEntriesByType: type => delivered.filter(entry => entry.entryType === type) });
  expect(entries).toEqual([custom, collided, unrelated]);
  expect(clear.mock.calls).toEqual([["\u200bViewer"], ["Render"]]);
  stop(); expect(disconnect).toHaveBeenCalledOnce();
});
