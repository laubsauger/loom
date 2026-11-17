import { describe, expect, it } from "vitest";
import type { LoomBus } from "../../domain/commands/bus.ts";
import { createDomainBus } from "../../domain/commands/index.ts";
import { contextFor, alice } from "../../domain/commands/test-support.ts";
import { createGraphStore } from "../../domain/graph/store.ts";
import { createSequentialIdFactory } from "../../domain/graph/ids.ts";
import type { GraphDocument } from "../../domain/types/graph.ts";
import type { GraphPatchOperation } from "../../domain/types/patch.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import type { FrameClock } from "../../domain/types/frame.ts";
import { serializeCueList, serializePresetBank } from "../../domain/presets/index.ts";
import { serializePanelBoard } from "../../nodes/definitions/controls.ts";
import { PHONE_COMMANDS, buildPhoneSnapshot, publishedMorphs, publishedTimelinePositions, vetPhoneSet } from "./phone-snapshot.ts";
import type { GraphComponentDefinition } from "../../domain/types/components.ts";
import { registerComponentCommands } from "../../domain/components/commands.ts";
import { componentNodeType } from "../../domain/components/component-type.ts";
import { createComponentSystem, type ComponentRegistry } from "../../domain/components/registry.ts";
import { PHONE_WRITABLE_KEYS, type PhoneBoardItem, type PhoneSet, type PhoneWidget } from "./phone-protocol.ts";

/**
 * T1396b — WHAT A PHONE SEES, AND WHAT IT MAY WRITE, decided from the document alone.
 *
 * The documents are built through the real bus and the real registry, so every node
 * carries the defaults `addNode` gives it — the vet sees what the product sees. What
 * matters to a phone user: only a Panel with Phone on is visible; its widgets appear under
 * the names the controls pane shows; nothing the phone sends reaches the document unless
 * it names a widget on a CURRENTLY published Panel with a key that widget lets a phone
 * write, in range.
 */

async function documentWith(operations: GraphPatchOperation[]): Promise<{ bus: LoomBus; ids: Record<string, string> }> {
  const store = createGraphStore({ ids: createSequentialIdFactory("p"), now: () => "2026-09-29T00:00:00.000Z" });
  const { bus } = createDomainBus({ store, registry: createNodeRegistry(allNodeDefinitions).view() });
  const result = await bus.execute(
    "graph.applyPatch",
    { baseRevision: bus.store.getRevision(), label: "setup", operations },
    contextFor(alice),
  );
  expect(result.output.status).toBe("applied");
  return { bus, ids: result.output.createdIds as Record<string, string> };
}

const add = (ref: string, type: string, label: string, parameters: Record<string, unknown> = {}): GraphPatchOperation =>
  ({ op: "addNode", ref: `$${ref}`, type, position: { x: 0, y: 0 }, label, parameters }) as GraphPatchOperation;

/** A published Panel naming four widgets, a second Panel NOT published, and an unlisted slider. */
const STAGE: GraphPatchOperation[] = [
  add("fader", "slider", "fader1", { channel: "heat", caption: "Heat", value: 0.25, min: 0, max: 2, step: 0.25 }),
  add("strobe", "toggle", "toggle1", { channel: "strobe" }),
  add("cut", "button", "button1", { channel: "cut", presses: 4 }),
  add("pad", "xyPad", "pad1", { channel: "aim", min: -1, max: 1, x: 0, y: 0.5 }),
  add("hidden", "slider", "secret1", { channel: "secret" }),
  add("stage", "panel", "panel1", { title: "Furnace", remote: true, layout: "# Melt\n> hands off\nfader1 toggle1 ghost\nbutton1, pad1\nnobody" }),
  add("desk", "panel", "panel2", { title: "Desk only", layout: "secret1" }),
];

const set = (handle: string, values: Record<string, number | boolean | string>, phase: PhoneSet["phase"] = "commit"): PhoneSet => ({
  handle,
  values,
  phase,
});

describe("T1396b — the snapshot a phone sees", () => {
  it("carries only Panels with Phone on, their rows, and the widgets the pane would show", async () => {
    const { bus, ids } = await documentWith(STAGE);
    const snapshot = buildPhoneSnapshot(bus.store.getGraph(), 7);
    expect(snapshot).toEqual({
      seq: 7,
      panels: [
        {
          title: "Furnace",
          rows: [
            { kind: "heading", text: "Melt" },
            { kind: "text", text: "hands off" },
            {
              kind: "widgets",
              widgets: [
                { kind: "slider", handle: ids["$fader"], caption: "Heat", value: 0.25, min: 0, max: 2, step: 0.25 },
                // No caption: the channel name, exactly as the pane captions it.
                { kind: "toggle", handle: ids["$strobe"], caption: "strobe", on: false },
              ],
            },
            {
              kind: "widgets",
              widgets: [
                { kind: "button", handle: ids["$cut"], caption: "cut", held: false },
                { kind: "xyPad", handle: ids["$pad"], caption: "aim", x: 0, y: 0.5, min: -1, max: 1 },
              ],
            },
            // `nobody` names no widget: the row is dropped rather than drawn empty.
          ],
        },
      ],
    });
    // The unpublished Panel's widget appears nowhere in what leaves the page.
    expect(JSON.stringify(snapshot)).not.toContain(ids["$hidden"]!);
  });

  it("leaves out a widget the document drives, and a Panel whose switch is driven", async () => {
    const driven = { mode: "expression", bindings: { expression: { kind: "expression", source: "0.5" } } };
    const { bus, ids } = await documentWith([
      add("fader", "slider", "fader1", { max: driven }),
      add("free", "slider", "fader2"),
      add("stage", "panel", "panel1", { remote: true, layout: "fader1 fader2" }),
      add("other", "panel", "panel2", { remote: driven, layout: "fader2" }),
    ]);
    const snapshot = buildPhoneSnapshot(bus.store.getGraph(), 1);
    expect(snapshot.panels).toHaveLength(1);
    const row = snapshot.panels[0]!.rows[0]!;
    expect(row.kind === "widgets" ? row.widgets.map((widget) => widget.handle) : []).toEqual([ids["$free"]]);
  });
});

