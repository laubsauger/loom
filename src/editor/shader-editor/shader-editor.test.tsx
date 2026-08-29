// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { ShaderEditorPanel } from "./shader-editor-panel.tsx";
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

const SHADER = "@fragment\nfn fs() -> @location(0) vec4f {\n  return vec4f(1.0);\n}";

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

describe("shader editor panel", () => {
  it("renders the shader text in a CodeMirror surface", () => {
    render(
      <ShaderEditorPanel
        nodeId="node-1"
        nodeTitle="Custom WGSL"
        source={SHADER}
        state={stateWith()}
        onSourceChange={() => {}}
      />,
    );
    const surface = screen.getByTestId("shader-editor-surface");
    expect(surface.querySelector(".cm-editor")).not.toBeNull();
    expect(surface.textContent).toContain("@fragment");
  });

  it("declares itself a `text` key context so mod+z undoes text, not the graph (§V53)", () => {
    // The keymap engine (track Q) resolves the narrowest context from this attribute.
    // Without it, undo inside the editor would reach the graph's undo command.
    render(
      <ShaderEditorPanel
        nodeId="node-1"
        source={SHADER}
        state={stateWith()}
        onSourceChange={() => {}}
      />,
    );
    // Must match the keymap engine's KEYMAP_CONTEXT_ATTRIBUTE exactly. These were two
    // different spellings for a while and V53 held only by accident, via the
    // contenteditable fallback — mod+z would have reached graph undo if that changed.
    expect(screen.getByTestId("shader-editor-surface").getAttribute("data-keymap-context")).toBe("text");
  });

  it("says the output is stale, and says why, when a compile failed (§V9)", () => {
    // The render did not stop and did not go black. If the UI stayed silent, the user
    // would read a working output as proof their broken edit compiled.
    render(
      <ShaderEditorPanel
        nodeId="node-1"
        source={SHADER}
        state={stateWith({ stale: true, errors: [diagnostic("error", "expected '}'", 3)] })}
        onSourceChange={() => {}}
      />,
    );
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("stale");
    expect(status.textContent).toContain("last valid shader");
  });

  it("shows no stale notice while everything compiles", () => {
    render(
      <ShaderEditorPanel
        nodeId="node-1"
        source={SHADER}
        state={stateWith()}
        onSourceChange={() => {}}
      />,
    );
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("counts errors and warnings separately in the status strip (§V27)", () => {
    render(
      <ShaderEditorPanel
        nodeId="node-1"
        source={SHADER}
        state={stateWith({
          errors: [diagnostic("error", "e1", 1), diagnostic("error", "e2", 2)],
          warnings: [diagnostic("warning", "w1", 4)],
        })}
        onSourceChange={() => {}}
      />,
    );
    expect(screen.getByLabelText("2 errors")).toBeDefined();
    expect(screen.getByLabelText("1 warnings")).toBeDefined();
  });

  it("explains itself when no shader-authorable node is selected", () => {
    render(
      <ShaderEditorPanel nodeId={null} source="" state={stateWith()} onSourceChange={() => {}} />,
    );
    expect(screen.getByText("No shader selected")).toBeDefined();
    expect(screen.queryByTestId("shader-editor-surface")).toBeNull();
  });
});

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
