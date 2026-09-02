// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ColorParameter, ColorStop, StopsParameter } from "@domain/types/parameters.ts";
import { installDomStubs } from "../testing/install-dom-stubs.ts";
import { ColorField } from "./color-field.tsx";
import { ColorPicker, PICKER_LOCKED_REASON } from "./color-picker.tsx";
import { linearToSrgb, srgbToLinear } from "./color.ts";
import { StopsField } from "./stops-field.tsx";
import type { EditPhase } from "./types.ts";

beforeAll(installDomStubs);
afterEach(cleanup);

/**
 * T896 — "an actual color picker in addition to the RGBA fields, wherever we deal with
 * colour values".
 *
 * The three things that make this an addition rather than a regression, one describe
 * block each: the picker and the numeric fields must mean the same colour (in DISPLAY
 * space — §V618 — or the picker lies by ~1.5 stops), a colour with a non-static channel
 * must refuse a picker write (§V113 — the picker writes all four at once and would
 * clobber a per-channel expression), and every colour site must mount THE SAME control
 * (§T886 — "reuse the same base component instead of duplicating it and then having
 * stuff become inconsistent").
 */

const displayColor: ColorParameter = {
  type: "color",
  label: "Tint",
  default: [0, 0, 0, 1],
  space: "display",
};

const linearColor: ColorParameter = {
  type: "color",
  label: "Light",
  default: [0, 0, 0, 1],
  space: "linear",
};

const stops: StopsParameter = {
  type: "stops",
  label: "Ramp",
  default: [{ position: 0, color: [0, 0, 0, 1] }],
  space: "display",
};

type Change<T> = [T, EditPhase];

function renderColor(
  definition: ColorParameter,
  value: readonly number[],
  componentDisabled?: readonly boolean[],
) {
  const changes: Change<readonly number[]>[] = [];
  render(
    <ColorField
      label={definition.label}
      value={value}
      definition={definition}
      {...(componentDisabled === undefined ? {} : { componentDisabled })}
      onChange={(next, phase) => changes.push([next, phase])}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: `${definition.label} — edit channels` }));
  return changes;
}

const picker = (name: string): HTMLInputElement =>
  screen.getByLabelText(name, { exact: false }) as HTMLInputElement;

describe("(a) the picker and the numeric fields agree, in display space (§V618)", () => {
  it("shows a display-space parameter's own numbers as its hex", () => {
    renderColor(displayColor, [1, 0.5, 0, 1]);
    // 0.5 * 255 = 127.5 -> 128 -> 0x80. No transfer function on a display parameter.
    expect(picker("Tint picker").value).toBe("#ff8000");
  });

  it("ENCODES a linear parameter for the picker instead of showing it raw", () => {
    renderColor(linearColor, [0.5, 0.5, 0.5, 1]);
    const byte = Math.round(linearToSrgb(0.5) * 255).toString(16);
    expect(picker("Light picker").value).toBe(`#${byte}${byte}${byte}`);
    // The whole point of §V618: linear 0.5 shown raw would be #808080, ~1.5 stops dark
    // against the 0.74 the eye actually sees.
    expect(picker("Light picker").value).not.toBe("#808080");
  });

  it("round-trips: what the picker writes is what the numeric fields then read", () => {
    const changes = renderColor(displayColor, [0, 0, 0, 1]);
    fireEvent.change(picker("Tint picker"), { target: { value: "#3399cc" } });
    const [written] = changes.at(-1) as Change<readonly number[]>;
    expect(written[0]).toBeCloseTo(0x33 / 255, 6);
    expect(written[1]).toBeCloseTo(0x99 / 255, 6);
    expect(written[2]).toBeCloseTo(0xcc / 255, 6);

    cleanup();
    renderColor(displayColor, written);
    expect(picker("Tint picker").value).toBe("#3399cc");
  });

  it("DECODES a picked colour back into a linear parameter's stored space", () => {
    const changes = renderColor(linearColor, [0, 0, 0, 1]);
    fireEvent.change(picker("Light picker"), { target: { value: "#3399cc" } });
    const [written] = changes.at(-1) as Change<readonly number[]>;
    expect(written[0]).toBeCloseTo(srgbToLinear(0x33 / 255), 6);
    expect(written[1]).toBeCloseTo(srgbToLinear(0x99 / 255), 6);
    expect(written[2]).toBeCloseTo(srgbToLinear(0xcc / 255), 6);

    cleanup();
    renderColor(linearColor, written);
    expect(picker("Light picker").value).toBe("#3399cc");
  });

  it("leaves alpha alone — the picker has no alpha, so it must not reset one", () => {
    const changes = renderColor(displayColor, [0, 0, 0, 0.25]);
    fireEvent.change(picker("Tint picker"), { target: { value: "#ffffff" } });
    expect((changes.at(-1) as Change<readonly number[]>)[0][3]).toBe(0.25);
  });

  it("streams live while the OS panel drags and commits once when it settles (§V15)", () => {
    const changes = renderColor(displayColor, [0, 0, 0, 1]);
    const input = picker("Tint picker");
    fireEvent.input(input, { target: { value: "#112233" } });
    fireEvent.input(input, { target: { value: "#223344" } });
    fireEvent.change(input, { target: { value: "#334455" } });
    expect(changes.map(([, phase]) => phase)).toEqual(["live", "live", "commit"]);
  });
});