describe("T1396b — the vet: a phone writes a published widget's own keys, in range, or nothing", () => {
  it("clamps a slider to its range and snaps it to its step", async () => {
    const { bus, ids } = await documentWith(STAGE);
    const graph = bus.store.getGraph();
    const fader = ids["$fader"]!;
    expect(vetPhoneSet(graph, set(fader, { value: 0.9 }))).toMatchObject({ ok: true, entries: { value: 1 } });
    expect(vetPhoneSet(graph, set(fader, { value: 0.6 }))).toMatchObject({ ok: true, entries: { value: 0.5 } });
    expect(vetPhoneSet(graph, set(fader, { value: 9 }))).toMatchObject({ ok: true, entries: { value: 2 } });
    expect(vetPhoneSet(graph, set(fader, { value: -3 }))).toMatchObject({ ok: true, entries: { value: 0 } });
    expect(vetPhoneSet(graph, set(ids["$pad"]!, { x: 5, y: -5 }))).toMatchObject({ ok: true, entries: { x: 1, y: -1 } });
  });

  it("counts a button press on the false→true edge only, and writes both keys every time", async () => {
    const { bus, ids } = await documentWith(STAGE);
    const cut = ids["$cut"]!;
    expect(vetPhoneSet(bus.store.getGraph(), set(cut, { held: true }, "live"))).toMatchObject({ ok: true, entries: { held: true, presses: 5 } });
    expect(vetPhoneSet(bus.store.getGraph(), set(cut, { held: false }))).toMatchObject({ ok: true, entries: { held: false, presses: 4 } });
    // Already held (by the desk, or a repeated message): not a second press.
    await bus.execute(
      "graph.applyPatch",
      { baseRevision: bus.store.getRevision(), operations: [{ op: "setParameters", nodeId: cut as never, parameters: { held: true } }] },
      contextFor(alice),
    );
    expect(vetPhoneSet(bus.store.getGraph(), set(cut, { held: true }, "live"))).toMatchObject({ ok: true, entries: { held: true, presses: 4 } });
  });

  it("refuses every write that is not a published widget's own key and value", async () => {
    const { bus, ids } = await documentWith(STAGE);
    const graph: GraphDocument = bus.store.getGraph();
    const refused = (write: PhoneSet): string => {
      const vet = vetPhoneSet(graph, write);
      expect(vet.ok).toBe(false);
      return vet.ok ? "" : vet.reason;
    };
    const unpublished = "A phone tried to move a control that is not published to the phone door.";
    // A handle that names nothing, a node that is no widget, a widget on no remote Panel.
    expect(refused(set("node-does-not-exist", { value: 1 }))).toBe(unpublished);
    expect(refused(set(ids["$stage"]!, { remote: false }))).toBe(unpublished);
    expect(refused(set(ids["$hidden"]!, { value: 1 }))).toBe(unpublished);
    // Keys the widget does not let a phone write — including one it HAS (a slider's max).
    expect(refused(set(ids["$fader"]!, { max: 100 }))).toMatch(/does not let a phone write/);
    expect(refused(set(ids["$cut"]!, { presses: 99 }))).toMatch(/does not let a phone write/);
    expect(refused(set(ids["$fader"]!, {}))).toMatch(/carried no values/);
    // Wrong value types, and numbers that are not finite.
    expect(refused(set(ids["$fader"]!, { value: true }))).toMatch(/not a finite number/);
    expect(refused(set(ids["$fader"]!, { value: Number.NaN }))).toMatch(/not a finite number/);
    expect(refused(set(ids["$pad"]!, { x: Number.POSITIVE_INFINITY }))).toMatch(/not a finite number/);
    expect(refused(set(ids["$strobe"]!, { on: 1 }))).toMatch(/not true or false/);
    expect(refused(set(ids["$cut"]!, { held: 0 }))).toMatch(/not true or false/);
    expect(refused({ handle: ids["$fader"]!, values: { value: 1 }, phase: "later" as never })).toMatch(/no gesture phase/);
  });

  it("refuses a driven widget on a published Panel, by name", async () => {
    const driven = { mode: "expression", bindings: { expression: { kind: "expression", source: "0.5" } } };
    const { bus, ids } = await documentWith([
      add("fader", "slider", "fader1", { caption: "Heat", value: driven }),
      add("stage", "panel", "panel1", { remote: true, layout: "fader1" }),
    ]);
    const vet = vetPhoneSet(bus.store.getGraph(), set(ids["$fader"]!, { value: 0.5 }));
    expect(vet).toEqual({ ok: false, reason: "“Heat” is driven by the document, so a phone cannot move it." });
  });

  it("stops accepting a Panel's widgets the moment its Phone switch goes off", async () => {
    const { bus, ids } = await documentWith(STAGE);
    const fader = ids["$fader"]!;
    expect(vetPhoneSet(bus.store.getGraph(), set(fader, { value: 1 })).ok).toBe(true);
    await bus.execute(
      "graph.applyPatch",
      {
        baseRevision: bus.store.getRevision(),
        operations: [{ op: "setParameters", nodeId: ids["$stage"] as never, parameters: { remote: false } }],
      },
      contextFor(alice),
    );
    expect(vetPhoneSet(bus.store.getGraph(), set(fader, { value: 1 }))).toEqual({
      ok: false,
      reason: "A phone tried to move a control that is not published to the phone door.",
    });
    expect(buildPhoneSnapshot(bus.store.getGraph(), 2).panels).toEqual([]);
  });
});

/**
 * T1512b — a Panel that follows its WIRING publishes its widgets in wiring order, and moves
 * when the order does: the phone reads the same `panelLayout` the desk draws from.
 */
describe("T1512b — the phone follows a Panel's wiring order", () => {
  const wire = (from: string, to: string): GraphPatchOperation =>
    ({ op: "connect", source: { nodeId: `$${from}`, portId: "out" }, target: { nodeId: `$${to}`, portId: "controls" } }) as GraphPatchOperation;
  const handles = (bus: LoomBus): string[] =>
    buildPhoneSnapshot(bus.store.getGraph(), 1).panels.flatMap((panel) =>
      panel.rows.flatMap((row) => (row.kind === "widgets" ? row.widgets.map((widget) => widget.handle) : [])),
    );

  it("publishes wired widgets in edge order, and a reorder reorders the phone", async () => {
    const { bus, ids } = await documentWith([
      add("fader", "slider", "fader1"),
      add("strobe", "toggle", "toggle1"),
      add("stage", "panel", "panel1", { title: "Wired", remote: true }),
      wire("strobe", "stage"),
      wire("fader", "stage"),
    ]);
    expect(handles(bus)).toEqual([ids["$strobe"], ids["$fader"]]);
    // A wired widget is published, so the vet lets the phone move it.
    expect(vetPhoneSet(bus.store.getGraph(), set(ids["$fader"]!, { value: 0.5 })).ok).toBe(true);

    const edges = Object.values(bus.store.getGraph().edges).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    await bus.execute(
      "graph.applyPatch",
      {
        baseRevision: bus.store.getRevision(),
        operations: [{ op: "reorderEdges", nodeId: ids["$stage"] as never, portId: "controls", edgeIds: [edges[1]!.id, edges[0]!.id] }],
      },
      contextFor(alice),
    );
    expect(handles(bus)).toEqual([ids["$fader"], ids["$strobe"]]);

    // Unwired, it is gone from the phone and the vet refuses it.
    await bus.execute(
      "graph.applyPatch",
      { baseRevision: bus.store.getRevision(), operations: [{ op: "disconnect", edgeIds: [edges[1]!.id] }] },
      contextFor(alice),
    );
    expect(handles(bus)).toEqual([ids["$strobe"]]);
    expect(vetPhoneSet(bus.store.getGraph(), set(ids["$fader"]!, { value: 0.5 })).ok).toBe(false);
  });
});

/**
 * T1503b (§T1398b ruling 12) — A BANK, A LAYER AND A CUE LIST ON THE PHONE. What the owner
 * ruled: a phone reaches the ones named on a Panel whose Phone switch is on, and nothing
 * else; it recalls, switches, fades and steps; it never stores. Each test is what a phone
 * user (or somebody on the wifi with the token) would meet.
 */
