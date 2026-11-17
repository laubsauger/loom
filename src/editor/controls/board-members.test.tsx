// @vitest-environment jsdom
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { fixtureContext, installFlowStubs, nodeProps } from "@editor/graph-canvas/testing.tsx";
import { CanvasFixture } from "@editor/graph-canvas/canvas-fixture.tsx";
import { NodeView } from "@editor/nodes/node-view.tsx";
import { createParameterEditor } from "@editor/inspector/parameter-editor.ts";
import type { FrameClock } from "@domain/types/frame.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { parsePresetBank, serializeCueList, serializePresetBank } from "@domain/presets/index.ts";
import { parsePanelBoard, serializePanelBoard, type StoredBoardItem } from "@nodes/definitions/controls.ts";
import { createAppRuntime, type AppRuntime } from "../../app/app-runtime.ts";
import { useControlBodies } from "./control-bodies.tsx";
import type { ControlWrite } from "./control-widget.tsx";
import { ControlsPane } from "./controls-pane.tsx";

/**
 * T1501b (§T1398b S6) — A BANK, A LAYER AND A CUE LIST ON A PANEL, as a performer meets them:
 * a strip of preset buttons that changes the look and lights the one that is live, a
 * layer's switch that cannot be flipped back by a second press of "off", a fader for its
 * opacity when there is room, and GO / BACK that run the set. Every press is asserted on
 * what the DOCUMENT holds afterwards and on what one undo puts back — never on which
 * handler ran — through the real app runtime and bus, on the real DOM.
 *
 * The Controls tab and the Panel node's canvas body draw from one derivation
 * (`panelBoard`); the last block mounts both and reads them back against each other.
 */
beforeAll(() => {
  installDomStubs();
  installFlowStubs();
});
afterEach(cleanup);

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

const add = (ref: string, type: string, label: string, parameters: Record<string, unknown> = {}): GraphPatchOperation =>
  ({ op: "addNode", ref: `$${ref}`, type, position: { x: 0, y: 0 }, label, parameters }) as GraphPatchOperation;

const LOOKS = serializePresetBank({
  version: 1,
  presets: [
    { name: "soft", values: { blur1: { size: 4 } } },
    { name: "hard", values: { blur1: { size: 20 } } },
  ],
});
const SET = serializeCueList({
  version: 1,
  cues: [
    { name: "1", bank: "looks", preset: "soft" },
    { name: "2", bank: "looks", preset: "hard" },
  ],
});
const BOARD: StoredBoardItem[] = [
  { member: "looks", rect: { x: 0, y: 0, w: 4, h: 1 } },
  { member: "fx", rect: { x: 4, y: 0, w: 2, h: 1 } },
  { member: "set", rect: { x: 0, y: 1, w: 4, h: 2 } },
];

interface DeskOptions {
  readonly board?: StoredBoardItem[] | null;
  readonly bank?: Record<string, unknown>;
  readonly layer?: Record<string, unknown>;
}

/** blur1 at size 9; bank `looks` (soft = 4, hard = 20); layer `fx`; cue list `set` (1 → soft, 2 → hard); one Panel. */
async function desk({ board = BOARD, bank = {}, layer = {} }: DeskOptions = {}): Promise<{ runtime: AppRuntime; ids: Record<string, NodeId> }> {
  const runtime = createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "tester", label: "Tester" } });
  const result = await runtime.bus.execute(
    "graph.applyPatch",
    {
      baseRevision: runtime.bus.store.getRevision(),
      label: "setup",
      operations: [
        add("blur", "blur", "blur1", { size: 9 }),
        add("looks", "presets", "looks", { targets: "blur1", presets: LOOKS, ...bank }),
        add("fx", "layer", "fx", layer),
        add("set", "cueList", "set", { cues: SET }),
        add("panel", "panel", "panel1", { title: "Desk", ...(board === null ? {} : { board: serializePanelBoard({ columns: 8, items: board }) }) }),
      ],
    },
    runtime.invocation,
  );
  expect(result.output.status).toBe("applied");
  return { runtime, ids: result.output.createdIds as Record<string, NodeId> };
}

function Tab({ runtime }: { runtime: AppRuntime }) {
  const graph = useSyncExternalStore(runtime.bus.store.subscribe, runtime.bus.store.getGraph);
  return <ControlsPane graph={graph} registry={runtime.registry} bus={runtime.bus} invocation={runtime.invocation} />;
}

/** One node on a canvas, with the product's control seams (`useControlBodies`). */
function OnCanvas({ runtime, nodeId }: { runtime: AppRuntime; nodeId: NodeId }) {
  const editor = useMemo(() => createParameterEditor({ bus: runtime.bus, context: runtime.invocation }), [runtime]);
  useEffect(() => () => editor.dispose(), [editor]);
  const write = useMemo<ControlWrite>(() => (id, entries, phase) => editor.setStored(id, entries, phase), [editor]);
  const bodies = useControlBodies({ bus: runtime.bus, invocation: runtime.invocation, write });
  const { value } = useMemo(() => fixtureContext({ store: runtime.bus.store, registry: runtime.bus.registry, ...bodies }), [runtime, bodies]);
  return (
    <CanvasFixture value={value}>
      <NodeView {...nodeProps(nodeId)} />
    </CanvasFixture>
  );
}

