import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { serialiseMidiMapping } from "@domain/midi/midi-mapping.ts";
import type { MidiAccessState } from "@domain/midi/midi-status.ts";
import { MidiSection, type MidiSectionSurface } from "./midi-section.tsx";
import type { ParameterEditor } from "./parameter-editor.ts";

/**
 * T942 tier 1 — the LEARN GESTURE, and the sentence beside it when there is nothing to
 * learn from.
 *
 * Two claims are checked here and neither is checkable anywhere else:
 *
 * 1. **A learn is an ordinary parameter edit.** Arm a row, move a control, and what leaves
 *    this component is one `setParameter` on `mapping` — which is what buys undo, autosave,
 *    the diff and the agent surface for free. A component that kept the binding in its own
 *    state would look identical on screen and lose the mapping on reload.
 * 2. **The section is present, and says which absence it is, when MIDI is unavailable.**
 *    §V359: hiding it would make "this browser has no Web MIDI" and "nobody built this" the
 *    same pixels, and Safari makes the first of those permanent.
 */

afterEach(cleanup);

const editorStub = (): ParameterEditor & { calls: unknown[][] } => {
  const calls: unknown[][] = [];
  return { calls, setParameter: (...args: unknown[]) => void calls.push(args) } as never;
};

/** A surface whose `arm` hands the listener straight back, so a test can "move a knob". */
function midiStub(state: MidiAccessState, ports: Array<{ id: string; name: string }> = []) {
  let armed: ((event: { reading: { source: { kind: "cc"; channel: number; number: number } } }) => void) | null = null;
  const requests: number[] = [];
  const surface: MidiSectionSurface = {
    state,
    ports,
    request: () => void requests.push(1),
    arm: (listener) => {
      armed = listener as typeof armed;
      return () => {
        armed = null;
      };
    },
  };
  return {
    surface,
    requests,
    isArmed: () => armed !== null,
    move: (number: number) => armed?.({ reading: { source: { kind: "cc", channel: 1, number } } }),
  };
}

const GRANTED: MidiAccessState = { kind: "granted" };

/** The stored mapping written by the LAST `setParameter` call, parsed back. */
function writtenMapping(editor: { calls: unknown[][] }): unknown {
  const last = editor.calls.at(-1);
  expect(last?.[1]).toBe("mapping");
  return JSON.parse(String(last?.[2]));
}