describe("T1503b — banks, layers and cue lists on the phone", () => {
  const LOOKS = serializePresetBank({
    version: 1,
    presets: [
      { name: "soft", values: { blur1: { size: 4 } } },
      { name: "hard", values: { blur1: { size: 20 } } },
    ],
  });
  const CUES = serializeCueList({
    version: 1,
    cues: [
      { name: "1", bank: "looks", preset: "soft" },
      { name: "2", bank: "looks", preset: "hard" },
    ],
  });
  const board = (members: ReadonlyArray<readonly [string, number, number, number, number]>): string =>
    serializePanelBoard({ columns: 8, items: members.map(([member, x, y, w, h]) => ({ member, rect: { x, y, w, h } })) });

  /** `looks`, `fx` and `set` on a published Panel; a second bank and layer on a Panel that is NOT. */
  const show = (layer: Record<string, unknown> = {}): GraphPatchOperation[] => [
    add("blur", "blur", "blur1", { size: 9 }),
    add("looks", "presets", "looks", { targets: "blur1", presets: LOOKS }),
    add("fx", "layer", "fx", layer),
    add("set", "cueList", "set", { cues: CUES }),
    add("stage", "panel", "panel1", { title: "Show", remote: true, board: board([["looks", 0, 0, 4, 1], ["fx", 4, 0, 4, 1], ["set", 0, 1, 4, 2]]) }),
    add("private", "presets", "privateLooks", { targets: "blur1", presets: LOOKS }),
    add("privateFx", "layer", "privateFx"),
    add("privateSet", "cueList", "privateSet", { cues: CUES }),
    add("desk", "panel", "panel2", { title: "Desk only", board: board([["privateLooks", 0, 0, 4, 1], ["privateFx", 4, 0, 2, 1], ["privateSet", 0, 1, 4, 2]]) }),
  ];

  const boardItems = (graph: GraphDocument, clock?: FrameClock): readonly PhoneBoardItem[] =>
    buildPhoneSnapshot(graph, 1, clock).panels[0]?.board?.items ?? [];
  const widgetOf = <K extends PhoneWidget["kind"]>(graph: GraphDocument, kind: K, clock?: FrameClock): Extract<PhoneWidget, { kind: K }> => {
    const found = boardItems(graph, clock).flatMap((item) => (item.kind === "widget" && item.widget.kind === kind ? [item.widget] : []))[0];
    if (found === undefined) throw new Error(`no ${kind} on the phone's board`);
    return found as Extract<PhoneWidget, { kind: K }>;
  };
  const refusal = (graph: GraphDocument, write: PhoneSet): string => {
    const vet = vetPhoneSet(graph, write);
    expect(vet.ok, JSON.stringify(write)).toBe(false);
    return vet.ok ? "" : vet.reason;
  };
  const UNPUBLISHED = "A phone tried to move a control that is not published to the phone door.";
  const patch = (bus: LoomBus, operations: GraphPatchOperation[]) =>
    bus.execute("graph.applyPatch", { baseRevision: bus.store.getRevision(), operations }, contextFor(alice));

  it("draws each at its rect with what a phone needs to operate it — and nothing from a Panel that is not published", async () => {
    const { bus, ids } = await documentWith(show({ opacity: 0.5 }));
    const snapshot = buildPhoneSnapshot(bus.store.getGraph(), 1);
    expect(snapshot.panels.map((panel) => panel.title)).toEqual(["Show"]);
    expect(snapshot.panels[0]!.board).toEqual({
      columns: 8,
      rows: 3,
      items: [
        {
          kind: "widget",
          rect: { x: 0, y: 0, w: 4, h: 1 },
          widget: { kind: "preset", handle: ids["$looks"], caption: "looks", presets: ["soft", "hard"], current: null, morphing: false },
        },
        {
          kind: "widget",
          rect: { x: 4, y: 0, w: 4, h: 1 },
          widget: { kind: "layer", handle: ids["$fx"], caption: "fx", on: true, opacity: 0.5, opacityWritable: true, picture: "" },
        },
        {
          kind: "widget",
          rect: { x: 0, y: 1, w: 4, h: 2 },
          // Nothing fired yet: GO would fire the first cue, and there is nothing to go BACK to.
          widget: { kind: "cueList", handle: ids["$set"], caption: "set", cues: ["1", "2"], notes: ["", ""], current: null, next: "1", canGo: true, canBack: false, following: false, structure: [] },
        },
      ],
    });
    const wire = JSON.stringify(snapshot);
    for (const hidden of ["$private", "$privateFx", "$privateSet"]) expect(wire).not.toContain(ids[hidden]!);
    // What a preset HOLDS never leaves the page: a phone gets names to press, not values.
    expect(wire).not.toContain("blur1");
  });

  /*
   * T1526b — the two fields the design (§9.2) names for the label: which picture a layer
   * holds, and what the operator noted on each cue. Both are the document's own words for a
   * person to read; neither is an id, and neither is anything a phone can write by.
   */
  it("T1526b: names a layer's picture — the name its Picture holds, and follows it when the layer is pointed at another look", async () => {
    const none = await documentWith(show());
    expect(widgetOf(none.bus.store.getGraph(), "layer").picture).toBe("");
    const { bus, ids } = await documentWith(show({ picture: " blur1 " }));
    // The NAME the owner typed (trimmed) — never the id of the node it names.
    expect(widgetOf(bus.store.getGraph(), "layer").picture).toBe("blur1");
    expect(JSON.stringify(widgetOf(bus.store.getGraph(), "layer"))).not.toContain(ids["$blur"]!);
    await patch(bus, [{ op: "setParameters", nodeId: ids["$fx"] as never, parameters: { picture: "city" } }]);
    expect(widgetOf(bus.store.getGraph(), "layer").picture).toBe("city");
    // A layer on a Panel that is not published sends nothing, its picture included.
    await patch(bus, [{ op: "setParameters", nodeId: ids["$privateFx"] as never, parameters: { picture: "backstageLook" } }]);
    expect(JSON.stringify(buildPhoneSnapshot(bus.store.getGraph(), 1))).not.toContain("backstageLook");
  });

  /*
   * §B233 made the picture a `wire: true` reference: a wire into it wins and the name goes
   * dormant. A phone label that still read the name would tell the performer the layer shows
   * a look it no longer shows — the desk's item says "wired", and so must the phone.
   */
  it("T1527b: says \"wired\" while a wire feeds the layer's picture, and the name again once the wire is gone", async () => {
    const { bus, ids } = await documentWith(show({ picture: "city" }));
    expect(widgetOf(bus.store.getGraph(), "layer").picture).toBe("city");
    await patch(bus, [{ op: "connect", source: { nodeId: ids["$blur"] as never, portId: "out" }, target: { nodeId: ids["$fx"] as never, portId: "picture" } }]);
    expect(widgetOf(bus.store.getGraph(), "layer").picture).toBe("wired");
    const graph = bus.store.getGraph();
    const intoPicture = Object.values(graph.edges).filter((edge) => edge.target.nodeId === ids["$fx"] && edge.target.portId === "picture");
    expect(intoPicture).toHaveLength(1);
    await patch(bus, [{ op: "disconnect", edgeIds: intoPicture.map((edge) => edge.id) }]);
    expect(widgetOf(bus.store.getGraph(), "layer").picture).toBe("city");
  });

  it("T1526b: sends each cue's note beside its name, in list order — empty where a cue has none", async () => {
    const cues = serializeCueList({
      version: 1,
      cues: [
        { name: "1", bank: "looks", preset: "soft", note: "house lights out" },
        { name: "2", bank: "looks", preset: "hard" },
        { name: "3", bank: "looks", preset: "soft", note: "  bows  " },
      ],
    });
    const { bus, ids } = await documentWith(show());
    await patch(bus, [{ op: "setParameters", nodeId: ids["$set"] as never, parameters: { cues } }]);
    const list = widgetOf(bus.store.getGraph(), "cueList");
    expect(list.cues).toEqual(["1", "2", "3"]);
    expect(list.notes).toEqual(["house lights out", "", "bows"]);
    // A note is read, never addressed: `standby` still takes the cue's NAME and nothing else.
    expect(refusal(bus.store.getGraph(), set(ids["$set"]!, { standby: "house lights out" }))).toMatch(/has no cue by the name/);
    expect(vetPhoneSet(bus.store.getGraph(), set(ids["$set"]!, { standby: "3" })).ok).toBe(true);
  });

  /*
   * T1526b: a refusal says WHICH control, so the phone that pressed can be shown the
   * sentence on it. The id is the vet's own — the node it found among the published ones —
   * and absent for a write that named nothing published: the handle a phone sent never
   * comes back, and an unpublished node's id never leaves the page.
   */
  it("T1526b: a refusal about a published control names it; one about anything else names nothing", async () => {
    const { bus, ids } = await documentWith(show({ opacity: { mode: "expression", bindings: { expression: { kind: "expression", source: "0.5" } } } }));
    const graph = bus.store.getGraph();
    const about = (write: PhoneSet): string | undefined => {
      const vet = vetPhoneSet(graph, write);
      expect(vet.ok, JSON.stringify(write)).toBe(false);
      return vet.ok ? undefined : vet.nodeId;
    };
    expect(about(set(ids["$looks"]!, { recall: "harder" }))).toBe(ids["$looks"]);
    expect(about(set(ids["$looks"]!, { recall: "hard" }, "live"))).toBe(ids["$looks"]);
    expect(about(set(ids["$looks"]!, { store: "mine" }))).toBe(ids["$looks"]);
    expect(about(set(ids["$fx"]!, { opacity: 0.2 }))).toBe(ids["$fx"]);
    expect(about(set(ids["$set"]!, { standby: "9" }))).toBe(ids["$set"]);
    expect(about(set(ids["$set"]!, { go: true, back: true }))).toBe(ids["$set"]);
    // Not published, a node that is no control, and a handle that names nothing at all.
    for (const handle of [ids["$private"]!, ids["$privateFx"]!, ids["$privateSet"]!, ids["$blur"]!, ids["$desk"]!, "nothing-here"]) {
      expect(about(set(handle, { recall: "hard" })), handle).toBeUndefined();
    }
  });

  it("shows where the set is after a GO: the bank's current preset, the list's current and next, and BACK now possible", async () => {
    const { bus, ids } = await documentWith(show());
    await bus.execute("cue.go", { nodeId: ids["$set"] as never }, contextFor(alice));
    const graph = bus.store.getGraph();
    expect(widgetOf(graph, "preset").current).toBe("soft");
    expect(widgetOf(graph, "cueList")).toMatchObject({ current: "1", next: "2", canGo: true, canBack: false });
    await bus.execute("cue.go", { nodeId: ids["$set"] as never }, contextFor(alice));
    // The last cue with Wrap off: GO has nowhere to go and the phone is told so.
    expect(widgetOf(bus.store.getGraph(), "cueList")).toMatchObject({ current: "2", next: null, canGo: false, canBack: true });
    expect(widgetOf(bus.store.getGraph(), "preset").current).toBe("hard");
  });

  it("T1508b: a list that follows the timeline is shown read-only — the playhead's cue, nothing to press, and a press refused with the reason", async () => {
    const timed = serializeCueList({
      version: 1,
      cues: [
        { name: "1", bank: "looks", preset: "soft", at: 1 },
        { name: "2", bank: "looks", preset: "hard", at: 2 },
      ],
    });
    const { bus, ids } = await documentWith(show());
    await patch(bus, [{ op: "setParameters", nodeId: ids["$set"] as never, parameters: { cues: timed, follow: "timeline" } }]);
    const graph = bus.store.getGraph();
    const at = (seconds: number): FrameClock => ({ epoch: "e", absTimeSeconds: 50, timeSeconds: seconds, timelineRate: 30 });
    expect(widgetOf(graph, "cueList", at(1.5))).toMatchObject({ following: true, current: "1", next: "2", canGo: false, canBack: false });
    expect(widgetOf(graph, "cueList", at(2))).toMatchObject({ following: true, current: "2", next: null });
    // A crossing changes the published positions; a frame between cues does not.
    expect(publishedTimelinePositions(graph, at(1.5))).toBe(publishedTimelinePositions(graph, at(1.9)));
    expect(publishedTimelinePositions(graph, at(1.9))).not.toBe(publishedTimelinePositions(graph, at(2)));
    for (const write of [{ go: true }, { back: true }, { standby: "2" }]) {
      expect(refusal(graph, set(ids["$set"]!, write))).toContain("follows the timeline; move the playhead");
    }
    // The legitimate case: the same list on live is driven as before.
    await patch(bus, [{ op: "setParameters", nodeId: ids["$set"] as never, parameters: { follow: "live" } }]);
    expect(widgetOf(bus.store.getGraph(), "cueList", at(1.5))).toMatchObject({ following: false, current: null, next: "1", canGo: true });
    expect(publishedTimelinePositions(bus.store.getGraph(), at(1.5))).toBe("");
    expect(vetPhoneSet(bus.store.getGraph(), set(ids["$set"]!, { go: true })).ok).toBe(true);
  });

  it("§T1544b: a following list carries what it switches in the structure — read-only, as the inspector says it; live, nothing", async () => {
    // "hard" turns the fx Layer on: a structural setting the timeline cuts on cue 2's frame.
    const presets = serializePresetBank({
      version: 1,
      presets: [
        { name: "soft", values: { blur1: { size: 4 } } },
        { name: "hard", values: { blur1: { size: 20 } }, on: { fx: true } },
      ],
    });
    const timed = serializeCueList({
      version: 1,
      cues: [
        { name: "1", bank: "looks", preset: "soft", at: 1 },
        { name: "2", bank: "looks", preset: "hard", at: 2 },
      ],
    });
    const { bus, ids } = await documentWith(show());
    await patch(bus, [
      { op: "setParameters", nodeId: ids["$looks"] as never, parameters: { targets: "blur1 fx", presets } },
      { op: "setParameters", nodeId: ids["$set"] as never, parameters: { cues: timed, follow: "timeline" } },
      { op: "setNodeUi", nodeId: ids["$fx"] as never, ui: { bypassed: true } },
    ]);
    const at: FrameClock = { epoch: "e", absTimeSeconds: 50, timeSeconds: 1.5, timelineRate: 30 };
    const cueListOf = (graph: GraphDocument) => {
      const items = buildPhoneSnapshot(graph, 1, at, undefined, bus.registry).panels[0]?.board?.items ?? [];
      return items.flatMap((item) => (item.kind === "widget" && item.widget.kind === "cueList" ? [item.widget] : []))[0];
    };
    expect(cueListOf(bus.store.getGraph())).toMatchObject({ following: true, structure: ["fx.on"] });
    // Without a registry the page cannot say, and says nothing rather than guessing.
    expect(widgetOf(bus.store.getGraph(), "cueList", at)).toMatchObject({ following: true, structure: [] });
    // The legitimate case: the same list on live switches nothing on the timeline.
    await patch(bus, [{ op: "setParameters", nodeId: ids["$set"] as never, parameters: { follow: "live" } }]);
    expect(cueListOf(bus.store.getGraph())).toMatchObject({ following: false, structure: [] });
  });

  it("turns each press into the one bus command it means, with an input the page built", async () => {
    const { bus, ids } = await documentWith(show());
    const graph = bus.store.getGraph();
    expect(vetPhoneSet(graph, set(ids["$looks"]!, { recall: "hard" }))).toEqual({
      ok: true,
      action: "command",
      command: "preset.recall",
      input: { nodeId: ids["$looks"], name: "hard" },
    });
    expect(vetPhoneSet(graph, set(ids["$set"]!, { go: true }))).toEqual({ ok: true, action: "command", command: "cue.go", input: { nodeId: ids["$set"] } });
    expect(vetPhoneSet(graph, set(ids["$set"]!, { back: true }))).toEqual({ ok: true, action: "command", command: "cue.back", input: { nodeId: ids["$set"] } });
    expect(vetPhoneSet(graph, set(ids["$set"]!, { standby: "2" }))).toEqual({
      ok: true,
      action: "command",
      command: "cue.setStandby",
      input: { nodeId: ids["$set"], cue: "2" },
    });
    // A layer's switch is the STATE asked for, and its fader a clamped parameter write.
    expect(vetPhoneSet(graph, set(ids["$fx"]!, { on: false }))).toEqual({ ok: true, action: "layerOn", nodeId: ids["$fx"], caption: "fx", on: false });
    expect(vetPhoneSet(graph, set(ids["$fx"]!, { opacity: 0.25 }, "live"))).toEqual({
      ok: true,
      action: "parameters",
      nodeId: ids["$fx"],
      kind: "layer",
      entries: { opacity: 0.25 },
      phase: "live",
    });
    expect(vetPhoneSet(graph, set(ids["$fx"]!, { opacity: 7 }))).toMatchObject({ ok: true, entries: { opacity: 1 } });
    expect(vetPhoneSet(graph, set(ids["$fx"]!, { opacity: -2 }))).toMatchObject({ ok: true, entries: { opacity: 0 } });
  });

  it("refuses a bank, a layer and a cue list that are NOT on a remote Panel — and the published ones the moment the Phone switch goes off", async () => {
    const { bus, ids } = await documentWith(show());
    const graph = bus.store.getGraph();
    // The very writes that work on the published three, aimed at the three on the desk-only Panel.
    expect(refusal(graph, set(ids["$private"]!, { recall: "hard" }))).toBe(UNPUBLISHED);
    expect(refusal(graph, set(ids["$privateFx"]!, { on: false }))).toBe(UNPUBLISHED);
    expect(refusal(graph, set(ids["$privateFx"]!, { opacity: 0.5 }))).toBe(UNPUBLISHED);
    expect(refusal(graph, set(ids["$privateSet"]!, { go: true }))).toBe(UNPUBLISHED);
    expect(refusal(graph, set(ids["$privateSet"]!, { standby: "2" }))).toBe(UNPUBLISHED);
    // The legitimate case the check must not swallow.
    expect(vetPhoneSet(graph, set(ids["$looks"]!, { recall: "hard" })).ok).toBe(true);

    await patch(bus, [{ op: "setParameters", nodeId: ids["$stage"] as never, parameters: { remote: false } }]);
    const after = bus.store.getGraph();
    expect(refusal(after, set(ids["$looks"]!, { recall: "hard" }))).toBe(UNPUBLISHED);
    expect(refusal(after, set(ids["$fx"]!, { on: false }))).toBe(UNPUBLISHED);
    expect(refusal(after, set(ids["$set"]!, { go: true }))).toBe(UNPUBLISHED);
    expect(buildPhoneSnapshot(after, 2).panels).toEqual([]);
  });

  it("refuses a bank taken off the published board, though its Panel is still published", async () => {
    const { bus, ids } = await documentWith(show());
    await patch(bus, [
      { op: "setParameters", nodeId: ids["$stage"] as never, parameters: { board: board([["fx", 4, 0, 4, 1], ["set", 0, 1, 4, 2]]) } },
    ]);
    const graph = bus.store.getGraph();
    expect(refusal(graph, set(ids["$looks"]!, { recall: "hard" }))).toBe(UNPUBLISHED);
    expect(vetPhoneSet(graph, set(ids["$set"]!, { go: true })).ok).toBe(true);
  });

  it("refuses a live recall, GO, BACK, standby and switch by name — each is one press, sent on the lift", async () => {
    const { bus, ids } = await documentWith(show());
    const graph = bus.store.getGraph();
    expect(refusal(graph, set(ids["$looks"]!, { recall: "hard" }, "live"))).toBe("A phone sent “looks” a recall as a live drag; it is one press, sent once.");
    expect(refusal(graph, set(ids["$set"]!, { go: true }, "live"))).toBe("A phone sent “set” a GO as a live drag; it is one press, sent once.");
    expect(refusal(graph, set(ids["$set"]!, { back: true }, "live"))).toBe("A phone sent “set” a BACK as a live drag; it is one press, sent once.");
    expect(refusal(graph, set(ids["$set"]!, { standby: "2" }, "live"))).toBe("A phone sent “set” a standby as a live drag; it is one press, sent once.");
    expect(refusal(graph, set(ids["$fx"]!, { on: false }, "live"))).toBe("A phone sent “fx” its switch as a live drag; it is one press, sent once.");
    // The one thing here that IS a drag.
    expect(vetPhoneSet(graph, set(ids["$fx"]!, { opacity: 0.5 }, "live")).ok).toBe(true);
  });

  it("refuses a stale preset or cue name by naming the bank or list — a name the phone drew a moment ago included", async () => {
    const { bus, ids } = await documentWith(show());
    const stale = refusal(bus.store.getGraph(), set(ids["$looks"]!, { recall: "harder" }));
    expect(stale).toBe("“looks” has no preset by the name a phone asked for; it was renamed or deleted since the phone drew it.");
    // What the phone sent is data off the LAN: it is not quoted into the desk's notice.
    expect(stale).not.toContain("harder");
    expect(refusal(bus.store.getGraph(), set(ids["$set"]!, { standby: "9" }))).toBe(
      "“set” has no cue by the name a phone asked for; it was renamed or deleted since the phone drew it.",
    );
    // "hard" is on the phone's screen; then the desk deletes it. The tap that follows is refused.
    expect(vetPhoneSet(bus.store.getGraph(), set(ids["$looks"]!, { recall: "hard" })).ok).toBe(true);
    await patch(bus, [
      {
        op: "setParameters",
        nodeId: ids["$looks"] as never,
        parameters: { presets: serializePresetBank({ version: 1, presets: [{ name: "soft", values: { blur1: { size: 4 } } }] }) },
      },
    ]);
    expect(refusal(bus.store.getGraph(), set(ids["$looks"]!, { recall: "hard" }))).toMatch(/^“looks” has no preset by the name/);
    // A name is a string: an index, a flag or a number names nothing.
    expect(refusal(bus.store.getGraph(), set(ids["$looks"]!, { recall: 0 }))).toMatch(/^“looks” has no preset by the name/);
    expect(refusal(bus.store.getGraph(), set(ids["$looks"]!, { recall: true }))).toMatch(/^“looks” has no preset by the name/);
  });

  it("shows a driven opacity as not writable and refuses a write to it — while the layer's switch stays the phone's", async () => {
    const driven = { mode: "expression", bindings: { expression: { kind: "expression", source: "0.5" } } };
    const { bus, ids } = await documentWith(show({ opacity: driven }));
    const graph = bus.store.getGraph();
    expect(widgetOf(graph, "layer")).toMatchObject({ handle: ids["$fx"], on: true, opacityWritable: false });
    expect(refusal(graph, set(ids["$fx"]!, { opacity: 0.2 }))).toBe("“fx” has its opacity driven by the document, so a phone cannot move it.");
    expect(refusal(graph, set(ids["$fx"]!, { opacity: 0.2 }, "live"))).toBe("“fx” has its opacity driven by the document, so a phone cannot move it.");
    expect(vetPhoneSet(graph, set(ids["$fx"]!, { on: false }))).toMatchObject({ ok: true, action: "layerOn", on: false });
  });

  it("refuses keys a phone may not write, two things in one write, and values of the wrong kind", async () => {
    const { bus, ids } = await documentWith(show());
    const graph = bus.store.getGraph();
    expect(refusal(graph, set(ids["$looks"]!, { current: "hard" }))).toMatch(/a preset does not let a phone write/);
    expect(refusal(graph, set(ids["$fx"]!, { blend: 1 }))).toMatch(/a layer does not let a phone write/);
    expect(refusal(graph, set(ids["$set"]!, { cues: "[]" }))).toMatch(/a cueList does not let a phone write/);
    expect(refusal(graph, set(ids["$fx"]!, { on: true, opacity: 0.5 }))).toMatch(/two things in one write/);
    expect(refusal(graph, set(ids["$set"]!, { go: true, back: true }))).toMatch(/two things in one write/);
    expect(refusal(graph, set(ids["$set"]!, { go: false }))).toMatch(/a press that is not a press/);
    expect(refusal(graph, set(ids["$set"]!, { go: "1" }))).toMatch(/a press that is not a press/);
    expect(refusal(graph, set(ids["$fx"]!, { on: "yes" }))).toMatch(/not true or false/);
    expect(refusal(graph, set(ids["$fx"]!, { opacity: "0.5" }))).toMatch(/not a finite number/);
    expect(refusal(graph, set(ids["$looks"]!, {}))).toMatch(/carried no values/);
  });

  it("sets `morphing` when a fade starts and clears it when the fade's clock passes its end", async () => {
    const { bus, ids } = await documentWith(show());
    let clock: FrameClock | undefined = { epoch: "run-1", absTimeSeconds: 10 };
    bus.attachFrameClock(() => clock);
    expect(widgetOf(bus.store.getGraph(), "preset", clock).morphing).toBe(false);

    const recalled = await bus.execute("preset.recall", { nodeId: ids["$looks"] as never, name: "hard", morph: { seconds: 2, curve: "linear" } }, contextFor(alice));
    expect(recalled.status).toBe("applied");
    const graph = bus.store.getGraph();
    // The destination is `current` at once; the fade is what `morphing` says is still to do.
    expect(widgetOf(graph, "preset", clock)).toMatchObject({ current: "hard", morphing: true });
    expect(publishedMorphs(graph, clock)).toHaveLength(1);
    expect(widgetOf(graph, "preset", { epoch: "run-1", absTimeSeconds: 11.99 }).morphing).toBe(true);
    // The SAME document, a later clock: the fade is over and nothing was written to say so.
    expect(widgetOf(graph, "preset", { epoch: "run-1", absTimeSeconds: 12 })).toMatchObject({ current: "hard", morphing: false });
    expect(publishedMorphs(graph, { epoch: "run-1", absTimeSeconds: 12 })).toEqual([]);
    // A render zeroed the clock (another epoch), or no frame loop at all: nothing is fading.
    expect(widgetOf(graph, "preset", { epoch: "run-2", absTimeSeconds: 0 }).morphing).toBe(false);
    clock = undefined;
    expect(widgetOf(graph, "preset", clock).morphing).toBe(false);
  });

  it("a fade on a bank the phone cannot see is not the phone's to watch", async () => {
    const { bus, ids } = await documentWith(show());
    const clock: FrameClock = { epoch: "run-1", absTimeSeconds: 10 };
    bus.attachFrameClock(() => clock);
    await bus.execute("preset.recall", { nodeId: ids["$private"] as never, name: "hard", morph: { seconds: 2, curve: "linear" } }, contextFor(alice));
    expect(publishedMorphs(bus.store.getGraph(), clock)).toEqual([]);
    expect(widgetOf(bus.store.getGraph(), "preset", clock).morphing).toBe(false);
  });

  /*
   * RULING 12: NO STORE FROM THE PHONE. Asserted by ENUMERATION of what the vet can return,
   * not by reading its source: every handle in the document (published or not, and one that
   * names nothing) × every key a phone may write plus the ones somebody would try
   * (`store`, `delete`, the command names themselves, a `morph`) × every kind of value ×
   * both phases, alone and in pairs. Whatever comes back as a command is one of four, and
   * its input holds a node id and at most one checked name — so there is no write a phone
   * can send that becomes `preset.store` or `preset.delete`, or a recall with its own morph.
   */
  it("no write a phone can send becomes preset.store or preset.delete — only recall, GO, BACK and standby", async () => {
    const { bus, ids } = await documentWith(show());
    const graph = bus.store.getGraph();
    const handles = [...Object.values(ids), "nothing-here"];
    const keys = [
      ...new Set(Object.values(PHONE_WRITABLE_KEYS).flat()),
      "store",
      "delete",
      "name",
      "morph",
      "command",
      "presets",
      "targets",
      "preset.store",
      "preset.delete",
      "preset.recall",
    ];
    const values: Array<number | boolean | string> = [true, false, 0, 0.5, "soft", "hard", "1", "2", "newPreset", "store", "preset.store", "preset.delete"];
    const commands = new Map<string, Set<string>>();
    let asked = 0;
    const ask = (write: PhoneSet): void => {
      asked += 1;
      const vet = vetPhoneSet(graph, write);
      if (!vet.ok || vet.action !== "command") return;
      const inputKeys = commands.get(vet.command) ?? new Set<string>();
      for (const key of Object.keys(vet.input)) inputKeys.add(key);
      commands.set(vet.command, inputKeys);
    };
    for (const handle of handles) {
      for (const phase of ["live", "commit"] as const) {
        for (const key of keys) {
          for (const value of values) {
            ask({ handle, values: { [key]: value }, phase });
            for (const other of keys) if (other !== key) ask({ handle, values: { [key]: value, [other]: value }, phase });
          }
        }
      }
    }
    expect(asked).toBeGreaterThan(50_000);
    const reached = Object.fromEntries([...commands].map(([command, inputKeys]) => [command, [...inputKeys].sort()]));
    // All four are reachable (the enumeration is not vacuous) and nothing else is.
    expect(reached).toEqual({
      "preset.recall": ["name", "nodeId"],
      "cue.go": ["nodeId"],
      "cue.back": ["nodeId"],
      "cue.setStandby": ["cue", "nodeId"],
    });
    expect([...PHONE_COMMANDS].sort()).toEqual(["cue.back", "cue.go", "cue.setStandby", "preset.recall"]);
  });
});

