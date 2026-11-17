import type { CompiledNodeDescription, NodeDefinition } from "../../domain/types/node-definition.ts";
import { EMPTY_PRESET_BANK_JSON, PRESETS_NODE_TYPE } from "../../domain/presets/bank.ts";
import { EMPTY_MORPH_RECORDS_JSON } from "../../domain/presets/morph.ts";

/**
 * T1496b (§T1398b S1, ruling 1) — Presets: a BANK of named parameter snapshots, as a node.
 *
 * Store captures the bank's `targets` (whole nodes, or single `node.key`) as whole stored
 * slots; Recall writes one back as ONE patch — one revision, one undo step, one
 * `preset.recall` audit entry. Both are bus commands (`src/domain/presets/commands.ts`),
 * so the inspector, a Panel, a pulse, an agent and the phone reach the same code.
 *
 * WHY A NODE (the design doc §4.2): the bank's data lives in its PARAMETERS, so undo,
 * autosave, copy/paste, save-as-component, component export and the agent's `get_graph`
 * all carry it with nothing built for them — the MIDI mapping's argument (`midi.ts`).
 * `node.state` would not survive paste and no patch operation writes it.
 *
 * No ports and no passes, like Panel: it reads its targets only when Store or Recall
 * runs, never per frame, so it is not a dependency of anything and prune never keeps it.
 *
 * T1497b — MORPH. `morph` and `curve` are the bank's default way of carrying a recall out
 * (a preset's own `morph`, or the recall's, overrides them); `morphs` holds the fades in
 * flight, written by Recall in the same patch as the values. Added with defaults, so no
 * migration and no version bump, exactly as Panel's `remote` was. The node still reads
 * no clock (§V44) and still has no passes: the fade is the resolver's, on the frame's
 * absolute clock, and the recall command reads the frame clock the app attached.
 */
export const presetsNode: NodeDefinition = {
  type: PRESETS_NODE_TYPE,
  version: 1,
  title: "Presets",
  category: "value",
  description:
    "A bank of presets: named snapshots of the parameters of the nodes in Targets, stored and recalled whole. Targets lists node names (every parameter of that node — for a component, its published page) or node.key (one parameter), separated by spaces or commas. Store saves them under a name; Recall writes every one back in one step that one undo reverses, expressions and modes included. A target that has since been deleted, or a value that no longer fits, is skipped with a warning naming it; a recall with nothing left to apply is refused. The Recall pulse recalls the preset named in Select, so a MIDI pad, a beat or a Button can fire it. With Morph above zero a recall fades to its values instead of cutting. Use one bank per look, per FX chain, or per set of layers.",
  tags: ["preset", "presets", "bank", "snapshot", "recall", "store", "look", "perform", "live", "cue"],
  inputs: [],
  outputs: [],
  parameters: {
    targets: {
      type: "string",
      label: "Targets",
      default: "",
      description:
        "What Store captures: node names (every parameter of that node), node.key (one parameter), or node.@on (whether that node is switched on, so a recall switches it), separated by spaces or commas. Names, so a rename or a paste keeps them pointed at the right node.",
    },
    select: {
      type: "string",
      label: "Select",
      default: "",
      description: "The preset the Recall pulse recalls.",
    },
    recall: {
      type: "pulse",
      label: "Recall",
      fires: "preset.recall",
      input: { nodeId: "$node" },
      description: "Recalls the preset named in Select. Drive it with an expression to fire it from a MIDI note, a beat or a Button.",
    },
    morph: {
      type: "number",
      label: "Morph",
      default: 0,
      min: 0,
      max: 60,
      range: "floor",
      unit: "seconds",
      description:
        "How long a recall takes to arrive, in seconds of playback. 0 cuts. The parameters take their new values at once — the inspector, a save and undo all see the destination — and the picture blends to them, pausing when the transport pauses and running on through a loop. Numbers, vectors and colours blend; a menu, a switch, a name or a structural setting cuts at the start. Recalling again mid-fade carries on from what is on screen; editing a fading parameter by hand takes it over at once. An export renders the end state. A preset that carries its own morph, or a recall that names one, overrides this.",
    },
    curve: {
      type: "enum",
      label: "Curve",
      default: "smooth",
      options: [
        { value: "linear", label: "Linear" },
        { value: "smooth", label: "Smooth" },
        { value: "in", label: "Ease in" },
        { value: "out", label: "Ease out" },
      ],
      description: "How the fade is paced: Linear is even, Smooth eases both ends, Ease in starts slowly, Ease out arrives slowly.",
    },
    current: {
      type: "string",
      label: "Current",
      default: "",
      description: "The preset recalled last. Written by Recall, so Panels and the phone can show which one is live.",
    },
    /*
     * THE BANK IS DOCUMENT STATE, and `code`/`json` for the MIDI mapping's reasons: a Store
     * is an ordinary parameter edit (undo, autosave, the diff and the agent surface for
     * free), and §V458's declared code kind gets it the JSON editor with no UI file
     * knowing this node exists. `src/domain/presets/bank.ts` defines the shape. Last, so
     * its editor sits below the controls (T1052).
     */
    presets: {
      type: "code",
      language: "json",
      label: "Presets",
      default: EMPTY_PRESET_BANK_JSON,
      description:
        "The bank: { version: 1, presets: [{ name, values: { node: { key: value } } }] }. Written by Store; editable by hand. Each value is kept as stored — an expression stays an expression. By hand a preset can also hold on: { layerName: true | false }, which switches Layer nodes on or off in the same step, and recalls: [{ bank, preset }], which recalls other banks' presets in the same step (a shot): its own values win over theirs, a later recall over an earlier one, up to 4 deep, and banks that recall each other in a circle are refused.",
    },
    /*
     * T1497b — THE FADES IN FLIGHT, as document state for the bank's own reason: one undo
     * takes a recall's record away with the values it fades, and a copy, an autosave and
     * `get_node` carry it. `src/domain/presets/morph.ts` defines the shape. Visible and
     * inspectable; not meant for typing — a record that does not parse simply does not fade.
     */
    morphs: {
      type: "code",
      language: "json",
      label: "Morphs",
      default: EMPTY_MORPH_RECORDS_JSON,
      description:
        "The fades this bank has running: { version: 1, records: [{ epoch, start, seconds, curve, preset, from, to }] }. Written by Recall; read by the renderer. Clear it to end every fade at once.",
    },
  },
  compile: (): CompiledNodeDescription => ({ passes: [] }),
};
