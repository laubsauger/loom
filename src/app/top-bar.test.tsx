// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { TooltipProvider } from "@ui/primitives/tooltip.tsx";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { TopBar } from "./top-bar.tsx";

beforeAll(installDomStubs);
afterEach(cleanup);

/**
 * T1256 — the top bar is transport, fps and GPU ms, and nothing that is not live.
 *
 * The `tier B` chip sat beside the GPU readout for the life of the app: a fact about the
 * device, read once at probe time, occupying the bar's scarcest space ten hours a day.
 * The owner's words: "taking up valuable space". The performance pane's GPU block already
 * carried the same value (`dock-panes.test.tsx` asserts it still does), so the chip was a
 * duplicate and it left. This test fails the moment it comes back — with any prop, under
 * any name — because it asserts on the RENDERED TEXT, not on the prop surface.
 */
describe("top bar — no capability tier (T1256)", () => {
  it("renders transport, fps and GPU ms and never the word tier", () => {
    const noop = () => {};
    render(
      <TooltipProvider>
        <TopBar onPlayPause={noop} onStep={noop} onResetTime={noop} fps={60} gpuMs={4.25} />
      </TooltipProvider>,
    );

    expect(screen.getByRole("group", { name: "Transport" })).toBeDefined();
    expect(screen.getByLabelText("Frames per second").textContent).toBe("60.0");
    expect(screen.getByLabelText("GPU time per frame").textContent).toBe("4.25 ms");
    expect(screen.queryByText(/\btier\b/i)).toBeNull();
    expect(document.body.textContent).not.toMatch(/\btier\b/i);
  });
});