/**
 * T1505b — A LOOK'S INSTANCE ON A REMOTE PANEL BEHAVES LIKE A BANK: the phone draws it as a
 * preset strip from its COMPONENT'S presets, with the instance's own `current`, and a press
 * is the recall the desk runs, on the instance. Never a Store: the vet has no key for one.
 * Seeing inside a component needs the catalogue; without it the instance is not published,
 * so what the phone is shown and what it may write still agree.
 */
describe("T1505b — a look's instance bank on the phone", () => {
  const PAGE_PRESETS = serializePresetBank({
    version: 1,
    presets: [
      { name: "soft", values: { parent: { glow: 4 } } },
      { name: "hard", values: { parent: { glow: 20 } } },
    ],
  });
  const look = {
    componentId: "look",
    version: 1,
    name: "Look",
    graph: {
      revision: 0,
      nodes: {
        blur: { id: "blur", type: "blur", label: "blur", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { size: 9 } },
        looks: { id: "looks", type: "presets", label: "looks", definitionVersion: 1, position: { x: 0, y: 200 }, parameters: { targets: "parent", presets: PAGE_PRESETS } },
      },
      edges: {},
      groups: {},
    },
    inputs: [],
    outputs: [{ externalId: "out", label: "Out", nodeId: "blur", portId: "out" }],
    parameters: [{ key: "glow", definition: { type: "number", label: "Glow", default: 9, min: 0, max: 64 }, targets: [{ nodeId: "blur", key: "size" }] }],
  } as unknown as GraphComponentDefinition;

  async function stage(): Promise<{ bus: LoomBus; components: ComponentRegistry; city: string }> {
    const store = createGraphStore({ ids: createSequentialIdFactory("p"), now: () => "2026-10-03T00:00:00.000Z" });
    const system = createComponentSystem(createNodeRegistry(allNodeDefinitions).view(), [look]);
    const { bus } = createDomainBus({ store, registry: system.nodes });
    registerComponentCommands(bus, { components: system.components });
    const board = serializePanelBoard({ columns: 8, items: [{ member: "city", rect: { x: 0, y: 0, w: 4, h: 1 } }] });
    const result = await bus.execute(
      "graph.applyPatch",
      {
        baseRevision: bus.store.getRevision(),
        label: "setup",
        operations: [add("city", componentNodeType("look", 1), "city", { glow: 9 }), add("stage", "panel", "panel1", { title: "Show", remote: true, board })],
      },
      contextFor(alice),
    );
    expect(result.output.status).toBe("applied");
    return { bus, components: system.components, city: (result.output.createdIds as Record<string, string>)["$city"] as string };
  }

  it("draws the instance as a preset strip from its component, with its own current — and refuses a Store, recalls by the bus", async () => {
    const { bus, components, city } = await stage();
    const items = (): readonly PhoneBoardItem[] => buildPhoneSnapshot(bus.store.getGraph(), 1, undefined, components).panels[0]?.board?.items ?? [];
    expect(items()).toEqual([
      { kind: "widget", rect: { x: 0, y: 0, w: 4, h: 1 }, widget: { kind: "preset", handle: city, caption: "city", presets: ["soft", "hard"], current: null, morphing: false } },
    ]);

    // A press is the desk's recall, on the instance.
    const vet = vetPhoneSet(bus.store.getGraph(), set(city, { recall: "hard" }), components);
    expect(vet).toEqual({ ok: true, action: "command", command: "preset.recall", input: { nodeId: city, name: "hard" } });
    if (vet.ok && vet.action === "command") {
      const ran = await bus.execute(vet.command, vet.input, contextFor(alice));
      expect(ran.status).toBe("applied");
    }
    expect(bus.store.getGraph().nodes[city]?.parameters["glow"]).toBe(20);
    expect(items()[0]).toMatchObject({ widget: { current: "hard" } });

    // No Store from the phone: there is no key a phone can send that the vet turns into one.
    const store = vetPhoneSet(bus.store.getGraph(), set(city, { store: "mine" }), components);
    expect(store.ok).toBe(false);
    // A name the component does not hold is refused, as on a bank.
    expect(vetPhoneSet(bus.store.getGraph(), set(city, { recall: "nope" }), components).ok).toBe(false);
  });

  it("with no catalogue the instance is not published — the snapshot shows nothing and the vet refuses", async () => {
    const { bus, city } = await stage();
    expect(buildPhoneSnapshot(bus.store.getGraph(), 1).panels[0]?.board?.items).toEqual([]);
    expect(vetPhoneSet(bus.store.getGraph(), set(city, { recall: "soft" }))).toEqual({
      ok: false,
      reason: "A phone tried to move a control that is not published to the phone door.",
    });
  });

  /*
   * T1593b (ruled 2026-10-05): the phone captions a bank by the ROLE of its name, and a
   * look's instance is a bank from outside. Its kind is its COMPONENT'S name ("Look"), so
   * the instance renamed `downtown` is `look_downtown` in the document and `downtown` on
   * the phone. The rename is the real one, so the board follows it and the item stays.
   */
  it("captions the instance by the role of its name, read against its component's name", async () => {
    const { bus, components, city } = await stage();
    const renamed = await bus.execute("node.rename", { nodeId: city, label: "downtown" }, contextFor(alice));
    expect(renamed.status).toBe("applied");
    expect(bus.store.getGraph().nodes[city]?.label).toBe("look_downtown");

    const [item] = buildPhoneSnapshot(bus.store.getGraph(), 1, undefined, components).panels[0]?.board?.items ?? [];
    expect(item).toMatchObject({ kind: "widget", widget: { kind: "preset", handle: city, caption: "downtown" } });
    // A refusal names the member by the caption the phone drew it under.
    const refused = vetPhoneSet(bus.store.getGraph(), set(city, { recall: "nope" }), components);
    expect(refused.ok ? "" : refused.reason).toContain("“downtown” has no preset by the name a phone asked for");
  });
});

