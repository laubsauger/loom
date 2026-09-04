// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installDomStubs } from "../testing/install-dom-stubs.ts";
import { SwapDimensions, orientationOf } from "./swap-dimensions.tsx";

/**
 * T1157 — the swap control, at the level where the DERIVATION lives.
 *
 * The composed claim (a click really does swap the pixels the project renders at) is
 * asserted at the composed surface in `tests/integration/orientation-swap.test.tsx`,
 * because that is the only place both ends of the wire exist. What is here is the rule
 * this control is built on and the two things it must refuse: it must never invent an
 * orientation of its own, and it must never call back on a square.
 */

beforeAll(installDomStubs);
afterEach(cleanup);

const button = (): HTMLButtonElement =>
  screen.getByRole("button", { name: "Swap width and height" }) as HTMLButtonElement;

describe("orientation is DERIVED from the pair (T1157, §T1064)", () => {
  it("reads the two numbers and nothing else", () => {
    expect(orientationOf(1920, 1080)).toBe("landscape");
    expect(orientationOf(540, 960)).toBe("portrait");
    expect(orientationOf(1024, 1024)).toBe("square");
  });

  /*
   * The rule is `width < height`, not "the last button that was pressed". Rendering the
   * SAME pair twice — once each way round — must produce the two different words with no
   * state carried between the two renders, which is what "derive it, do not store it"
   * means in the only place a stored flag could hide.
   */
  it("re-derives the word from whatever pair it is handed, keeping nothing", () => {
    const view = render(<SwapDimensions width={960} height={540} onSwap={vi.fn()} />);
    expect(button().dataset["orientation"]).toBe("landscape");
    view.rerender(<SwapDimensions width={540} height={960} onSwap={vi.fn()} />);
    expect(button().dataset["orientation"]).toBe("portrait");
    view.rerender(<SwapDimensions width={960} height={540} onSwap={vi.fn()} />);
    expect(button().dataset["orientation"]).toBe("landscape");
  });
});

describe("a square says so rather than pretending (T1157)", () => {
  it("goes unavailable and names the size and the reason", () => {
    render(<SwapDimensions width={1024} height={1024} onSwap={vi.fn()} />);
    expect(button().disabled).toBe(true);
    // The hover text carries the reason (§V90) — a dead button with no explanation is
    // the thing this row was told not to ship.
    expect(button().title).toBe("1024 × 1024 is square — nothing to swap");
  });

  it("never calls back on a square, so no click can dirty a document", () => {
    const onSwap = vi.fn();
    render(<SwapDimensions width={1024} height={1024} onSwap={onSwap} />);
    fireEvent.click(button());
    expect(onSwap).not.toHaveBeenCalled();
  });
});

describe("the click hands back the swapped pair (T1157)", () => {
  it("does not let the press reach a drag surface above it (§V20)", () => {
    const nodeDrag = vi.fn();
    render(
      <div onPointerDown={nodeDrag}>
        <SwapDimensions width={960} height={540} onSwap={vi.fn()} />
      </div>,
    );
    fireEvent.pointerDown(button(), { pointerId: 1 });
    expect(nodeDrag).not.toHaveBeenCalled();
  });

  /*
   * LOAD-BEARING, LAST (§V910). The control does the arithmetic once so no call site can
   * get the two the wrong way round on the way to its command — so what it hands back is
   * the whole contract, and 960/540 are distinct on purpose: a `{width, height}` built
   * from the wrong side of the pair would be invisible with equal numbers.
   */
  it("emits height as the new width and width as the new height", () => {
    const onSwap = vi.fn();
    render(<SwapDimensions width={960} height={540} onSwap={onSwap} />);
    fireEvent.click(button());
    expect(onSwap).toHaveBeenCalledWith({ width: 540, height: 960 });
  });
});