const undoDepth = (runtime: AppRuntime) => runtime.bus.store.getHistory(runtime.invocation.actor).undo.length;
const nodeOf = (runtime: AppRuntime, id: NodeId) => runtime.bus.store.getGraph().nodes[id]!;
const tabItem = (key: string) => document.querySelector(`[data-controls-pane] [data-board-item="${key}"]`) as HTMLElement;
async function undo(runtime: AppRuntime): Promise<void> {
  await act(async () => {
    await runtime.bus.execute("graph.undo", {}, runtime.invocation);
    await settle();
  });
}
async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
    await settle();
  });
}

function stubTrack(track: HTMLElement): void {
  track.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 10, right: 100, bottom: 10, x: 0, y: 0, toJSON: () => ({}) });
  track.setPointerCapture = () => undefined;
  track.releasePointerCapture = () => undefined;
  track.hasPointerCapture = () => true;
}
async function drag(track: HTMLElement, toX: number): Promise<void> {
  stubTrack(track);
  await act(async () => {
    fireEvent.pointerDown(track, { clientX: 30, clientY: 5, pointerId: 1 });
    fireEvent.pointerMove(track, { clientX: (30 + toX) / 2, clientY: 5, pointerId: 1 });
    fireEvent.pointerUp(track, { clientX: toX, clientY: 5, pointerId: 1 });
    await settle();
  });
}

/** The "+ Add…" list's own options: the nodes that join as what they are (a strip, a layer, GO and BACK). */
const named = (picker: HTMLSelectElement): Array<string | null> => [...picker.options].filter((option) => option.parentElement === picker).map((option) => option.textContent);
/** T1771b: the options in its "On/off switch for" group — every other node, as a switch. */
const switches = (picker: HTMLSelectElement): Array<string | null> => [...picker.options].filter((option) => option.parentElement !== picker).map((option) => option.textContent);

