import { describe, expect, it } from "vitest";
import type { LoomBus } from "@domain/commands/bus.ts";
import { createDomainBus } from "@domain/commands/index.ts";
import { alice, contextFor } from "@domain/commands/test-support.ts";
import { createGraphStore } from "@domain/graph/store.ts";
import { createSequentialIdFactory } from "@domain/graph/ids.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import type { FrameScheduler } from "@ui/controls/coalesce.ts";
import { serializeCueList, serializePresetBank } from "@domain/presets/index.ts";
import { PHONE_WRITABLE_KEYS, type PhoneSet } from "@devices/phone/phone-protocol.ts";
import { serializePanelBoard } from "@nodes/definitions/controls.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { createPhoneWrites, phoneActor } from "./phone-writes.ts";

/**
 * T1396b — A PHONE'S WRITE LANDS IN THE DOCUMENT AS THAT PHONE, AND ONLY WHEN IT MAY.
 *
 * Through the real bus and the real registry: what a phone sends becomes a stored value
 * the desk reads back, the audit entry names the phone, a whole phone gesture (live
 * frames then a lift) undoes in ONE step from the phone's own stack while the desk's
 * stack is untouched, and a refused write changes nothing and is SAID.
 */

const desk = contextFor(alice);

async function stage(): Promise<{ bus: LoomBus; id: (ref: string) => NodeId }> {
  const store = createGraphStore({ ids: createSequentialIdFactory("w"), now: () => "2026-09-29T00:00:00.000Z" });
  const { bus } = createDomainBus({ store, registry: createNodeRegistry(allNodeDefinitions).view() });
  const add = (ref: string, type: string, label: string, parameters: Record<string, unknown>): GraphPatchOperation =>
    ({ op: "addNode", ref: `$${ref}`, type, position: { x: 0, y: 0 }, label, parameters }) as GraphPatchOperation;
  const result = await bus.execute(
    "graph.applyPatch",
    {
      baseRevision: bus.store.getRevision(),
      operations: [
        add("fader", "slider", "fader1", { channel: "heat", value: 0.25, min: 0, max: 1, step: 0.125 }),
        add("cut", "button", "button1", { channel: "cut", presses: 2 }),
        add("stage", "panel", "panel1", { remote: true, layout: "fader1 button1" }),
      ],
    },
    desk,
  );
  const created = result.output.createdIds as Record<string, NodeId>;
  return { bus, id: (ref) => created[`$${ref}`]! };
}

/** Frames run only when the test says so — the parameter editor's coalescing, made visible. */
function manualFrames(): { schedule: FrameScheduler; frame: () => void } {
  let queued: Array<() => void> = [];
  return {
    schedule: (callback) => {
      queued.push(callback);
      return () => {
        queued = queued.filter((entry) => entry !== callback);
      };
    },
    frame: () => {
      const run = queued;
      queued = [];
      for (const callback of run) callback();
    },
  };
}

const value = (bus: LoomBus, node: NodeId, key: string): unknown => bus.store.getGraph().nodes[node]!.parameters[key];

