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
    plotted: ["value"],
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

/**
 * T1297 — the readout lists EVERY channel; only the curves are capped.
 *
 * `audioIn` publishes twenty-one. The cap used to be applied to the bag rather than to
 * the lines, one layer down and before the ring was written, so seventeen of them — every
 * `*Count`, `centroid`, the whole tempo claim — could not be read from the UI by any
 * route. Four curves in two centimetres is the real constraint (§V90-§V92); twenty-one
 * `<dt>/<dd>` pairs in a fixed, scrolled window is not.
 */
describe("ValuePlot shows every channel, not just the plotted four (T1297)", () => {
  const wide: ValueHistory = {
    channels: ["level", "low", "lowMid", "highMid", "high", "centroid", "bpm"],
    plotted: ["level", "low", "lowMid", "highMid"],
    series: [
      [0.1, 0.2],
      [0.3, 0.4],
      [0.5, 0.6],
      [0.7, 0.8],
    ],
    latest: {
      level: 0.2, low: 0.4, lowMid: 0.6, highMid: 0.8, high: 0.9, centroid: 0.62, bpm: 128,
    },
    timeSeconds: 1,
  };

  const rows = () =>
    [...screen.getByLabelText("Channels of lag").querySelectorAll("div")].map((row) => [
      row.querySelector("dt")?.textContent ?? "",
      row.querySelector("dd")?.textContent ?? "",
    ]);

  it("prints all seven readings while drawing four lines", () => {
    render(<ValuePlot nodeId="lag" history={fakeHistory(wide).source} />);
    expect(rows()).toEqual([
      ["level", "0.200"],
      ["low", "0.400"],
      ["lowMid", "0.600"],
      ["highMid", "0.800"],
      ["high", "0.900"],
      ["centroid", "0.620"],
      ["bpm", "128.000"],
    ]);
    // Four strokes, because four is what the body can carry legibly.
    expect(document.querySelectorAll("svg path")).toHaveLength(4);
  });

  it("tints only the channels that HAVE a line, so a name never claims a stroke that is absent", () => {
    render(<ValuePlot nodeId="lag" history={fakeHistory(wide).source} />);
    const terms = [...screen.getByLabelText("Channels of lag").querySelectorAll("dt")];
    const classOf = (index: number) => terms[index]?.className ?? "";
    // The first four wear their stroke's class; `high` and beyond wear none of them.
    expect(classOf(0)).not.toBe(classOf(4));
    for (const index of [4, 5, 6]) {
      expect(classOf(index).split(" ").filter((name) => name.includes("series"))).toEqual([]);
    }
  });

  it("scrolls the readout in place rather than growing the node (and opts out of canvas zoom)", () => {
    render(<ValuePlot nodeId="lag" history={fakeHistory(wide).source} />);
    // A node whose HEIGHT depends on its bag shoves a dense network around; a fixed
    // window keeps every node the same size whatever it publishes. React Flow reads
    // `nowheel` off the wheel target, so without it the wheel zooms the canvas instead of
    // scrolling the list it is pointed at.
    expect(screen.getByLabelText("Channels of lag").className).toContain("nowheel");
  });

  it("a bag that FITS is a plain row — no scroll box, and the canvas still zooms over it", () => {
    render(<ValuePlot nodeId="lag" history={fakeHistory(window(0.5)).source} />);
    // The opt-out is a cost every node would otherwise pay to solve `audioIn`'s problem.
    expect(screen.getByLabelText("Channels of lag").className).not.toContain("nowheel");
  });
});
