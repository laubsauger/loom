import type { LoomBus } from "@domain/commands/bus.ts";
import type { Actor, InvocationContext } from "@domain/types/commands.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { FrameScheduler } from "@ui/controls/coalesce.ts";
import { refusalMessage, type CommandAnswer } from "@editor/inspector/command-refusal.ts";
import { createParameterEditor, type ParameterEditor } from "@editor/inspector/parameter-editor.ts";
import { phoneActorId, type PhoneSet } from "@devices/phone/phone-protocol.ts";
import { vetPhoneSet } from "@devices/phone/phone-snapshot.ts";
import { presetCatalogueHolderFor } from "@domain/presets/bank-view.ts";

/**
 * T1396b — A PHONE'S WRITES, THROUGH THE BUS, AS THAT PHONE.
 *
 * Every write a phone sends is vetted against the document as it is now
 * (`vetPhoneSet`) and applied through a parameter editor whose actor IS the phone:
 * kind `human` (a person moved it, with a finger), id `remote-<phone>` (`phoneActorId`).
 * The actor union is not widened for this — a phone is a person somewhere else, and
 * everything keyed by actor (undo stacks, audit entries, grants) already does the right
 * thing with a distinct id:
 *
 *  - **undo is per phone.** One editor per phone, so a drag from a phone is live frames
 *    plus a commit sharing ONE transaction — one undo group on that phone's stack, never
 *    on the desk's (§V15, §V41);
 *  - **the audit names the phone** — every applied patch is an entry whose actor id is
 *    `remote-<phone>` (§V31);
 *  - **grants do not follow** — `viewportControl` is granted to the page's own actor by
 *    id (`app-runtime.ts`), so a phone holds none; it only ever sends `graph.applyPatch`
 *    with one `setParameters`, which needs none. `selectCreatedNodes` returns early
 *    without `createdIds`, which a parameter write never has, so a phone cannot move
 *    the desk's selection through it either.
 *
 * ## Why a button waits for its own write
 *
 * A press is counted on the false→true edge of `held`, read from the document. A phone
 * sends press and release back to back, and the parameter editor coalesces live values
 * to a frame — so without waiting, the release would be vetted against a document that
 * does not have the press yet, and would write the old count over the new one. So each
 * phone's writes run in order on one chain, and a button write (or any commit) waits
 * for the editor to settle before the next is vetted. A slider's live frames do not
 * wait: they only need clamping, and waiting would undo the per-frame coalescing.
 *
 * ## Banks, layers and cue lists (T1503b, §T1398b ruling 12)
 *
 * A vetted write is one of three things (`PhoneVet.action`). `parameters` is the editor
 * path above. `command` is one of the vet's four — recall, GO, BACK, standby — run on the
 * bus under the phone's actor, so the audit says `human remote-<phone>` did it and its
 * one undo group lands on that phone's stack; the command and its input are the VET's,
 * never the phone's, and the vet names no Store. `layerOn` is one `setNodeUi { bypassed }`
 * written as the state asked for, and not at all when the layer is already so — the
 * desk's own rule (`board-members.tsx`), so a double tap is one undo step, not a flip
 * back. Both wait for the editor to settle first and run on the phone's lane: a press
 * sent after a fader lift lands after it.
 *
 * ## A refusal names its control (T1526b)
 *
 * Every refusal is reported with the control it is about, so the phone that pressed can be
 * shown the sentence on that control (`use-phone-door.ts` sends it; the desk's notice is
 * unchanged). The control is the VET's node id, never the handle the phone sent: a write
 * that named nothing published is reported with none. Three classes, one report each:
 * the vet refused; the bus REJECTED the command or patch; the bus answered CONFLICT (the
 * desk changed the same node between the vet and the write). A conflict on a press used
 * to be dropped without a word here; it is said now, in the bus's own sentence.
 */

export interface PhoneWritesOptions {
  readonly bus: LoomBus;
  /** The page's invocation: project and grants. The actor is replaced per phone. */
  readonly invocation: InvocationContext;
  /** Injected by tests; the default is the animation frame. */
  readonly schedule?: FrameScheduler;
  /**
   * A write the vet or the bus refused — never silence (§V365). `handle` (T1526b) is the
   * published control the refusal is about, as the vet named it, or "" when the write
   * named none.
   */
  readonly onRefused: (phone: string, reason: string, handle: string) => void;
}

export interface PhoneWrites {
  /** One phone write, vetted and applied in order after that phone's previous ones. */
  write(phone: string, set: PhoneSet): Promise<void>;
  /**
   * The phone is gone: let go of every button it was holding (a dropped connection
   * mid-press must not leave a channel stuck at 1), then forget its editor.
   */
  release(phone: string): Promise<void>;
  /** Resolves once every phone's queued writes have been applied. */
  settled(): Promise<void>;
  dispose(): void;
}

