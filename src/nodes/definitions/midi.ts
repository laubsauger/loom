import type { CompiledNodeDescription, NodeDefinition } from "../../domain/types/node-definition.ts";
import {
  midiBindingValue,
  midiChannelName,
  parseMidiMapping,
} from "../../domain/midi/midi-mapping.ts";
import { VALUE_PORT } from "./common-ports.ts";

/**
 * T942 tier 1 — MIDI In: a controller as channels, the way Mouse is the pointer as
 * channels and Audio In is sound as channels.
 *
 * ## One node per DEVICE, publishing every LEARNED control
 *
 * The house style was already decided by `mouse` (`{ x, y, buttons }`) and the plan's §5.1
 * follows it: a value node publishes a channel BAG, so a controller — which is physically
 * a bag of controls — is ONE node whose bag is everything the user has learned on it.
 * Wire `midi1` into a Lag and every knob smooths at once; address one with `midi1:cutoff`.
 * The alternative (a node per CC) would put sixteen nodes on the canvas for one hardware
 * unit and make a Lag a per-knob chore.
 *
 * ## It reads the SEAM, it does not open a device (§V182 with knobs)
 *
 * There is no listener here and no `requestMIDIAccess`. The session opens the ports once
 * and publishes raw readings into `ValueEvaluateContext.channels` — the same seam
 * `analyze` publishes into and `channelIn` reads — and this node is a pure projection of
 * it through the mapping. Two consequences fall out for free rather than being built:
 * a headless caller that feeds `channels` REPLAYS a performance, and the node cannot tell
 * whether it is live or replayed, which is the property that makes a replay honest.
 *
 * ## ABSENCE IS THE NORMAL STATE AND IT IS NOT AN ERROR (§T715's constraint, §T948)
 *
 * Safari has no Web MIDI at any version. Chrome prompts for all MIDI access since 124.
 * Firefox needs a site-permission add-on and cannot tell a denial from a missing add-on.
 * And the ordinary case — someone opening a patch on a laptop with nothing plugged in —
 * looks identical to all of those from in here. So the node ALWAYS exists, ALWAYS
 * publishes its output type, and a learned channel with nothing behind it publishes its
 * REST value: `rest`, else `range[0]`, never a blind zero (§V353 — a centre-detented knob
 * must rest at centre) and never an absent channel (which would dangle every parameter
 * driven by it). The document loads and renders, degraded.
 *
 * WHICH of those it is, is not knowable here and is not guessed here: the inspector's MIDI
 * section owns that sentence, because only the session knows whether the browser has the
 * API, whether access was granted, and whether a port is attached (§V359 — an unavailable
 * thing is rendered WITH ITS REASON, never hidden).
 *
 * ## What it decodes, and what it does not
 *
 * 7-bit CC and 14-bit pitch bend. Not notes, not clock, not 14-bit CC pairs, not SysEx —
 * `midi-mapping.ts`'s module note states each one and what happens instead. An
 * unsupported message is dropped at the decoder, so it can never be learned and can never
 * publish; it does nothing rather than something surprising.
 *
 * ## Reproducibility: `external-live`, and the gate makes that a decision
 *
 * `NODE_REPRODUCIBILITY` refuses to let this node land unclassified. It is a live device
 * in exactly the sense `audioIn` and `mouse` are: what a take captures depends on when
 * the take ran, and no parameter changes that. So a render naming it warns, once, from
 * the one call site that already warns about `webcam`.
 */
export const midiInNode: NodeDefinition = {
  type: "midiIn",
  version: 1,
  title: "MIDI In",
  category: "input",
  description:
    "A MIDI controller as channels: every control you have learned, published under the name you gave it, so midi1:cutoff drives a parameter and a Lag on the node smooths all of them at once. Learn a control in the inspector — arm a row, move the knob — rather than typing CC numbers. Reads 7-bit Control Change and 14-bit pitch bend; notes, velocity, MIDI clock, 14-bit CC pairs and SysEx are NOT read, and an unsupported message is ignored rather than approximated. Range maps 0..1 to the band you want at the source, so nothing downstream has to rebuild a gain and bias per knob; set it to 0..127 to read the raw controller value instead. Toggle mode latches a momentary pad. With no Web MIDI, no permission or no device attached the node still publishes every learned channel at its Rest value, so the document loads and renders — the inspector's MIDI section says which of those it is. CLOCKLESS (§V436): it reports where the controls are, so a timeline loop passes straight through it. Live hardware: a render over it does not reproduce.",
  tags: ["value", "input", "midi", "controller", "cc", "learn"],
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: VALUE_PORT }],
  parameters: {
    /*
     * The PORT id, read by the app's MIDI session — never by compile. Empty means "any
     * attached device", which is what a freshly-dropped node should do: the alternative
     * is a node that publishes nothing until the user has also visited a picker.
     *
     * §T811's wart is inherited knowingly: with no presentation flag on
     * `ParameterDefinition` this renders as a raw string field beside the inspector's
     * picker, exactly as `audioIn.device` and `webcam.device` do. Mirroring includes the
     * wart; a third instance is the argument for fixing it, not a reason to diverge here.
     */
    device: {
      type: "string",
      label: "Device",
      default: "",
      description:
        "MIDI input port id, from the inspector's device picker. Empty = any attached input. Port names are hidden until MIDI access is granted.",
    },
    /*
     * THE MAPPING IS DOCUMENT STATE. A project that forgets which knob was the cutoff is
     * not a project — so a learn is an ordinary parameter edit, and undo, autosave, the
     * agent surface and the diff all work on it without anything being built for them.
     *
     * The ARMING state (which row is waiting for a wiggle) is session state and is
     * deliberately NOT here: an armed row saved into a file would re-arm on open.
     *
     * `code`/`json` rather than a bare string, for the same reason `pointKernel.attributes`
     * is: §V458 makes code-ness a DECLARED kind, and declaring it is what gets this the
     * JSON editor, the highlighting and the code pane without a UI file knowing the node
     * exists. The inspector's MIDI section is the friendly face of the same value.
     */
    mapping: {
      type: "code",
      language: "json",
      label: "Mapping",
      default: "[]",
      description:
        "The learned controls, as a list: channel (the published name), source (cc/pitchBend, MIDI channel, controller number), range, mode, and rest. Written by the inspector's Learn buttons; editable here when you want to retype a name or a band by hand.",
    },
  },
  valueEvaluate: ({ values, channels, state }) => {
    const { bindings } = parseMidiMapping(values["mapping"]);
    const device = typeof values["device"] === "string" ? (values["device"] as string).trim() : "";
    const bag: Record<string, number> = {};
    for (const binding of bindings) {
      const raw = binding.source === null ? undefined : channels?.(midiChannelName(device, binding.source));
      bag[binding.channel] = midiBindingValue(binding, raw, state);
    }
    return bag;
  },
  /*
   * No passes, and no diagnostics either — deliberately, and this is worth stating so the
   * next reader does not "fix" it. A value node reaches the GPU plan only through a sink,
   * and `midiIn` has no texture edge, so `prune` never keeps it and `compile()` is never
   * called on it. A mapping-parse diagnostic emitted here would be a message nobody ever
   * receives, which is worse than no message: it would read, in the source, as though the
   * problem were reported. `parseMidiMapping`'s reason is surfaced where the mapping is
   * EDITED instead — the inspector's MIDI section (§V288: the answer belongs where the
   * user is already looking).
   */
  compile: (): CompiledNodeDescription => ({ passes: [] }),
};