describe("T1396b — phone writes through the bus", () => {
  it("a phone drag is live frames plus a lift: one undo group on the PHONE's stack, audited as the phone", async () => {
    const { bus, id } = await stage();
    const frames = manualFrames();
    const refusals: string[] = [];
    const writes = createPhoneWrites({ bus, invocation: desk, schedule: frames.schedule, onRefused: (_p, reason) => refusals.push(reason) });
    const fader = id("fader");
    const auditBefore = bus.store.getAudit().length;

    void writes.write("p1", { handle: fader, values: { value: 0.4 }, phase: "live" });
    await writes.settled();
    expect(value(bus, fader, "value")).toBe(0.375); // snapped to the 0.125 step
    void writes.write("p1", { handle: fader, values: { value: 0.61 }, phase: "live" });
    frames.frame();
    await writes.settled();
    expect(value(bus, fader, "value")).toBe(0.625);
    void writes.write("p1", { handle: fader, values: { value: 4 }, phase: "commit" });
    await writes.settled();
    expect(value(bus, fader, "value")).toBe(1); // clamped to Max

    const entries = bus.store.getAudit().slice(auditBefore);
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(entries.every((entry) => entry.actor.id === "remote-p1" && entry.actor.kind === "human" && entry.status === "applied")).toBe(true);
    const groups = new Set(entries.map((entry) => entry.undoGroupId));
    expect(groups.size).toBe(1);

    // The phone's stack holds ONE group; the desk's holds only its own setup.
    expect(bus.store.getHistory(phoneActor("p1")).undo).toHaveLength(1);
    expect(bus.store.getHistory(alice).undo).toHaveLength(1);
    // Undo at the desk undoes the DESK's latest edit and does not reach the phone's gesture…
    await bus.execute(
      "graph.applyPatch",
      { baseRevision: bus.store.getRevision(), operations: [{ op: "setParameters", nodeId: id("cut"), parameters: { presses: 10 } }] },
      desk,
    );
    await bus.execute("graph.undo", {}, desk);
    expect(value(bus, id("cut"), "presses")).toBe(2);
    expect(value(bus, fader, "value")).toBe(1);
    // …and ONE undo as the phone lands on the value before the drag started.
    await bus.execute("graph.undo", {}, contextFor(phoneActor("p1")));
    expect(value(bus, fader, "value")).toBe(0.25);
    expect(refusals).toEqual([]);
  });

  it("two phones keep two undo stacks", async () => {
    const { bus, id } = await stage();
    const writes = createPhoneWrites({ bus, invocation: desk, schedule: manualFrames().schedule, onRefused: () => undefined });
    await writes.write("p1", { handle: id("fader"), values: { value: 0.5 }, phase: "commit" });
    await writes.write("p2", { handle: id("fader"), values: { value: 0.75 }, phase: "commit" });
    expect(bus.store.getHistory(phoneActor("p1")).undo).toHaveLength(1);
    expect(bus.store.getHistory(phoneActor("p2")).undo).toHaveLength(1);
  });

  it("a button press and release, sent back to back, counts ONE press in ONE undo group", async () => {
    const { bus, id } = await stage();
    const writes = createPhoneWrites({ bus, invocation: desk, schedule: manualFrames().schedule, onRefused: () => undefined });
    const cut = id("cut");
    // Not awaited between: the release must be vetted against a document that has the press.
    void writes.write("p1", { handle: cut, values: { held: true }, phase: "live" });
    void writes.write("p1", { handle: cut, values: { held: true }, phase: "live" });
    const released = writes.write("p1", { handle: cut, values: { held: false }, phase: "commit" });
    await released;
    await writes.settled();
    expect(value(bus, cut, "presses")).toBe(3);
    expect(value(bus, cut, "held")).toBe(false);
    expect(bus.store.getHistory(phoneActor("p1")).undo).toHaveLength(1);
  });

  it("a phone that drops mid-press lets go of the button", async () => {
    const { bus, id } = await stage();
    const writes = createPhoneWrites({ bus, invocation: desk, schedule: manualFrames().schedule, onRefused: () => undefined });
    await writes.write("p1", { handle: id("cut"), values: { held: true }, phase: "live" });
    expect(value(bus, id("cut"), "held")).toBe(true);
    await writes.release("p1");
    expect(value(bus, id("cut"), "held")).toBe(false);
    expect(value(bus, id("cut"), "presses")).toBe(3);
  });

  it("a Panel switched off mid-session refuses its widgets: nothing written, the refusal said", async () => {
    const { bus, id } = await stage();
    const refusals: Array<[string, string]> = [];
    const writes = createPhoneWrites({ bus, invocation: desk, schedule: manualFrames().schedule, onRefused: (phone, reason) => refusals.push([phone, reason]) });
    await writes.write("p1", { handle: id("fader"), values: { value: 0.5 }, phase: "commit" });
    expect(value(bus, id("fader"), "value")).toBe(0.5);
    await bus.execute(
      "graph.applyPatch",
      { baseRevision: bus.store.getRevision(), operations: [{ op: "setParameters", nodeId: id("stage"), parameters: { remote: false } }] },
      desk,
    );
    const revision = bus.store.getRevision();
    await writes.write("p1", { handle: id("fader"), values: { value: 1 }, phase: "commit" });
    expect(value(bus, id("fader"), "value")).toBe(0.5);
    expect(bus.store.getRevision()).toBe(revision);
    expect(refusals).toEqual([["p1", "A phone tried to move a control that is not published to the phone door."]]);
  });
});

