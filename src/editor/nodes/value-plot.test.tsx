import { Profiler } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { ValuePlot } from "./value-plot.tsx";
import type { ValueHistory, ValueHistorySource } from "./value-history.ts";

/**
 * T1239 — a value plot renders for the eyes on it.
 *
 * The history ring notifies every plot at 10 Hz. A graph pane behind another tab, or
 * floated to a second window, keeps every plot mounted (§V96), and each one used to
 * re-render its SVG on every tick for nobody. The gate: a HIDDEN plot does not commit on
 * a tick, and a plot that becomes visible again shows the ring's CURRENT window at once,
 * not one tick later (§V86).
 *
 * jsdom has no `Element.checkVisibility`; the test installs the `display:none` half of it.
 */

function window(latest: number): ValueHistory {
  return {
    channels: ["value"],
    series: [[latest - 0.2, latest - 0.1, latest]],
    latest: { value: latest },
    timeSeconds: latest,
  };
}

function fakeHistory(initial: ValueHistory) {
  let current = initial;
  const listeners = new Set<() => void>();
  const source: ValueHistorySource = {
    get: () => current,
    subscribe: (_nodeId, listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    source,
    push(next: ValueHistory): void {
      current = next;
      act(() => {
        for (const listener of [...listeners]) listener();
      });
    },
  };
}

const reading = () => screen.getByLabelText("Channels of lag").querySelector("dd")?.textContent;

function hiddenByDisplay(element: Element): boolean {
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    if (node instanceof HTMLElement && node.style.display === "none") return true;
  }
  return false;
}

beforeAll(() => {
  installDomStubs();
  if (typeof Element.prototype.checkVisibility !== "function") {
    Element.prototype.checkVisibility = function (this: Element) {
      return !hiddenByDisplay(this);
    };
  }
});

afterEach(cleanup);

describe("ValuePlot renders for the eyes on it (T1239)", () => {
  it("skips ticks while hidden and shows the current window the moment it is shown (§V86)", async () => {
    const history = fakeHistory(window(0.5));
    let commits = 0;
    const pane = document.createElement("div");
    document.body.append(pane);
    render(
      <Profiler
        id="plot"
        onRender={() => {
          commits += 1;
        }}
      >
        <ValuePlot nodeId="lag" history={history.source} />
      </Profiler>,
      { container: pane },
    );
    expect(reading()).toBe("0.500");
    const shown = commits;

    act(() => {
      pane.style.display = "none";
    });
    history.push(window(0.6));
    history.push(window(0.7));
    expect(commits).toBe(shown);
    expect(reading()).toBe("0.500");

    act(() => {
      pane.style.display = "";
    });
    await waitFor(() => expect(reading()).toBe("0.700"));
    expect(commits).toBe(shown + 1);

    history.push(window(0.8));
    expect(reading()).toBe("0.800");
  });
});