describe("the learn gesture writes the DOCUMENT, not component state", () => {
  it("arming, then moving a control, commits the binding as one parameter edit", () => {
    const editor = editorStub();
    const midi = midiStub(GRANTED, [{ id: "port-7", name: "Launch Control" }]);
    render(
      <MidiSection
        nodeId={"m" as never}
        device=""
        mapping={serialiseMidiMapping([{ channel: "cutoff", source: null, range: [0, 1], mode: "absolute" }])}
        midi={midi.surface}
        editor={editor}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Learn" }));
    expect(midi.isArmed()).toBe(true);
    // The armed row says what to do next, rather than staying labelled "Learn".
    expect(screen.getByRole("button", { name: "Move a control" })).toBeTruthy();

    midi.move(19);

    expect(editor.calls).toHaveLength(1);
    expect(editor.calls[0]?.[0]).toBe("m");
    expect(editor.calls[0]?.[3]).toBe("commit");
    expect(writtenMapping(editor)).toEqual([
      { channel: "cutoff", source: { kind: "cc", channel: 1, number: 19 }, range: [0, 1], mode: "absolute" },
    ]);
  });

  it("a second press CANCELS an armed row — arming must not be a trap", () => {
    // The state you land in when you armed the wrong row: without a cancel the only exit
    // is to move a control, which is exactly what you cannot do.
    const midi = midiStub(GRANTED);
    render(
      <MidiSection
        nodeId={"m" as never}
        device=""
        mapping={serialiseMidiMapping([{ channel: "cutoff", source: null, range: [0, 1], mode: "absolute" }])}
        midi={midi.surface}
        editor={editorStub()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Learn" }));
    fireEvent.click(screen.getByRole("button", { name: "Move a control" }));
    expect(midi.isArmed()).toBe(false);
    expect(screen.getByRole("button", { name: "Learn" })).toBeTruthy();
  });

  it("adding a control names it uniquely, because a name is an address (§V129)", () => {
    const editor = editorStub();
    render(
      <MidiSection
        nodeId={"m" as never}
        device=""
        mapping={serialiseMidiMapping([{ channel: "control1", source: null, range: [0, 1], mode: "absolute" }])}
        midi={midiStub(GRANTED).surface}
        editor={editor}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add control" }));
    expect(writtenMapping(editor)).toEqual([
      { channel: "control1", source: null, range: [0, 1], mode: "absolute" },
      { channel: "control2", source: null, range: [0, 1], mode: "absolute" },
    ]);
  });

  it("shows what a learned row is bound to, in the hardware's own words", () => {
    render(
      <MidiSection
        nodeId={"m" as never}
        device=""
        mapping={serialiseMidiMapping([
          { channel: "cutoff", source: { kind: "cc", channel: 1, number: 74 }, range: [0, 1], mode: "absolute" },
        ])}
        midi={midiStub(GRANTED).surface}
        editor={editorStub()}
      />,
    );
    expect(screen.getByText("CC 74 ch 1")).toBeTruthy();
  });

  it("says LOUDLY when the stored mapping will not parse (§V338/§V469)", () => {
    // Otherwise every channel quietly reads its rest value with nothing anywhere saying
    // why — a detected problem nobody is told about.
    render(
      <MidiSection
        nodeId={"m" as never}
        device=""
        mapping="[{ not json"
        midi={midiStub(GRANTED).surface}
        editor={editorStub()}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("not valid JSON");
  });
});

describe("§V359 — the section is PRESENT when MIDI is not, and names which absence", () => {
  const renderWith = (state: MidiAccessState) => {
    const midi = midiStub(state);
    render(
      <MidiSection
        nodeId={"m" as never}
        device=""
        mapping="[]"
        midi={midi.surface}
        editor={editorStub()}
      />,
    );
    return midi;
  };

  it("Safari — no Web MIDI at any version — says so, and offers no dead button", () => {
    renderWith({ kind: "unsupported" });
    expect(screen.getByRole("status").textContent).toContain("no Web MIDI");
    expect(screen.queryByRole("button", { name: "Enable MIDI" })).toBeNull();
  });

  it("nothing asked yet offers the button, and pressing it is what asks", () => {
    // The §V476 half at the UI end: the request happens on a click and on nothing else.
    const midi = renderWith({ kind: "idle" });
    expect(midi.requests).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Enable MIDI" }));
    expect(midi.requests).toEqual([1]);
  });

  it("a refusal is a different sentence from an absent API, and is retryable", () => {
    renderWith({ kind: "denied" });
    expect(screen.getByRole("status").textContent).toContain("refused");
    expect(screen.getByRole("button", { name: "Enable MIDI" })).toBeTruthy();
  });

  it("granted with no device attached says to attach one, not that something failed", () => {
    renderWith({ kind: "granted" });
    expect(screen.getByRole("status").textContent).toContain("no inputs found");
    expect(screen.getByText("Attach a controller.")).toBeTruthy();
  });

  it("Learn is unavailable — visibly — until access is granted", () => {
    const midi = midiStub({ kind: "idle" });
    render(
      <MidiSection
        nodeId={"m" as never}
        device=""
        mapping={serialiseMidiMapping([{ channel: "cutoff", source: null, range: [0, 1], mode: "absolute" }])}
        midi={midi.surface}
        editor={editorStub()}
      />,
    );
    // Disabled rather than hidden: the row still shows what it WOULD do, and the status
    // above it says what to do first.
    expect((screen.getByRole("button", { name: "Learn" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("the device picker offers Any input, so a node works before anyone visits it", () => {
    const midi = midiStub(GRANTED, [{ id: "port-7", name: "Launch Control" }]);
    render(
      <MidiSection nodeId={"m" as never} device="" mapping="[]" midi={midi.surface} editor={editorStub()} />,
    );
    const select = screen.getByLabelText("MIDI input") as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual(["Any input", "Launch Control"]);
    expect(select.value).toBe("");
  });
});