describe("T1501b — a bank's preset strip", () => {
  it("a press recalls the preset into its target and lights the button; one undo restores the target", async () => {
    const { runtime, ids } = await desk();
    render(<Tab runtime={runtime} />);
    const strip = tabItem("member:looks");
    // One button per preset, in bank order, none live before the first recall.
    expect([...strip.querySelectorAll("[data-preset]")].map((button) => [button.getAttribute("data-preset"), button.getAttribute("aria-pressed")])).toEqual([
      ["soft", "false"],
      ["hard", "false"],
    ]);
    const before = undoDepth(runtime);

    await click(within(strip).getByRole("button", { name: "hard" }));

    // The TARGET moved — that is what the button is for.
    expect(nodeOf(runtime, ids["$blur"]!).parameters["size"]).toBe(20);
    expect(undoDepth(runtime)).toBe(before + 1);
    expect(within(tabItem("member:looks")).getByRole("button", { name: "hard" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(tabItem("member:looks")).getByRole("button", { name: "soft" }).getAttribute("aria-pressed")).toBe("false");

    await undo(runtime);
    expect(nodeOf(runtime, ids["$blur"]!).parameters["size"]).toBe(9);
    expect(within(tabItem("member:looks")).getByRole("button", { name: "hard" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("a recall the bus refuses says why on the strip and changes nothing", async () => {
    // The preset's only target is gone, so nothing is left to apply (ruling 4).
    const { runtime, ids } = await desk();
    await act(async () => {
      await runtime.bus.execute("graph.removeNodes", { nodeIds: [ids["$blur"]!] }, runtime.invocation);
    });
    render(<Tab runtime={runtime} />);
    const revision = runtime.bus.store.getRevision();
    await click(within(tabItem("member:looks")).getByRole("button", { name: "hard" }));
    expect(runtime.bus.store.getRevision()).toBe(revision);
    expect(within(tabItem("member:looks")).getByRole("alert").textContent).toContain("nothing left to apply");
  });

  it("while a morph runs on the frame clock the button being faded to shows how far along it is, and stops when it is done", async () => {
    const { runtime } = await desk({ bank: { morph: 2, curve: "linear" } });
    let clock: FrameClock | undefined = { epoch: "e1", absTimeSeconds: 10 };
    runtime.bus.attachFrameClock(() => clock);
    render(<Tab runtime={runtime} />);
    expect(document.querySelector("[data-morph-progress]")).toBeNull();

    await click(within(tabItem("member:looks")).getByRole("button", { name: "hard" }));
    const mark = () => tabItem("member:looks").querySelector("[data-morph-progress]");
    // On the button being faded TO, and nowhere else.
    expect(mark()?.closest("[data-preset]")?.getAttribute("data-preset")).toBe("hard");
    expect(mark()?.getAttribute("data-morph-progress")).toBe("0.00");

    // The transport produced one second of frames: half of a two-second fade.
    clock = { epoch: "e1", absTimeSeconds: 11 };
    await act(async () => {
      await settle(250);
    });
    expect(mark()?.getAttribute("data-morph-progress")).toBe("0.50");

    // Past its end the mark is gone — the button stays lit, because the preset is live.
    clock = { epoch: "e1", absTimeSeconds: 12.5 };
    await act(async () => {
      await settle(250);
    });
    expect(mark()).toBeNull();
    expect(within(tabItem("member:looks")).getByRole("button", { name: "hard" }).getAttribute("aria-pressed")).toBe("true");
  });
});

describe("T1527b — Store on a bank's strip", () => {
  const bankOf = (runtime: AppRuntime, id: NodeId) => {
    const parsed = parsePresetBank(nodeOf(runtime, id).parameters["presets"]);
    if (!parsed.ok) throw new Error(parsed.reason);
    return parsed.bank.presets;
  };

  it("captures the look as a NEW preset under the next free name — the others untouched — as one undo step, and it plays back", async () => {
    const { runtime, ids } = await desk();
    render(<Tab runtime={runtime} />);
    const before = undoDepth(runtime);
    const existing = bankOf(runtime, ids["$looks"]!);

    // blur1 sits at 9: neither soft (4) nor hard (20).
    await click(within(tabItem("member:looks")).getByRole("button", { name: "Store" }));

    expect(bankOf(runtime, ids["$looks"]!)).toEqual([...existing, { name: "preset3", values: { blur1: expect.objectContaining({ size: 9 }) } }]);
    expect(undoDepth(runtime)).toBe(before + 1);
    // The new preset is a button on the strip, before Store, and recalls what was stored.
    expect([...tabItem("member:looks").querySelectorAll("[data-preset]")].map((button) => button.getAttribute("data-preset"))).toEqual(["soft", "hard", "preset3"]);
    await click(within(tabItem("member:looks")).getByRole("button", { name: "hard" }));
    await click(within(tabItem("member:looks")).getByRole("button", { name: "preset3" }));
    expect(nodeOf(runtime, ids["$blur"]!).parameters["size"]).toBe(9);

    await undo(runtime);
    await undo(runtime);
    await undo(runtime);
    expect(bankOf(runtime, ids["$looks"]!)).toEqual(existing);
  });

  it("an empty bank is Store alone, so the first preset can be stored from the Panel", async () => {
    const { runtime, ids } = await desk({ bank: { presets: serializePresetBank({ version: 1, presets: [] }) } });
    render(<Tab runtime={runtime} />);
    expect(tabItem("member:looks").querySelectorAll("[data-preset]").length).toBe(0);
    await click(within(tabItem("member:looks")).getByRole("button", { name: "Store" }));
    expect(bankOf(runtime, ids["$looks"]!).map((preset) => preset.name)).toEqual(["preset1"]);
  });

  it("a Store the bus refuses says why on the strip and stores nothing", async () => {
    const { runtime, ids } = await desk({ bank: { targets: "" } });
    render(<Tab runtime={runtime} />);
    const revision = runtime.bus.store.getRevision();
    await click(within(tabItem("member:looks")).getByRole("button", { name: "Store" }));
    expect(runtime.bus.store.getRevision()).toBe(revision);
    expect(bankOf(runtime, ids["$looks"]!).map((preset) => preset.name)).toEqual(["soft", "hard"]);
    expect(within(tabItem("member:looks")).getByRole("alert").textContent).toContain("declares no targets");
  });
});

describe("T1501b — a layer's switch and fader", () => {
  it("two presses of OFF leave the layer off, in one undo step — the switch writes a state, not a flip", async () => {
    const { runtime, ids } = await desk();
    render(<Tab runtime={runtime} />);
    const toggle = within(tabItem("member:fx")).getByRole("switch", { name: /^fx/ });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    const before = undoDepth(runtime);

    // A double tap: the second press lands before the first has repainted the switch.
    await act(async () => {
      fireEvent.click(toggle);
      fireEvent.click(toggle);
      await settle();
    });

    expect(nodeOf(runtime, ids["$fx"]!).ui?.bypassed).toBe(true);
    expect(undoDepth(runtime)).toBe(before + 1);
    expect(within(tabItem("member:fx")).getByRole("switch", { name: /^fx/ }).getAttribute("aria-checked")).toBe("false");

    // A deliberate second press, after the repaint, turns it back on.
    await click(within(tabItem("member:fx")).getByRole("switch", { name: /^fx/ }));
    expect(nodeOf(runtime, ids["$fx"]!).ui?.bypassed).toBe(false);

    await undo(runtime);
    await undo(runtime);
    expect(nodeOf(runtime, ids["$fx"]!).ui?.bypassed ?? false).toBe(false);
  });

  it("is the switch alone at 2×1; with room the fader drags Opacity as one undo step", async () => {
    const small = await desk();
    const first = render(<Tab runtime={small.runtime} />);
    expect(tabItem("member:fx").querySelector("[data-layer-fader]")).toBeNull();
    first.unmount();

    const wide: StoredBoardItem[] = [{ member: "fx", rect: { x: 0, y: 0, w: 4, h: 1 } }];
    const { runtime, ids } = await desk({ board: wide });
    render(<Tab runtime={runtime} />);
    const before = undoDepth(runtime);
    expect(within(tabItem("member:fx")).getByRole("slider", { name: "Opacity" }).getAttribute("aria-valuenow")).toBe("1");

    await drag(within(tabItem("member:fx")).getByRole("slider", { name: "Opacity" }), 60);

    expect(nodeOf(runtime, ids["$fx"]!).parameters["opacity"]).toBeCloseTo(0.6, 6);
    expect(within(tabItem("member:fx")).getByRole("slider", { name: "Opacity" }).getAttribute("aria-valuenow")).toBe("0.6");
    expect(undoDepth(runtime)).toBe(before + 1);
    await undo(runtime);
    expect(nodeOf(runtime, ids["$fx"]!).parameters["opacity"]).toBe(1);
  });

  it("T1527b: the switch names the picture — by name, and “wired” while a wire feeds it, since the wire wins (B233)", async () => {
    const { runtime, ids } = await desk({ board: [{ member: "fx", rect: { x: 0, y: 0, w: 4, h: 2 } }], layer: { picture: "city" } });
    let street = "" as NodeId;
    await act(async () => {
      const added = await runtime.bus.execute(
        "graph.applyPatch",
        { baseRevision: runtime.bus.store.getRevision(), operations: [{ op: "addNode", ref: "$street", type: "solid", position: { x: 0, y: 0 }, label: "street" }] },
        runtime.invocation,
      );
      street = (added.output.createdIds as Record<string, NodeId>)["$street"]!;
    });
    render(<Tab runtime={runtime} />);
    const toggle = () => within(tabItem("member:fx")).getByRole("switch", { name: /^fx/ });
    expect(toggle().textContent).toContain("fx · city");

    // A wire into Picture: the name is dormant, so the item must not claim the layer shows "city".
    await act(async () => {
      await runtime.bus.execute(
        "graph.applyPatch",
        {
          baseRevision: runtime.bus.store.getRevision(),
          operations: [{ op: "connect", source: { nodeId: street, portId: "out" }, target: { nodeId: ids["$fx"]!, portId: "picture" } }],
        },
        runtime.invocation,
      );
      await settle();
    });
    expect(toggle().textContent).toContain("fx · wired");
    expect(toggle().textContent).not.toContain("city");

    // Disconnecting returns the layer to its name, and the item with it.
    await undo(runtime);
    expect(toggle().textContent).toContain("fx · city");
  });

  it("T1527b: at the bare 2×1 switch the picture is only on hover — the phone's rule", async () => {
    const { runtime } = await desk({ layer: { picture: "city" } });
    render(<Tab runtime={runtime} />);
    const toggle = within(tabItem("member:fx")).getByRole("switch", { name: /^fx/ });
    expect(toggle.textContent).not.toContain("city");
    expect(tabItem("member:fx").querySelector("[data-layer-picture]")?.getAttribute("title")).toBe("fx shows city");
  });

  it("a driven Opacity is shown and refuses the drag", async () => {
    const driven = { mode: "expression", bindings: { static: { kind: "static", value: 0.5 }, expression: { kind: "expression", source: "0.25 + 0.5" } } };
    const { runtime, ids } = await desk({ board: [{ member: "fx", rect: { x: 0, y: 0, w: 4, h: 2 } }], layer: { opacity: driven } });
    render(<Tab runtime={runtime} />);
    const fader = within(tabItem("member:fx")).getByRole("slider", { name: "Opacity" });
    expect(fader.getAttribute("title")).toContain("driven");
    const revision = runtime.bus.store.getRevision();

    await drag(fader, 60);

    expect(runtime.bus.store.getRevision()).toBe(revision);
    expect(nodeOf(runtime, ids["$fx"]!).parameters["opacity"]).toEqual(driven);
  });
});

/**
 * T1771b — ANY NODE NAMED ON A BOARD IS ITS ON/OFF SWITCH. The performer's case is one
 * effect or one source rig to take out and bring back mid-show, with no bank built for it:
 * the tile must switch the node itself (its bypass, the flag a Layer's switch and a preset's
 * `on` write), and must write the state pressed, so a double tap cannot switch it back.
 */
describe("T1771b — any other node on a board is its on/off switch", () => {
  const withBlur: StoredBoardItem[] = [...BOARD, { member: "blur1", rect: { x: 6, y: 0, w: 2, h: 1 } }];

  it("a board item naming a Blur draws a switch; OFF bypasses the node, twice is one undo step, ON brings it back", async () => {
    const { runtime, ids } = await desk({ board: withBlur });
    render(<Tab runtime={runtime} />);
    const toggle = () => within(tabItem("member:blur1")).getByRole("switch", { name: /^blur1/ });
    expect(tabItem("member:blur1").querySelector("[data-board-member]")?.getAttribute("data-board-member")).toBe("switch");
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    const before = undoDepth(runtime);

    await act(async () => {
      fireEvent.click(toggle());
      fireEvent.click(toggle());
      await settle();
    });
    expect(nodeOf(runtime, ids["$blur"]!).ui?.bypassed).toBe(true);
    // The flag a preset's `on` and a Layer's switch write: not mute, and no parameter moved.
    expect(nodeOf(runtime, ids["$blur"]!).ui?.muted ?? false).toBe(false);
    expect(nodeOf(runtime, ids["$blur"]!).parameters["size"]).toBe(9);
    expect(undoDepth(runtime)).toBe(before + 1);
    expect(toggle().getAttribute("aria-checked")).toBe("false");

    await click(toggle());
    expect(nodeOf(runtime, ids["$blur"]!).ui?.bypassed).toBe(false);
  });

  it("“+ Add…” puts it on the board as one patch, where it is then drawn as that switch", async () => {
    const { runtime, ids } = await desk();
    render(<Tab runtime={runtime} />);
    await click(screen.getByRole("button", { name: "Edit board" }));
    const picker = () => screen.getByRole("combobox", { name: "Add to panel" }) as HTMLSelectElement;
    expect(switches(picker())).toEqual(["blur1"]);
    const before = undoDepth(runtime);
    await act(async () => {
      fireEvent.change(picker(), { target: { value: ids["$blur"]! } });
      await settle();
    });
    expect(undoDepth(runtime)).toBe(before + 1);
    expect(switches(picker())).toEqual([]);
    expect(tabItem("member:blur1").querySelector("[data-board-member]")?.getAttribute("data-board-member")).toBe("switch");
    // It did not get the Blur's own "+ panel" button: that door stays the named kinds' (one per node of the document otherwise).
    const own = render(<OnCanvas runtime={runtime} nodeId={ids["$blur"]!} />);
    expect(within(own.container).queryByRole("button", { name: "Add to panel" })).toBeNull();
  });
});

describe("T1501b — a cue list's GO and BACK", () => {
  it("GO fires the standby cue and the list moves on; past the last cue it is refused, saying why; BACK fires the one before", async () => {
    const { runtime, ids } = await desk();
    render(<Tab runtime={runtime} />);
    const pad = () => tabItem("member:set");
    const where = () => [pad().querySelector("[data-cue-current]")?.textContent, pad().querySelector("[data-cue-standby]")?.textContent];
    const size = () => nodeOf(runtime, ids["$blur"]!).parameters["size"];
    expect(where()).toEqual(["—", "1"]);
    const before = undoDepth(runtime);

    await click(within(pad()).getByRole("button", { name: "GO" }));
    expect(size()).toBe(4);
    expect(nodeOf(runtime, ids["$set"]!).parameters["current"]).toBe("1");
    expect(where()).toEqual(["1", "2"]);
    // One GO is one undo step: the look AND the list's position.
    expect(undoDepth(runtime)).toBe(before + 1);

    await click(within(pad()).getByRole("button", { name: "GO" }));
    expect(size()).toBe(20);
    expect(where()).toEqual(["2", "—"]);

    // The end of the list, Wrap off: nothing fires, the list stays, and the pad says why.
    const revision = runtime.bus.store.getRevision();
    await click(within(pad()).getByRole("button", { name: "GO" }));
    expect(runtime.bus.store.getRevision()).toBe(revision);
    expect(where()).toEqual(["2", "—"]);
    expect(within(pad()).getByRole("alert").textContent).toContain("Wrap is off");

    await click(within(pad()).getByRole("button", { name: "BACK" }));
    expect(size()).toBe(4);
    expect(where()).toEqual(["1", "2"]);
    // The document moved, so the refusal it was about is gone.
    expect(within(pad()).queryByRole("alert")).toBeNull();

    // One undo takes BACK back whole: the look and the position together.
    await undo(runtime);
    expect(size()).toBe(20);
    expect(where()).toEqual(["2", "—"]);
  });

  it("T1527b: three rows tall it lists the cues; a tap stands one by, and GO then fires THAT cue", async () => {
    const small = await desk();
    const first = render(<Tab runtime={small.runtime} />);
    // The 4×2 a list lands at has no room for the cues: GO and BACK with the names, as before.
    expect(tabItem("member:set").querySelector("[data-cue-list]")).toBeNull();
    first.unmount();

    const SHOW = serializeCueList({
      version: 1,
      cues: [
        { name: "1", bank: "looks", preset: "soft" },
        { name: "2", bank: "looks", preset: "hard", note: "the drop" },
        { name: "3", bank: "looks", preset: "soft" },
      ],
    });
    const { runtime, ids } = await desk({ board: [{ member: "set", rect: { x: 0, y: 0, w: 4, h: 3 } }] });
    await act(async () => {
      await runtime.bus.execute(
        "graph.applyPatch",
        { baseRevision: runtime.bus.store.getRevision(), operations: [{ op: "setParameters", nodeId: ids["$set"]!, parameters: { cues: SHOW } }] },
        runtime.invocation,
      );
    });
    render(<Tab runtime={runtime} />);
    const pad = () => tabItem("member:set");
    const rows = () => [...pad().querySelectorAll("[data-cue]")].map((row) => [row.getAttribute("data-cue"), row.getAttribute("aria-pressed")]);
    // Every cue, in order; the one GO fires next is marked — before any GO, the first.
    expect(rows()).toEqual([
      ["1", "true"],
      ["2", "false"],
      ["3", "false"],
    ]);
    expect(within(pad()).getByRole("button", { name: /^2/ }).textContent).toBe("2the drop");
    const before = undoDepth(runtime);

    await click(within(pad()).getByRole("button", { name: /^3/ }));

    expect(nodeOf(runtime, ids["$set"]!).parameters["standby"]).toBe("3");
    expect(pad().querySelector("[data-cue-standby]")?.textContent).toBe("3");
    expect(rows()).toEqual([
      ["1", "false"],
      ["2", "false"],
      ["3", "true"],
    ]);
    // Standing a cue by fires nothing: the look is where it was.
    expect(nodeOf(runtime, ids["$blur"]!).parameters["size"]).toBe(9);
    expect(undoDepth(runtime)).toBe(before + 1);

    // GO fires the cue that was tapped, not the first.
    await click(within(pad()).getByRole("button", { name: "GO" }));
    expect(nodeOf(runtime, ids["$set"]!).parameters["current"]).toBe("3");
    expect(nodeOf(runtime, ids["$blur"]!).parameters["size"]).toBe(4);
  });
});

/** What a surface shows of the three kinds: which items, where, and the state each one draws. */
function shown(root: Element): unknown[] {
  return [...root.querySelectorAll("[data-board-item]")].map((item) => ({
    key: item.getAttribute("data-board-item"),
    rect: item.getAttribute("data-rect"),
    kind: item.querySelector("[data-board-member]")?.getAttribute("data-board-member") ?? null,
    layout: item.querySelector("[data-layout]")?.getAttribute("data-layout") ?? null,
    presets: [...item.querySelectorAll("[data-preset]")].map((button) => `${button.getAttribute("data-preset") ?? ""}:${button.getAttribute("aria-pressed") ?? ""}`),
    on: item.querySelector('[role="switch"]')?.getAttribute("aria-checked") ?? null,
    fader: item.querySelector('[role="slider"]')?.getAttribute("aria-valuenow") ?? null,
    cue: [item.querySelector("[data-cue-current]")?.textContent ?? null, item.querySelector("[data-cue-standby]")?.textContent ?? null],
    presses: [...item.querySelectorAll("button:not([data-preset]):not([role])")].map((button) => button.textContent),
  }));
}

describe("T1501b — the canvas body and the Controls tab draw the same three items", () => {
  const BIG: StoredBoardItem[] = [
    { member: "looks", rect: { x: 0, y: 0, w: 4, h: 1 } },
    { member: "fx", rect: { x: 4, y: 0, w: 4, h: 2 } },
    { member: "set", rect: { x: 0, y: 2, w: 4, h: 2 } },
  ];

  it("one derivation: the same members at the same rects in the same state, before and after a press on either", async () => {
    const { runtime, ids } = await desk({ board: BIG });
    const canvas = render(<OnCanvas runtime={runtime} nodeId={ids["$panel"]!} />);
    const tab = render(<Tab runtime={runtime} />);
    const body = () => canvas.container.querySelector(`[data-panel-body="${ids["$panel"]}"]`) as HTMLElement;
    const pane = () => tab.container.querySelector("[data-controls-pane]") as HTMLElement;

    expect(shown(body())).toEqual(shown(pane()));
    // …and it is the three kinds, not three empty boxes that happen to match.
    expect(shown(pane())).toEqual([
      { key: "member:looks", rect: "0,0,4,1", kind: "presets", layout: null, presets: ["soft:false", "hard:false"], on: null, fader: null, cue: [null, null], presses: ["Store"] },
      { key: "member:fx", rect: "4,0,4,2", kind: "layer", layout: "stacked", presets: [], on: "true", fader: "1", cue: [null, null], presses: [] },
      { key: "member:set", rect: "0,2,4,2", kind: "cueList", layout: "stacked", presets: [], on: null, fader: null, cue: ["—", "1"], presses: ["BACK", "GO"] },
    ]);

    // GO on the CANVAS body; a preset and the layer's switch in the TAB.
    await click(within(body().querySelector('[data-board-item="member:set"]') as HTMLElement).getByRole("button", { name: "GO" }));
    await click(within(pane().querySelector('[data-board-item="member:looks"]') as HTMLElement).getByRole("button", { name: "hard" }));
    await click(within(pane().querySelector('[data-board-item="member:fx"]') as HTMLElement).getByRole("switch", { name: /^fx/ }));

    expect(shown(body())).toEqual(shown(pane()));
    expect(shown(body()).map((item) => (item as { presets: string[]; on: string | null; cue: unknown[] }))).toMatchObject([
      { presets: ["soft:false", "hard:true"] },
      { on: "false" },
      { cue: ["1", "2"] },
    ]);
  });

  it("a member whose node is deleted leaves the board on both, and the others stay where they were", async () => {
    const { runtime, ids } = await desk({ board: BIG });
    const canvas = render(<OnCanvas runtime={runtime} nodeId={ids["$panel"]!} />);
    const tab = render(<Tab runtime={runtime} />);
    const keys = (root: Element) => [...root.querySelectorAll("[data-board-item]")].map((item) => `${item.getAttribute("data-board-item") ?? ""}@${item.getAttribute("data-rect") ?? ""}`);
    expect(keys(tab.container)).toEqual(["member:looks@0,0,4,1", "member:fx@4,0,4,2", "member:set@0,2,4,2"]);

    await act(async () => {
      await runtime.bus.execute("graph.removeNodes", { nodeIds: [ids["$looks"]!] }, runtime.invocation);
      await settle();
    });

    expect(keys(tab.container)).toEqual(["member:fx@4,0,4,2", "member:set@0,2,4,2"]);
    expect(keys(canvas.container)).toEqual(keys(tab.container));
  });
});

describe("T1501b — joining and leaving a Panel", () => {
  const boardOf = (runtime: AppRuntime, panelId: NodeId) => parsePanelBoard(nodeOf(runtime, panelId).parameters["board"]).items;

  it("a bank's own “+ panel” puts it on the only Panel as one patch, and then stops offering", async () => {
    const { runtime, ids } = await desk({ board: null });
    const bank = render(<OnCanvas runtime={runtime} nodeId={ids["$looks"]!} />);
    const before = undoDepth(runtime);

    await click(within(bank.container).getByRole("button", { name: "Add to panel" }));

    expect(boardOf(runtime, ids["$panel"]!)).toEqual([{ member: "looks", rect: { x: 0, y: 0, w: 4, h: 1 } }]);
    // No wire: these nodes join by name.
    expect(Object.keys(runtime.bus.store.getGraph().edges)).toEqual([]);
    expect(undoDepth(runtime)).toBe(before + 1);
    expect(within(bank.container).queryByRole("button", { name: "Add to panel" })).toBeNull();

    // And the Panel now shows its strip.
    const tab = render(<Tab runtime={runtime} />);
    expect(within(tab.container).getByRole("button", { name: "soft" })).not.toBeNull();

    await undo(runtime);
    expect(boardOf(runtime, ids["$panel"]!)).toEqual([]);
  });

  it("T1527b: with two Panels, edit mode's “+ Add…” puts a cue list on THIS Panel as one patch — the node's own “+ panel” has no one answer", async () => {
    const { runtime, ids } = await desk({ board: [{ member: "looks", rect: { x: 0, y: 0, w: 4, h: 1 } }] });
    let stage = "" as NodeId;
    await act(async () => {
      const added = await runtime.bus.execute(
        "graph.applyPatch",
        {
          baseRevision: runtime.bus.store.getRevision(),
          operations: [{ op: "addNode", ref: "$stage", type: "panel", position: { x: 400, y: 0 }, label: "panel2", parameters: { title: "Stage" } }],
        },
        runtime.invocation,
      );
      stage = (added.output.createdIds as Record<string, NodeId>)["$stage"]!;
    });
    // Two Panels: the cue list’s own button offers nothing, so this door is the one that is left.
    const own = render(<OnCanvas runtime={runtime} nodeId={ids["$set"]!} />);
    expect(within(own.container).queryByRole("button", { name: "Add to panel" })).toBeNull();
    own.unmount();

    render(<Tab runtime={runtime} />);
    // T1506b: one tab per Panel, at the bottom of the pane.
    await click(screen.getByRole("tab", { name: "Stage" }));
    await click(screen.getByRole("button", { name: "Edit board" }));
    const picker = () => screen.getByRole("combobox", { name: "Add to panel" }) as HTMLSelectElement;
    // What Stage lacks, by name: the three named kinds. T1771b: any other node (blur1) is
    // offered apart, as its on/off switch — it joins as a switch, never as one of these.
    expect(named(picker())).toEqual(["+ Add…", "fx", "looks", "set"]);
    expect(switches(picker())).toEqual(["blur1"]);
    const before = undoDepth(runtime);

    await act(async () => {
      fireEvent.change(picker(), { target: { value: ids["$set"]! } });
      await settle();
    });

    expect(boardOf(runtime, stage)).toEqual([{ member: "set", rect: { x: 0, y: 0, w: 4, h: 2 } }]);
    // The other Panel is untouched, and the cue list joined by name: no wire.
    expect(boardOf(runtime, ids["$panel"]!)).toEqual([{ member: "looks", rect: { x: 0, y: 0, w: 4, h: 1 } }]);
    expect(Object.keys(runtime.bus.store.getGraph().edges)).toEqual([]);
    expect(undoDepth(runtime)).toBe(before + 1);
    expect(named(picker())).toEqual(["+ Add…", "fx", "looks"]);
    expect(document.querySelector('[data-controls-pane] [data-board-item="member:set"]')).not.toBeNull();

    await undo(runtime);
    expect(boardOf(runtime, stage)).toEqual([]);
  });

  it("edit mode offers Remove from panel for a member — and no Drives list — and removing it is one undoable patch", async () => {
    const { runtime, ids } = await desk();
    render(<Tab runtime={runtime} />);
    await click(screen.getByRole("button", { name: "Edit board" }));
    // A press without a drag selects the item.
    const mover = screen.getByRole("button", { name: "Move looks" });
    await act(async () => {
      fireEvent.pointerDown(mover, { clientX: 100, clientY: 100, pointerId: 1 });
      fireEvent.pointerUp(mover, { clientX: 100, clientY: 100, pointerId: 1 });
      await settle();
    });
    const inspect = document.querySelector("[data-board-inspect]") as HTMLElement;
    expect(within(inspect).getByRole("heading", { name: "looks" })).not.toBeNull();
    expect(within(inspect).queryByText("Drives")).toBeNull();
    const before = undoDepth(runtime);

    await click(within(inspect).getByRole("button", { name: "Remove from panel" }));

    expect(boardOf(runtime, ids["$panel"]!).map((item) => ("member" in item ? item.member : item.label))).toEqual(["fx", "set"]);
    expect(undoDepth(runtime)).toBe(before + 1);
    // The bank itself is untouched — it left the Panel, not the project.
    expect(nodeOf(runtime, ids["$looks"]!)).toBeDefined();
    await undo(runtime);
    expect(boardOf(runtime, ids["$panel"]!).map((item) => ("member" in item ? item.member : item.label))).toEqual(["looks", "fx", "set"]);
  });
});

/**
 * T1541b — A LOOK'S INSTANCE JOINS A PANEL THE WAYS A BANK DOES (split from §T1505b). A
 * component whose definition holds a page bank is a bank from outside, so its instance takes
 * the bank's two doors onto a board — its own "+ panel" and edit mode's "+ Add…" (the drop
 * is `look-panel-join.test.ts`) — and lands as the bank's strip. An instance of a component
 * with NO page bank is offered by neither: an item naming it would draw nothing.
 */
describe("T1541b — a look's instance joins a Panel", () => {
  const LOOK_PRESETS = serializePresetBank({
    version: 1,
    presets: ["calm", "wide", "dark", "warm", "cold"].map((name, index) => ({ name, values: { parent: { glow: index } } })),
  });
  const boardOf = (runtime: AppRuntime, panelId: NodeId) => parsePanelBoard(nodeOf(runtime, panelId).parameters["board"]).items;

  /** `look` holds a page bank of five presets; `plain` is the same network with none. */
  function withComponents(runtime: AppRuntime): void {
    const blur = { id: "blur", type: "blur", label: "blur", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { size: 4 } };
    const shape = (componentId: string, name: string, nodes: Record<string, unknown>) => ({
      componentId,
      version: 1,
      name,
      graph: { revision: 0, nodes: { blur, ...nodes }, edges: {}, groups: {} },
      inputs: [],
      outputs: [{ externalId: "out", label: "Out", nodeId: "blur", portId: "out" }],
      parameters: [{ key: "glow", definition: { type: "number" as const, label: "Glow", default: 4, min: 0, max: 64 }, targets: [{ nodeId: "blur", key: "size" }] }],
    });
    runtime.components.register(
      shape("look", "Look", {
        looks: { id: "looks", type: "presets", label: "looks", definitionVersion: 1, position: { x: 0, y: 200 }, parameters: { targets: "parent", presets: LOOK_PRESETS } },
      }) as never,
    );
    runtime.components.register(shape("plain", "Plain", {}) as never);
  }

  async function looks(panels: number): Promise<{ runtime: AppRuntime; ids: Record<string, NodeId> }> {
    const runtime = createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "tester", label: "Tester" } });
    withComponents(runtime);
    const result = await runtime.bus.execute(
      "graph.applyPatch",
      {
        baseRevision: runtime.bus.store.getRevision(),
        label: "setup",
        operations: [
          add("city", "component:look@1", "city", { glow: 30 }),
          add("other", "component:plain@1", "other", { glow: 30 }),
          ...Array.from({ length: panels }, (_, index) => add(`panel${String(index + 1)}`, "panel", `panel${String(index + 1)}`, { title: index === 0 ? "Desk" : "Stage" })),
        ],
      },
      runtime.invocation,
    );
    expect(result.output.status).toBe("applied");
    return { runtime, ids: result.output.createdIds as Record<string, NodeId> };
  }

  it("its own “+ panel” puts it on the only Panel as its bank's strip, one patch, no wire — a plain instance offers none", async () => {
    const { runtime, ids } = await looks(1);
    const plain = render(<OnCanvas runtime={runtime} nodeId={ids["$other"]!} />);
    expect(within(plain.container).queryByRole("button", { name: "Add to panel" })).toBeNull();
    plain.unmount();
    const look = render(<OnCanvas runtime={runtime} nodeId={ids["$city"]!} />);
    const before = undoDepth(runtime);

    await click(within(look.container).getByRole("button", { name: "Add to panel" }));

    // Five presets at four a row: the strip lands two rows tall, as a bank of five does.
    expect(boardOf(runtime, ids["$panel1"]!)).toEqual([{ member: "city", rect: { x: 0, y: 0, w: 4, h: 2 } }]);
    expect(Object.keys(runtime.bus.store.getGraph().edges)).toEqual([]);
    expect(undoDepth(runtime)).toBe(before + 1);
    expect(within(look.container).queryByRole("button", { name: "Add to panel" })).toBeNull();

    // The Panel draws the look's strip, and a press recalls on the instance.
    const tab = render(<Tab runtime={runtime} />);
    await click(within(tab.container).getByRole("button", { name: "wide" }));
    expect(nodeOf(runtime, ids["$city"]!).parameters["glow"]).toBe(1);
    expect(nodeOf(runtime, ids["$city"]!).parameters["presetCurrent"]).toBe("wide");

    await undo(runtime);
    await undo(runtime);
    expect(boardOf(runtime, ids["$panel1"]!)).toEqual([]);
  });

  it("with two Panels, edit mode's “+ Add…” offers the look and not the plain instance, and puts it on THIS Panel", async () => {
    const { runtime, ids } = await looks(2);
    render(<Tab runtime={runtime} />);
    await click(screen.getByRole("tab", { name: "Stage" }));
    await click(screen.getByRole("button", { name: "Edit board" }));
    const picker = () => screen.getByRole("combobox", { name: "Add to panel" }) as HTMLSelectElement;
    // T1771b: the plain instance is no look, so it is offered as its on/off switch instead.
    expect(named(picker())).toEqual(["+ Add…", "city"]);
    expect(switches(picker())).toEqual(["other"]);
    const before = undoDepth(runtime);

    await act(async () => {
      fireEvent.change(picker(), { target: { value: ids["$city"]! } });
      await settle();
    });

    expect(boardOf(runtime, ids["$panel2"]!)).toEqual([{ member: "city", rect: { x: 0, y: 0, w: 4, h: 2 } }]);
    expect(boardOf(runtime, ids["$panel1"]!)).toEqual([]);
    expect(undoDepth(runtime)).toBe(before + 1);
    expect(named(picker())).toEqual(["+ Add…"]);
    expect(switches(picker())).toEqual(["other"]);
  });

  /**
   * T1541b — the desk strip re-reads on a CATALOGUE change. A Store or Delete on a look's
   * instance writes its component and leaves the document — and its revision — alone, so a
   * strip that re-rendered only on the document kept the presets it drew before.
   */
  it("the desk strip shows a preset stored into the look, and drops one deleted from it, with the document untouched", async () => {
    const { runtime, ids } = await looks(1);
    const board: StoredBoardItem[] = [{ member: "city", rect: { x: 0, y: 0, w: 8, h: 2 } }];
    await runtime.bus.execute(
      "graph.applyPatch",
      { baseRevision: runtime.bus.store.getRevision(), label: "board", operations: [{ op: "setParameters", nodeId: ids["$panel1"]!, parameters: { board: serializePanelBoard({ columns: 8, items: board }) } }] },
      runtime.invocation,
    );
    const tab = render(<Tab runtime={runtime} />);
    const strip = () => [...tab.container.querySelectorAll('[data-board-item="member:city"] [data-preset]')].map((button) => button.getAttribute("data-preset"));
    expect(strip()).toEqual(["calm", "wide", "dark", "warm", "cold"]);
    const revision = runtime.bus.store.getRevision();

    await act(async () => {
      const stored = await runtime.bus.execute("preset.store", { nodeId: ids["$city"]!, name: "bright" }, runtime.invocation);
      expect(stored.status).toBe("applied");
      await settle();
    });
    expect(runtime.bus.store.getRevision()).toBe(revision);
    expect(strip()).toEqual(["calm", "wide", "dark", "warm", "cold", "bright"]);

    await act(async () => {
      const deleted = await runtime.bus.execute("preset.delete", { nodeId: ids["$city"]!, name: "calm" }, runtime.invocation);
      expect(deleted.status).toBe("applied");
      await settle();
    });
    expect(runtime.bus.store.getRevision()).toBe(revision);
    expect(strip()).toEqual(["wide", "dark", "warm", "cold", "bright"]);
  });
});
