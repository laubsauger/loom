// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { ProblemsPanel } from "./problems-panel.tsx";
import { ShaderStatusBadge } from "./shader-status-badge.tsx";
import { shaderStatusBadgeProps } from "./shader-status.ts";
import { ShaderDiagnosticCode } from "./shader-diagnostics.ts";
import type { ShaderCompileState } from "./compile-pipeline.ts";

/**
 * jsdom has no layout engine, and CodeMirror measures the document it renders. These
 * fill the two gaps it actually touches; without them the view throws on its first
 * measure pass.
 */
function installCodeMirrorStubs(): void {
  const range = Range.prototype as unknown as Record<string, unknown>;
  range["getClientRects"] ??= () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} });
  range["getBoundingClientRect"] ??= () => ({
    x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}),
  });
}

beforeAll(() => {
  installDomStubs();
  installCodeMirrorStubs();
});
afterEach(cleanup);

function stateWith(overrides: Partial<ShaderCompileState> = {}): ShaderCompileState {
  return {
    phase: "idle",
    nodeId: "node-1",
    program: null,
    stale: false,
    errors: [],
    warnings: [],
    info: [],
    compileCount: 0,
    cacheHits: 0,
    ...overrides,
  };
}

function diagnostic(
  severity: RuntimeDiagnostic["severity"],
  message: string,
  line?: number,
): RuntimeDiagnostic {
  return {
    severity,
    code:
      severity === "error"
        ? ShaderDiagnosticCode.error
        : severity === "warning"
          ? ShaderDiagnosticCode.warning
          : ShaderDiagnosticCode.info,
    message,
    nodeId: "node-1",
    source: line === undefined ? { file: "node-1" } : { file: "node-1", line, column: 5 },
  };
}

/**
 * The panel that used to be tested here is gone (T337, B35): `ShaderEditorPanel` was
 * rendered by nothing while the app filled the slot with `ShaderPane`. Its §V9 stale line
 * and §V27 counts were folded into that pane, and the assertions moved with them — see
 * `app/dock-panes.test.tsx`. Deleting the pane without moving its tests would have thrown
 * away the only checks that either behaviour exists.
 */

describe("problems panel (§V27)", () => {
  const DIAGNOSTICS = [
    diagnostic("error", "unresolved identifier 'colour'", 12),
    diagnostic("warning", "unused variable 'k'", 4),
    diagnostic("error", "expected ';'", 13),
  ];

  it("puts warnings in their own group, apart from errors", () => {
    render(<ProblemsPanel diagnostics={DIAGNOSTICS} />);

    const errors = screen.getByRole("region", { name: "errors" });
    const warnings = screen.getByRole("region", { name: "warnings" });
    expect(errors.textContent).toContain("unresolved identifier 'colour'");
    expect(errors.textContent).not.toContain("unused variable");
    expect(warnings.textContent).toContain("unused variable 'k'");
  });

  it("shows the line and column each message maps to", () => {
    render(<ProblemsPanel diagnostics={DIAGNOSTICS} />);
    expect(screen.getByRole("region", { name: "errors" }).textContent).toContain("12:5");
  });

  it("lets a message be selected and copied, and does not jump while selecting", async () => {
    // The row is a <button> so it can be reached by keyboard, and browsers make button text
    // unselectable — so an error could be read but never copied, which is the first thing
    // anyone does with one. The text opts back in; the click guard is what stops the drag
    // that ends a selection from also navigating the editor out from under it.
    const onSelect = vi.fn();
    render(<ProblemsPanel diagnostics={DIAGNOSTICS} onSelect={onSelect} />);

    const row = screen.getAllByRole("button")[0] as HTMLElement;
    const message = row.querySelector("span:nth-of-type(2)") as HTMLElement;
    const selection = row.ownerDocument.getSelection();
    if (selection === null) throw new Error("no selection API in this environment");
    const range = row.ownerDocument.createRange();
    range.selectNodeContents(message);
    selection.removeAllRanges();
    selection.addRange(range);
    expect(selection.toString().length).toBeGreaterThan(0);

    // `fireEvent.click`, not `userEvent.click`: a real select-drag ends with mouseup and
    // then a click while the selection still stands, whereas userEvent's synthetic mousedown
    // collapses the selection first and would model the wrong gesture entirely.
    fireEvent.click(row);
    expect(onSelect).not.toHaveBeenCalled();

    // With nothing selected the row still navigates — the guard is narrow, not a disable.
    selection.removeAllRanges();
    await userEvent.click(row);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("gives every problem a focusable control that reports the selection (V19)", async () => {
    const onSelect = vi.fn();
    render(<ProblemsPanel diagnostics={DIAGNOSTICS} onSelect={onSelect} />);

    const rows = screen.getAllByRole("button");
    expect(rows).toHaveLength(3);
    await userEvent.click(rows[0] as HTMLElement);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]?.[0]).toMatchObject({ severity: "error" });
  });

  it("says so when there is nothing wrong", () => {
    render(<ProblemsPanel diagnostics={[]} />);
    expect(screen.getByText("No problems")).toBeDefined();
  });
});

describe("node status badge (§V27)", () => {
  it("renders nothing for a clean, idle shader", () => {
    const { container } = render(<ShaderStatusBadge errorCount={0} warningCount={0} />);
    expect(container.firstChild).toBeNull();
  });

  it("summarises errors, warnings and staleness for a screen reader", () => {
    render(<ShaderStatusBadge errorCount={2} warningCount={1} stale />);
    expect(screen.getByRole("status").getAttribute("aria-label")).toBe(
      "Shader: 2 errors, 1 warnings, output stale",
    );
  });

  it("derives its props from a pipeline state", () => {
    const props = shaderStatusBadgeProps(
      stateWith({
        phase: "compiling",
        stale: true,
        errors: [diagnostic("error", "e", 1)],
        warnings: [diagnostic("warning", "w", 2)],
      }),
    );
    expect(props).toEqual({ errorCount: 1, warningCount: 1, stale: true, compiling: true });
  });
});

describe("T465 — clear empties, the truth repopulates", () => {
  it("offers Clear only when given the verb, and it fires", () => {
    const seen: string[] = [];
    const { rerender } = render(
      <ProblemsPanel
        diagnostics={[{ severity: "error", code: "x", message: "boom" }]}
        onClear={() => seen.push("cleared")}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear problems" }));
    expect(seen).toEqual(["cleared"]);

    // Without the verb, no button — the panel stays a pure view of its list.
    rerender(<ProblemsPanel diagnostics={[{ severity: "error", code: "x", message: "boom" }]} />);
    expect(screen.queryByRole("button", { name: "Clear problems" })).toBeNull();
  });

  it("an emptied list is just the empty state — nothing is remembered as dismissed", () => {
    // The design claim: clearing is not acknowledging. The panel renders whatever it
    // is GIVEN; a live problem handed back after a clear renders again, identically.
    const { rerender } = render(<ProblemsPanel diagnostics={[]} onClear={() => {}} />);
    expect(screen.getByText("No problems")).toBeDefined();
    rerender(
      <ProblemsPanel
        diagnostics={[{ severity: "warning", code: "still.live", message: "still here" }]}
        onClear={() => {}}
      />,
    );
    expect(screen.getByText("still here")).toBeDefined();
  });
});