/**
 * T1503b (§T1398b ruling 12) — A PHONE RUNS THE SET, AS THAT PHONE. A recall, a GO and a
 * layer's switch pressed on a phone are bus commands and patches whose actor is the phone:
 * the audit says so, the undo group is on the phone's own stack, and what the desk reads
 * back from the document is what the phone asked for. And nothing a phone can send stores
 * or deletes a preset — asserted on the bank's stored bytes after everything was tried.
 */
describe("T1503b — a phone's presses on banks, layers and cue lists", () => {
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

  /** blur1 at 9; bank `looks`, layer `fx`, cue list `set` — all three on a published Panel's board. */
  async function show(): Promise<{ bus: LoomBus; id: (ref: string) => NodeId }> {
    const store = createGraphStore({ ids: createSequentialIdFactory("s"), now: () => "2026-10-02T00:00:00.000Z" });
    const { bus } = createDomainBus({ store, registry: createNodeRegistry(allNodeDefinitions).view() });
    const add = (ref: string, type: string, label: string, parameters: Record<string, unknown> = {}): GraphPatchOperation =>
      ({ op: "addNode", ref: `$${ref}`, type, position: { x: 0, y: 0 }, label, parameters }) as GraphPatchOperation;
    const board = serializePanelBoard({
      columns: 8,
      items: [
        { member: "looks", rect: { x: 0, y: 0, w: 4, h: 1 } },
        { member: "fx", rect: { x: 4, y: 0, w: 4, h: 1 } },
        { member: "set", rect: { x: 0, y: 1, w: 4, h: 2 } },
      ],
    });
    const result = await bus.execute(
      "graph.applyPatch",
      {
        baseRevision: bus.store.getRevision(),
        operations: [
          add("blur", "blur", "blur1", { size: 9 }),
          add("looks", "presets", "looks", { targets: "blur1", presets: LOOKS }),
          add("fx", "layer", "fx"),
          add("set", "cueList", "set", { cues: CUES }),
          add("stage", "panel", "panel1", { remote: true, board }),
        ],
      },
      desk,
    );
    expect(result.output.status).toBe("applied");
    const created = result.output.createdIds as Record<string, NodeId>;
    return { bus, id: (ref) => created[`$${ref}`]! };
  }

  const phone = (bus: LoomBus, refusals: Array<[string, string]> = []) =>
    createPhoneWrites({ bus, invocation: desk, schedule: manualFrames().schedule, onRefused: (who, reason) => refusals.push([who, reason]) });
  const press = (handle: NodeId, values: PhoneSet["values"]): PhoneSet => ({ handle, values, phase: "commit" });
  const bypassed = (bus: LoomBus, node: NodeId): boolean => bus.store.getGraph().nodes[node]!.ui?.bypassed === true;

  it("a recall from a phone is audited as that phone and is ONE undo step on the phone's own stack", async () => {
    const { bus, id } = await show();
    const writes = phone(bus);
    const auditBefore = bus.store.getAudit().length;
    const deskUndo = bus.store.getHistory(alice).undo.length;

    await writes.write("p1", press(id("looks"), { recall: "hard" }));
    expect(value(bus, id("blur"), "size")).toBe(20);
    expect(value(bus, id("looks"), "current")).toBe("hard");

    const entries = bus.store.getAudit().slice(auditBefore);
    expect(entries.map((entry) => [entry.command, entry.actor.kind, entry.actor.id, entry.status])).toEqual([
      ["preset.recall", "human", "remote-p1", "applied"],
    ]);
    expect(bus.store.getHistory(phoneActor("p1")).undo).toHaveLength(1);
    expect(bus.store.getHistory(alice).undo).toHaveLength(deskUndo);

    // Undo at the desk does not reach it; undo as the phone puts the look back.
    await bus.execute("graph.undo", {}, contextFor(phoneActor("p1")));
    expect(value(bus, id("blur"), "size")).toBe(9);
    expect(value(bus, id("looks"), "current") ?? "").toBe("");
  });

  it("GO and BACK from a phone fire the list's cues as the phone, and standby moves what GO fires next", async () => {
    const { bus, id } = await show();
    const refusals: Array<[string, string]> = [];
    const writes = phone(bus, refusals);
    const auditBefore = bus.store.getAudit().length;

    await writes.write("p2", press(id("set"), { go: true }));
    expect(value(bus, id("set"), "current")).toBe("1");
    expect(value(bus, id("blur"), "size")).toBe(4);
    await writes.write("p2", press(id("set"), { go: true }));
    expect(value(bus, id("set"), "current")).toBe("2");
    expect(value(bus, id("blur"), "size")).toBe(20);
    await writes.write("p2", press(id("set"), { back: true }));
    expect(value(bus, id("set"), "current")).toBe("1");
    expect(value(bus, id("blur"), "size")).toBe(4);
    // Stand cue 1 by again: the next GO fires IT, not the cue after the current one.
    await writes.write("p2", press(id("set"), { standby: "1" }));
    expect(value(bus, id("set"), "standby")).toBe("1");
    await bus.execute("graph.applyPatch", { baseRevision: bus.store.getRevision(), operations: [{ op: "setParameters", nodeId: id("blur"), parameters: { size: 9 } }] }, desk);
    await writes.write("p2", press(id("set"), { go: true }));
    expect(value(bus, id("set"), "current")).toBe("1");
    expect(value(bus, id("blur"), "size")).toBe(4);

    const mine = bus.store.getAudit().slice(auditBefore).filter((entry) => entry.actor.id === "remote-p2");
    expect(mine.map((entry) => entry.command)).toEqual(["cue.go", "cue.go", "cue.back", "cue.setStandby", "cue.go"]);
    expect(mine.every((entry) => entry.actor.kind === "human" && entry.status === "applied")).toBe(true);
    // Five presses, five undo steps, all the phone's.
    expect(bus.store.getHistory(phoneActor("p2")).undo).toHaveLength(5);
    expect(refusals).toEqual([]);
  });

  it("a press the bus refuses changes nothing and is SAID, in the bus's own sentence", async () => {
    const { bus, id } = await show();
    const refusals: Array<[string, string]> = [];
    const writes = phone(bus, refusals);
    // Nothing has fired: there is no cue to go BACK to.
    const revision = bus.store.getRevision();
    await writes.write("p1", press(id("set"), { back: true }));
    expect(bus.store.getRevision()).toBe(revision);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]![0]).toBe("p1");
    expect(refusals[0]![1]).toContain("nothing has fired yet");
    expect(bus.store.getHistory(phoneActor("p1")).undo).toHaveLength(0);
  });

  it("T1771b: any node named on the board is switched the same way, as the phone, in one step", async () => {
    const { bus, id } = await show();
    // Put the Blur on the published board: its item is its on/off switch.
    const panel = bus.store.getGraph().nodes[id("stage")]!;
    const stored = JSON.parse(panel.parameters["board"] as string) as { columns: number; items: unknown[] };
    await bus.execute(
      "graph.applyPatch",
      {
        baseRevision: bus.store.getRevision(),
        operations: [{ op: "setParameters", nodeId: id("stage"), parameters: { board: JSON.stringify({ ...stored, items: [...stored.items, { member: "blur1", rect: { x: 0, y: 4, w: 2, h: 1 } }] }) } }],
      },
      desk,
    );
    const writes = phone(bus);
    const auditBefore = bus.store.getAudit().length;
    void writes.write("p1", press(id("blur"), { on: false }));
    await writes.write("p1", press(id("blur"), { on: false }));
    expect(bypassed(bus, id("blur"))).toBe(true);
    expect(bus.store.getGraph().nodes[id("blur")]!.parameters["size"]).toBe(9);
    expect(bus.store.getHistory(phoneActor("p1")).undo).toHaveLength(1);
    expect(bus.store.getAudit().slice(auditBefore).map((entry) => [entry.actor.id, entry.status])).toEqual([["remote-p1", "applied"]]);
    await writes.write("p1", press(id("blur"), { on: true }));
    expect(bypassed(bus, id("blur"))).toBe(false);
  });

  it("a layer's switch is written as the state asked for: off twice is ONE step, and it cannot flip back", async () => {
    const { bus, id } = await show();
    const writes = phone(bus);
    const auditBefore = bus.store.getAudit().length;
    expect(bypassed(bus, id("fx"))).toBe(false);
    // A double tap arriving as two "off"s — the second must not switch the layer back on.
    void writes.write("p1", press(id("fx"), { on: false }));
    await writes.write("p1", press(id("fx"), { on: false }));
    expect(bypassed(bus, id("fx"))).toBe(true);
    expect(bus.store.getHistory(phoneActor("p1")).undo).toHaveLength(1);
    const entries = bus.store.getAudit().slice(auditBefore);
    expect(entries.map((entry) => [entry.actor.id, entry.status])).toEqual([["remote-p1", "applied"]]);

    await writes.write("p1", press(id("fx"), { on: true }));
    expect(bypassed(bus, id("fx"))).toBe(false);
    await bus.execute("graph.undo", {}, contextFor(phoneActor("p1")));
    expect(bypassed(bus, id("fx"))).toBe(true);
  });

  it("a layer's fader is a drag: live frames and a lift are one undo group, and a press sent after it lands after it", async () => {
    const { bus, id } = await show();
    const frames = manualFrames();
    const writes = createPhoneWrites({ bus, invocation: desk, schedule: frames.schedule, onRefused: () => undefined });
    void writes.write("p1", { handle: id("fx"), values: { opacity: 0.8 }, phase: "live" });
    void writes.write("p1", { handle: id("fx"), values: { opacity: 0.3 }, phase: "live" });
    void writes.write("p1", { handle: id("fx"), values: { opacity: 0.25 }, phase: "commit" });
    // Sent straight after the lift, not awaited between: the recall must not overtake the fader.
    await writes.write("p1", press(id("looks"), { recall: "soft" }));
    expect(value(bus, id("fx"), "opacity")).toBe(0.25);
    expect(value(bus, id("blur"), "size")).toBe(4);
    const groups = bus.store.getHistory(phoneActor("p1")).undo;
    expect(groups).toHaveLength(2);
    await bus.execute("graph.undo", {}, contextFor(phoneActor("p1")));
    expect(value(bus, id("blur"), "size")).toBe(9);
    expect(value(bus, id("fx"), "opacity")).toBe(0.25);
    await bus.execute("graph.undo", {}, contextFor(phoneActor("p1")));
    expect(value(bus, id("fx"), "opacity") ?? 1).toBe(1);
  });

  /*
   * T1526b — EVERY REFUSAL IS REPORTED WITH ITS CONTROL, so the phone that pressed can be
   * shown the sentence on what it pressed. One test per way a write ends up not applied:
   * the vet refuses, the bus rejects the command, the bus rejects the editor's patch, the
   * bus answers conflict. Each is through the real bus; the report is what `use-phone-door`
   * sends to that phone, so its three fields are asserted whole.
   */
  describe("T1526b — a refusal is reported with the phone and the control it is about", () => {
    type Report = [phone: string, reason: string, handle: string];
    const reporting = (bus: LoomBus, reports: Report[]) =>
      createPhoneWrites({ bus, invocation: desk, schedule: manualFrames().schedule, onRefused: (...report) => reports.push(report) });

    it("the vet's refusal names the published control it is about — and nothing when the write named none", async () => {
      const { bus, id } = await show();
      const reports: Report[] = [];
      const writes = reporting(bus, reports);
      const revision = bus.store.getRevision();
      await writes.write("p1", press(id("looks"), { recall: "harder" }));
      await writes.write("p2", press(id("set"), { standby: "9" }));
      // `blur1` is in the document and on no Panel: its id is not the phone's to hear back.
      await writes.write("p1", press(id("blur"), { size: 1 }));
      await writes.write("p1", press("nothing-here" as NodeId, { recall: "hard" }));
      expect(reports).toEqual([
        ["p1", "“looks” has no preset by the name a phone asked for; it was renamed or deleted since the phone drew it.", id("looks")],
        ["p2", "“set” has no cue by the name a phone asked for; it was renamed or deleted since the phone drew it.", id("set")],
        ["p1", "A phone tried to move a control that is not published to the phone door.", ""],
        ["p1", "A phone tried to move a control that is not published to the phone door.", ""],
      ]);
      expect(bus.store.getRevision()).toBe(revision);
    });

    it("a command the bus rejects is reported in the command's own sentence, on the list that was pressed: GO past the end without Wrap", async () => {
      const { bus, id } = await show();
      const reports: Report[] = [];
      const writes = reporting(bus, reports);
      await writes.write("p1", press(id("set"), { go: true }));
      await writes.write("p1", press(id("set"), { go: true }));
      expect(value(bus, id("set"), "current")).toBe("2");
      expect(reports).toEqual([]);
      const revision = bus.store.getRevision();
      await writes.write("p1", press(id("set"), { go: true }));
      expect(reports).toEqual([["p1", 'Cue list "set": "2" is its last cue and Wrap is off; nothing was fired.', id("set")]]);
      expect(bus.store.getRevision()).toBe(revision);
      expect(value(bus, id("set"), "current")).toBe("2");
    });

    /*
     * The two the vet cannot see coming: the document changes BETWEEN the vet and the write.
     * The race is made real, not mocked — a desk edit lands on the same node just before the
     * phone's own patch reaches the real bus — so the answer is the real bus's.
     */
    const racing = (bus: LoomBus, before: () => Promise<unknown>): LoomBus => {
      const execute = bus.execute.bind(bus);
      let raced = false;
      return Object.assign(Object.create(bus) as LoomBus, {
        execute: (async (name: string, input: unknown, context: { actor: { id: string } }) => {
          if (name === "graph.applyPatch" && context.actor.id.startsWith("remote-") && !raced) {
            raced = true;
            await before();
          }
          return execute(name as never, input as never, context as never);
        }) as LoomBus["execute"],
      });
    };

    it("a press that CONFLICTS with a desk edit made a moment before is said, not dropped — on the layer that was pressed", async () => {
      const { bus, id } = await show();
      const reports: Report[] = [];
      // The desk moves the layer's opacity between the phone's vet and its switch write.
      const raced = racing(bus, () =>
        bus.execute("graph.applyPatch", { baseRevision: bus.store.getRevision(), operations: [{ op: "setParameters", nodeId: id("fx"), parameters: { opacity: 0.3 } }] }, desk),
      );
      const writes = reporting(raced, reports);
      const auditBefore = bus.store.getAudit().length;
      await writes.write("p1", press(id("fx"), { on: false }));
      expect(bus.store.getAudit().slice(auditBefore).map((entry) => [entry.actor.id, entry.status])).toEqual([
        ["alice", "applied"],
        ["remote-p1", "conflict"],
      ]);
      // Not switched, and the phone is told so with the bus's sentence.
      expect(bypassed(bus, id("fx"))).toBe(false);
      expect(reports).toHaveLength(1);
      expect(reports[0]![0]).toBe("p1");
      expect(reports[0]![1]).toMatch(/^Patch was built against revision \d+, the document is at \d+/);
      expect(reports[0]![2]).toBe(id("fx"));
      // The legitimate case the report must not swallow: pressed again, with no race, it switches and says nothing.
      await writes.write("p1", press(id("fx"), { on: false }));
      expect(bypassed(bus, id("fx"))).toBe(true);
      expect(reports).toHaveLength(1);
    });

    it("a fader write the bus does not apply is reported on the control that phone moved last", async () => {
      const { bus, id } = await show();
      const reports: Report[] = [];
      // The layer is deleted at the desk between the phone's vet and its fader write.
      const raced = racing(bus, () => bus.execute("graph.applyPatch", { baseRevision: bus.store.getRevision(), operations: [{ op: "removeNodes", nodeIds: [id("fx")] }] }, desk));
      const writes = reporting(raced, reports);
      await writes.write("p1", { handle: id("fx"), values: { opacity: 0.25 }, phase: "commit" });
      await writes.settled();
      expect(bus.store.getGraph().nodes[id("fx")]).toBeUndefined();
      expect(reports.length).toBeGreaterThanOrEqual(1);
      for (const report of reports) {
        expect([report[0], report[2]]).toEqual(["p1", id("fx")]);
        expect(report[1].length).toBeGreaterThan(10);
      }
    });
  });

  /*
   * RULING 12, THROUGH THE REAL BUS: everything a phone could send at the three — every key
   * the contract names and the ones somebody would try — and afterwards the bank holds the
   * presets it held, byte for byte, and the bus was never asked for a Store or a Delete.
   */
  it("nothing a phone sends stores or deletes a preset: the bank's bytes are untouched and the bus was never asked", async () => {
    const { bus, id } = await show();
    const asked = new Set<string>();
    const execute = bus.execute.bind(bus);
    const spied = Object.assign(Object.create(bus) as LoomBus, {
      execute: ((name: string, input: unknown, context: never) => {
        asked.add(name);
        return execute(name as never, input as never, context);
      }) as LoomBus["execute"],
    });
    const writes = createPhoneWrites({ bus: spied, invocation: desk, schedule: manualFrames().schedule, onRefused: () => undefined });
    const keys = [...new Set(Object.values(PHONE_WRITABLE_KEYS).flat()), "store", "delete", "name", "preset.store", "preset.delete", "presets"];
    const values: Array<number | boolean | string> = [true, false, 0.5, "soft", "hard", "1", "2", "brandNew", "preset.store"];
    for (const handle of [id("looks"), id("fx"), id("set"), id("blur"), id("stage")]) {
      for (const key of keys) {
        for (const sent of values) {
          for (const phase of ["live", "commit"] as const) void writes.write("p1", { handle, values: { [key]: sent }, phase });
        }
      }
    }
    await writes.settled();
    expect(value(bus, id("looks"), "presets")).toBe(LOOKS);
    // The barrage did real work (so the spy saw the paths that exist)…
    expect(asked.has("preset.recall")).toBe(true);
    expect(asked.has("cue.go")).toBe(true);
    // …and these are ALL the bus was asked for.
    expect([...asked].sort()).toEqual(["cue.back", "cue.go", "cue.setStandby", "graph.applyPatch", "preset.recall"]);
  });
});