/**
 * T1593b (ruled 2026-10-05) — THE PHONE CAPTIONS A BANK, A LAYER AND A CUE LIST BY THE ROLE.
 *
 * A node's name is `kind_role`, and the phone draws a bank as a row of presets, a layer as
 * a switch and a cue list as GO: the kind in front of the caption would be the same fact
 * again on the smallest screen in the room. So `presets_looks` is `looks` there. The
 * handle a phone writes to is the node's id, and is untouched by any of this.
 */
describe("T1593b — the phone captions a member by the role of its name", () => {
  const LOOKS = serializePresetBank({ version: 1, presets: [{ name: "soft", values: { blur1: { size: 4 } } }] });
  const board = (members: readonly string[]): string =>
    serializePanelBoard({ columns: 8, items: members.map((member, index) => ({ member, rect: { x: 0, y: index, w: 4, h: 1 } })) });
  const show = (bank: string, layer: string, cues: string, panel: string, title: string): GraphPatchOperation[] => [
    add("blur", "blur", "blur1", { size: 9 }),
    add("looks", "presets", bank, { targets: "blur1", presets: LOOKS }),
    add("fx", "layer", layer),
    add("set", "cueList", cues, { cues: serializeCueList({ version: 1, cues: [{ name: "1", bank, preset: "soft" }] }) }),
    add("stage", "panel", panel, { title, remote: true, board: board([bank, layer, cues]) }),
  ];
  const captions = (graph: GraphDocument): Array<readonly [string, string]> =>
    (buildPhoneSnapshot(graph, 1).panels[0]?.board?.items ?? []).flatMap((item) =>
      item.kind === "widget" && "caption" in item.widget ? [[item.widget.kind, item.widget.caption] as const] : [],
    );

  it("shows the role of a name that carries its kind, and the Panel's role as its title", async () => {
    const { bus, ids } = await documentWith(show("presets_looks", "layer_fx", "cuelist_set", "panel_show", ""));
    const snapshot = buildPhoneSnapshot(bus.store.getGraph(), 1);

    expect(captions(bus.store.getGraph())).toEqual([["preset", "looks"], ["layer", "fx"], ["cueList", "set"]]);
    expect(snapshot.panels.map((panel) => panel.title)).toEqual(["show"]);
    // The caption is not the address: a phone still writes to the node's id.
    const handles = (snapshot.panels[0]?.board?.items ?? []).flatMap((item) => (item.kind === "widget" ? [item.widget.handle] : []));
    expect(handles).toEqual([ids["$looks"], ids["$fx"], ids["$set"]]);
  });

  it("shows a name the rule did not make exactly as it is", async () => {
    const legacy = await documentWith(show("looks", "fx", "set", "stage", ""));
    expect(captions(legacy.bus.store.getGraph())).toEqual([["preset", "looks"], ["layer", "fx"], ["cueList", "set"]]);

    const numbered = await documentWith(show("presets1", "layer1", "cuelist1", "panel1", ""));
    expect(captions(numbered.bus.store.getGraph())).toEqual([["preset", "presets1"], ["layer", "layer1"], ["cueList", "cuelist1"]]);
    expect(buildPhoneSnapshot(numbered.bus.store.getGraph(), 1).panels.map((panel) => panel.title)).toEqual(["panel1"]);
  });

  it("names the member by that caption when it refuses a write, so the phone can show the sentence on it", async () => {
    const { bus, ids } = await documentWith(show("presets_looks", "layer_fx", "cuelist_set", "panel_show", "Show"));
    const vet = vetPhoneSet(bus.store.getGraph(), set(ids["$looks"]!, { recall: "nope" }));
    expect(vet.ok ? "" : vet.reason).toBe("“looks” has no preset by the name a phone asked for; it was renamed or deleted since the phone drew it.");
    // And an accepted layer write carries the same caption back.
    expect(vetPhoneSet(bus.store.getGraph(), set(ids["$fx"]!, { on: false }))).toEqual({
      ok: true,
      action: "layerOn",
      nodeId: ids["$fx"],
      caption: "fx",
      on: false,
    });
  });
});