describe("(b) §V113 — a colour with a non-static channel does not accept a picker write", () => {
  it("refuses the write and says why", () => {
    // `color.g` runs an expression; r/b/a are static. The picker emits one RGB triple,
    // so honouring it would silently overwrite g's expression.
    const changes = renderColor(displayColor, [1, 0.5, 0, 1], [false, true, false, false]);
    // Found by TYPE, not by its locked name: the refusal has to be proved even if the
    // control forgets to say why, and a name lookup would fail first and hide it.
    const input = document.querySelector('input[type="color"]') as HTMLInputElement;

    fireEvent.input(input, { target: { value: "#000000" } });
    fireEvent.change(input, { target: { value: "#000000" } });
    expect(changes).toEqual([]);

    // ...and it is unavailable rather than silently inert, with the reason reachable.
    expect(input.disabled).toBe(true);
    expect(input.getAttribute("aria-label")).toBe(`Tint picker — ${PICKER_LOCKED_REASON}`);
    expect(input.parentElement?.getAttribute("title")).toBe(PICKER_LOCKED_REASON);
  });

  it("stays available when every channel is static", () => {
    renderColor(displayColor, [1, 0.5, 0, 1], [false, false, false, false]);
    expect(picker("Tint picker").disabled).toBe(false);
  });

  it("the numeric fields keep their PER-CHANNEL seat — only the picker is all-or-nothing", () => {
    const changes = renderColor(displayColor, [1, 0.5, 0, 1], [false, true, false, false]);
    // g is unavailable because g's own mode says so...
    expect((screen.getByRole("spinbutton", { name: "Tint G" }) as HTMLInputElement).disabled).toBe(true);
    // ...and r is still editable, which is the §V113 seat the picker cannot provide.
    const red = screen.getByRole("spinbutton", { name: "Tint R" }) as HTMLInputElement;
    expect(red.disabled).toBe(false);
    fireEvent.change(red, { target: { value: "0.25" } });
    fireEvent.blur(red);
    expect(changes.at(-1)?.[0][0]).toBeCloseTo(0.25, 6);
  });

  it("is unavailable when the colour AS A WHOLE is not static", () => {
    // The compound's own mode (bind, expression, driven) disables the control, and the
    // picker inherits that — mounted directly, because a disabled ColorField will not
    // even open its panel.
    const onChange = vi.fn();
    render(
      <ColorPicker label="Bound" value={[0, 0, 0, 1]} space="display" disabled onChange={onChange} />,
    );
    const input = picker(`Bound picker — ${PICKER_LOCKED_REASON}`);
    expect(input.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "#ffffff" } });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("(c) §T886 — every colour site mounts the SAME picker", () => {
  it("mounts it on a ramp stop, writing the stop's colour", () => {
    const changes: Change<readonly ColorStop[]>[] = [];
    render(
      <StopsField
        label="Ramp"
        value={[
          { position: 0, color: [0, 0, 0, 1] },
          { position: 1, color: [1, 1, 1, 1] },
        ]}
        definition={stops}
        onChange={(next, phase) => changes.push([next, phase])}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Ramp stop 2 colour" }));
    fireEvent.change(picker("Ramp stop 2 picker"), { target: { value: "#3399cc" } });

    const [written] = changes.at(-1) as Change<readonly ColorStop[]>;
    expect(written).toHaveLength(2);
    expect(written[0]?.color).toEqual([0, 0, 0, 1]);
    expect(written[1]?.color[0]).toBeCloseTo(0x33 / 255, 6);
    expect(written[1]?.color[2]).toBeCloseTo(0xcc / 255, 6);
    expect(written[1]?.position).toBe(1);
  });

  it("mounts it on a reflected vec4f knob, which is a ColorField like any other", () => {
    // T880's `lightColor: vec4f` reflects to `{ type: "color", space: "display" }`
    // (custom-wgsl.ts) — so it reaches the same control, and the picker comes with it.
    const changes = renderColor({ ...displayColor, label: "Light Color" }, [0.2, 0.2, 0.2, 1]);
    fireEvent.change(picker("Light Color picker"), { target: { value: "#ff8000" } });
    expect((changes.at(-1) as Change<readonly number[]>)[0][0]).toBeCloseTo(1, 6);
  });
});