/** The actor a phone's writes carry. */
export function phoneActor(phone: string): Actor {
  return { kind: "human", id: phoneActorId(phone), label: "Phone" };
}

interface Lane {
  /** The page's invocation with this phone as its actor: what every write of its runs under. */
  readonly context: InvocationContext;
  readonly editor: ParameterEditor;
  chain: Promise<void>;
  /** Buttons this phone pressed and has not released. */
  readonly held: Set<NodeId>;
  /** The control this phone's editor wrote last: what a patch the bus did not apply is reported against. */
  last: NodeId | null;
}

/** The sentence of a result the bus did not apply — rejected, or conflicting — else null. */
function unapplied(result: CommandAnswer): string | null {
  return refusalMessage(result) ?? (result.status === "conflict" ? (result.diagnostics[0]?.message ?? "Refused") : null);
}

export function createPhoneWrites(options: PhoneWritesOptions): PhoneWrites {
  const lanes = new Map<string, Lane>();

  const laneFor = (phone: string): Lane => {
    const existing = lanes.get(phone);
    if (existing !== undefined) return existing;
    const context: InvocationContext = { ...options.invocation, actor: phoneActor(phone) };
    const lane: Lane = {
      context,
      editor: createParameterEditor({
        bus: options.bus,
        context,
        ...(options.schedule === undefined ? {} : { schedule: options.schedule }),
        onDiagnostics: (diagnostics) => {
          for (const diagnostic of diagnostics) options.onRefused(phone, diagnostic.message, lane.last ?? "");
        },
      }),
      chain: Promise.resolve(),
      held: new Set(),
      last: null,
    };
    lanes.set(phone, lane);
    return lane;
  };

  const apply = async (lane: Lane, phone: string, set: PhoneSet, report: boolean): Promise<void> => {
    // T1505b: the catalogue, so a look's instance on a remote board vets as the bank it is.
    const vet = vetPhoneSet(options.bus.store.getGraph(), set, presetCatalogueHolderFor(options.bus).current?.components);
    if (!vet.ok) {
      if (report) options.onRefused(phone, vet.reason, vet.nodeId ?? "");
      return;
    }
    if (vet.action !== "parameters") {
      await lane.editor.settled();
      const { bus } = options;
      if (vet.action === "layerOn") {
        // Read at the write, not from what the phone drew: already so = nothing to write.
        if ((bus.store.getGraph().nodes[vet.nodeId]?.ui?.bypassed !== true) === vet.on) return;
      }
      const result =
        vet.action === "command"
          ? await bus.execute(vet.command, vet.input, lane.context)
          : await bus.execute(
              "graph.applyPatch",
              {
                baseRevision: bus.store.getRevision(),
                // T1771b: a board switch of any node writes through here; the vet says which it is.
                label: `${vet.what === "switch" ? "Switch" : "Layer"} ${vet.on ? "on" : "off"} (${vet.caption})`,
                operations: [{ op: "setNodeUi", nodeId: vet.nodeId, ui: { bypassed: !vet.on } }],
              },
              lane.context,
            );
      const refused = unapplied(result);
      if (refused !== null && report) options.onRefused(phone, refused, vet.action === "command" ? vet.input.nodeId : vet.nodeId);
      return;
    }
    lane.last = vet.nodeId;
    lane.editor.setStored(vet.nodeId, vet.entries, vet.phase);
    if (vet.kind === "button") {
      if (vet.entries["held"] === true) lane.held.add(vet.nodeId);
      else lane.held.delete(vet.nodeId);
      await lane.editor.settled();
    } else if (vet.phase === "commit") {
      await lane.editor.settled();
    }
  };

  const enqueue = (lane: Lane, run: () => Promise<void>): Promise<void> => {
    const next = lane.chain.then(run, run);
    lane.chain = next.catch(() => undefined);
    return lane.chain;
  };

  return {
    write(phone, set) {
      const lane = laneFor(phone);
      return enqueue(lane, () => apply(lane, phone, set, true));
    },

    async release(phone) {
      const lane = lanes.get(phone);
      if (lane === undefined) return;
      for (const nodeId of [...lane.held]) {
        // Not reported when refused: the phone is gone, and a Panel switched off since
        // the press is the desk's own decision about that button.
        void enqueue(lane, () => apply(lane, phone, { handle: nodeId, values: { held: false }, phase: "commit" }, false));
      }
      await lane.chain;
      await lane.editor.settled();
      lane.editor.dispose();
      lanes.delete(phone);
    },

    async settled() {
      for (const lane of [...lanes.values()]) {
        await lane.chain;
        await lane.editor.settled();
      }
    },

    dispose() {
      for (const lane of lanes.values()) lane.editor.dispose();
      lanes.clear();
    },
  };
}