/**
 * T1771b — ANY NODE NAMED ON A REMOTE PANEL'S BOARD IS ITS ON/OFF SWITCH ON THE PHONE. The
 * phone is sent the toggle it already draws, so nothing about the page or the wire changes;
 * what matters is on this side: a press must become the node's own switch (the state asked
 * for, never a parameter write, never a flip), and a node that is not on a published board
 * must stay out of reach.
 */
describe("T1771b — a node's on/off switch on the phone", () => {
  const board = (members: readonly string[]): string =>
    serializePanelBoard({ columns: 8, items: members.map((member, index) => ({ member, rect: { x: index * 2, y: 0, w: 2, h: 1 } })) });
  const show = (blur: Record<string, unknown> = {}): GraphPatchOperation[] => [
    { ...add("blur", "blur", "blur_soft", { size: 9 }), ...blur } as GraphPatchOperation,
    add("other", "blur", "blur_private", { size: 9 }),
    add("stage", "panel", "panel1", { title: "Show", remote: true, board: board(["blur_soft"]) }),
    add("desk", "panel", "panel2", { title: "Desk only", board: board(["blur_private"]) }),
  ];

  it("is sent as a toggle captioned by the role of its name, on while the node is not bypassed", async () => {
    const { bus, ids } = await documentWith(show());
    const items = buildPhoneSnapshot(bus.store.getGraph(), 1).panels[0]?.board?.items;
    expect(items).toEqual([{ kind: "widget", rect: { x: 0, y: 0, w: 2, h: 1 }, widget: { kind: "toggle", handle: ids["$blur"], caption: "soft", on: true } }]);
    await bus.execute(
      "graph.applyPatch",
      { baseRevision: bus.store.getRevision(), operations: [{ op: "setNodeUi", nodeId: ids["$blur"]!, ui: { bypassed: true } }] },
      contextFor(alice),
    );
    const after = buildPhoneSnapshot(bus.store.getGraph(), 2).panels[0]?.board?.items[0];
    expect(after).toMatchObject({ widget: { kind: "toggle", on: false } });
  });

  it("a press is the node's switch, as the state asked for; a drag, a non-boolean and another key are refused", async () => {
    const { bus, ids } = await documentWith(show());
    const graph = bus.store.getGraph();
    expect(vetPhoneSet(graph, set(ids["$blur"]!, { on: false }))).toEqual({ ok: true, action: "layerOn", nodeId: ids["$blur"], caption: "soft", on: false, what: "switch" });
    expect(vetPhoneSet(graph, set(ids["$blur"]!, { on: false }, "live"))).toMatchObject({ ok: false, nodeId: ids["$blur"] });
    expect(vetPhoneSet(graph, set(ids["$blur"]!, { on: 1 }))).toMatchObject({ ok: false, nodeId: ids["$blur"] });
    // Its parameters are not the phone's: only the switch is published.
    expect(vetPhoneSet(graph, set(ids["$blur"]!, { size: 40 }))).toMatchObject({ ok: false, nodeId: ids["$blur"] });
  });

  it("a node on a Panel that is not published is out of reach", async () => {
    const { bus, ids } = await documentWith(show());
    expect(vetPhoneSet(bus.store.getGraph(), set(ids["$other"]!, { on: false }))).toEqual({
      ok: false,
      reason: "A phone tried to move a control that is not published to the phone door.",
    });
  });
});
