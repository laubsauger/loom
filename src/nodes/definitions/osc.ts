import type { CompiledNodeDescription, NodeDefinition } from "../../domain/types/node-definition.ts";
import type { ParameterSchema } from "../../domain/types/parameters.ts";
import {
  oscControlParameters,
  oscControlValue,
  oscControlsOf,
  parseOscControlNames,
} from "../../domain/osc/osc-mapping.ts";
import { OSC_CHANNEL_PREFIX } from "../../domain/osc/osc-address.ts";
import { VALUE_PORT } from "./common-ports.ts";
// T1110: the helper's COMMAND is spelled in exactly one place (`devices/helper.ts`), so a
// rename reaches every node description as well as every refusal. Constants only; the
// definition stays headless (§V11).
import { DEVICE_HELPER_COMMAND } from "../../devices/helper.ts";

/**
 * T942 tier 3 — OSC IN and OSC OUT: the studio's lingua franca, both directions.
 *
 * ## An OSC address IS a channel name, so there is no new machinery here
 *
 * `ValueEvaluateContext.channels?: (name) => number | undefined` takes arbitrary string
 * names and was built for `analyze`. The helper publishes every OSC argument under
 * `osc:<address>`, and `oscIn` is a projection of those readings through a list of learned
 * addresses — exactly the shape `midiIn` has over `midi:<port>:<control>` (§T959). No new
 * port type, no compiler change, no second seam. `channelIn` reads a raw address for free.
 *
 * ## IT READS THE SEAM, IT DOES NOT OPEN A SOCKET (§V182 with a network)
 *
 * There is no socket here and no `WebSocket`. A page cannot speak UDP at all — that is
 * the whole reason a helper exists — so the session holds ONE device attachment, the
 * helper holds the UDP socket, and this node is a pure function of what arrived. Two
 * consequences fall out rather than being built: a headless caller that feeds `channels`
 * REPLAYS a performance, and the node cannot tell whether it is live or replayed.
 *
 * ## ABSENCE IS THE NORMAL STATE AND IT IS NOT AN ERROR (§T715, §T948)
 *
 * Nobody has a helper running until they start one, and the hosted build has no helper at
 * all — which is EXACTLY as limited as a local clone with the helper stopped, which is why
 * §T948 rule 1 says to probe the capability rather than the deployment. So the node ALWAYS
 * exists, ALWAYS publishes its output type, and a learned address with nothing behind it
 * publishes its declared REST — never an absent channel (which would dangle every
 * parameter driven by it) and never a stall. The document loads and renders, degraded.
 *
 * WHICH absence it is, is not knowable here and is not guessed here: only the session
 * knows whether a helper answered, whether the pairing was accepted and whether a socket
 * is open, so it publishes that sentence as a DIAGNOSTIC against this node and the
 * problems pane renders it (§V359, §V365 — the reason must reach a surface).
 *
 * ## THE NODE IS THE WHOLE INTERFACE — NO PANE, NO PICKER, NO BESPOKE TABLE
 *
 * Owner's ruling: *"everything should be a node surface so that we don't end up with a
 * million menu sections hard coded into our app… the interface to the user stays in the
 * node."* So `oscIn` declares its controls in a `controls` parameter and GENERATES the
 * rest of its own schema with `parametersFor` (§T880's mechanism, the same one
 * `customWgsl` uses to turn a shader's `struct Params` into knobs): one Address and one
 * Rest parameter per declared name, rendered by the ordinary parameter controls, drivable
 * and undoable and agent-visible because they are not special. A device that ships later
 * — a laser, a depth camera — adds a node and its parameters, and adds no chrome.
 *
 * ## Reproducibility, and the two nodes answer differently
 *
 * `oscIn` is `external-live`: what a take captures depends on when the take ran, exactly
 * as for `webcam`, `audioIn`, `mouse` and `midiIn`.
 *
 * `oscOut` is `pure`, and the reason is worth stating because it looks wrong at a glance.
 * The node is a PASSTHROUGH — its published bag is its input bag, so the same document at
 * the same frame renders the same pixels whether or not anything is listening. The
 * TRANSMISSION is not in `valueEvaluate` at all: it is a session concern, pumped from the
 * app's live frame loop (`use-osc-bridge.ts`), which is also the answer to "what does an
 * offline render do" — it installs no pump, so an export transmits nothing. Putting the
 * send inside `valueEvaluate` would have made a headless render fire UDP at a lighting rig
 * and made a value node impure at the same time.
 */

const OSC_PORT_HINT = "UDP port. 0 means not listening — there is no default port.";

const OSC_IN_DESCRIPTION =
  `OSC as channels: every address you have learned, published under the name you gave it, so osc1:cutoff drives a parameter and a Lag on the node smooths all of them at once. Name the channels you want in Controls and each one grows its own Address and Rest parameter on this node — there is no separate panel to visit. Needs a local helper (${DEVICE_HELPER_COMMAND}) because a browser page cannot receive UDP, and the helper listens on 127.0.0.1 only, so the sender must be on this machine. Values arrive EXACTLY as sent: unlike a 7-bit MIDI CC, an OSC argument has no declared full scale, so nothing is normalised for you — wire a Value Math when you want a band. Multi-argument messages address by index, so /pad/xy publishes /pad/xy/0 and /pad/xy/1. With no helper, no port or nothing arriving, every learned row still publishes its Rest value, so the document loads and renders — the inspector's OSC section says which of those it is. CLOCKLESS (§V436): it reports where the controls are, so a timeline loop passes straight through it. Live input: a render over it does not reproduce.`;

/**
 * `oscIn`'s STATIC half, hoisted so `parametersFor` can compose it without reading the
 * definition's own `parameters` field.
 *
 * That read would trip §T903's funnel gate — `effective-schema-closure.test.ts` fails on
 * any read of a node's schema outside `effectiveParameterSchema`, and it is right to: the
 * three rounds of §T880/§B166/§B167 were each "a surface someone happened to think of".
 * Hoisting the literal keeps the one legitimate composition — a node building its OWN
 * effective schema — from having to become an exception in that ledger.
 */
const OSC_IN_PARAMETERS: ParameterSchema = {
  /*
   * THE PORT IS DOCUMENT STATE AND ITS DEFAULT IS NOTHING (§T950 gap 4's sibling).
   *
   * A default port would mean a document that opens a listening UDP socket because it
   * was opened — the ingress half of "no default destination". Zero means the node is
   * complete, publishes its rests, and says what to do next.
   *
   * It lives on the NODE rather than in a session dialog because the document is the
   * thing that knows which port the patch was built for: reopening a project on another
   * machine should not require remembering 9000. The session subscribes to the union of
   * the ports its `oscIn` nodes name — see `use-osc-bridge.ts`.
   */
  port: {
    type: "number",
    label: "Port",
    default: 0,
    min: 0,
    max: 65_535,
    // §B111: a UDP port outside 0..65535 is not a slider that ran out of travel, it is a
    // number that cannot exist. BOUNDED, at both ends, and clamped rather than shown.
    range: "bounded",
    step: 1,
    description: `${OSC_PORT_HINT} The helper binds 127.0.0.1, so a sender on another machine cannot reach it.`,
  },
  /*
   * THE DECLARATION, AND THE ONLY HAND-WRITTEN PART OF THE MAPPING.
   *
   * Naming a control here GROWS THE NODE'S OWN SCHEMA — `parametersFor` below turns
   * `cutoff pan` into `cutoffAddress`, `cutoffRest`, `panAddress`, `panRest`. That is
   * why there is no JSON blob and no table: the rows ARE parameters, so undo, autosave,
   * the diff, the agent surface and every parameter mode work on them for free.
   *
   * The names are the USER'S and that is deliberate (§V129): `osc1:cutoff` is a readable
   * driven-parameter reference and `osc1:/synth/cutoff` is not. The indirection is
   * TouchDesigner's one good idea about mapping — the NODE names channels, the
   * PARAMETER names the wire — so re-pointing at a different sender leaves every driven
   * parameter in the document untouched.
   */
  controls: {
    type: "string",
    label: "Controls",
    default: "",
    description:
      "Names of the channels this node publishes, separated by spaces — e.g. `cutoff pan`. Each one grows an Address and a Rest parameter below. Names are identifiers, so `osc1:cutoff` reads as an address in a driven parameter.",
  },
};

export const oscInNode: NodeDefinition = {
  type: "oscIn",
  version: 1,
  title: "OSC In",
  category: "input",
  description: OSC_IN_DESCRIPTION,
  tags: ["value", "input", "osc", "network", "bridge", "learn"],
  /*
   * T1006 — THE INGRESS DECLARATION, and it is the mirror of `oscOut`'s `sideEffect`.
   *
   * The session opens the union of the ports its `listensOn` nodes name. Saying it here
   * rather than letting the pump match on the type name is what stops §B45/§V316's
   * shape recurring: the pump filtered `node.type !== "oscIn" && node.type !== "oscOut"`,
   * a set stated over a category and implemented as two members, and a second listening
   * node would have been skipped in silence.
   *
   * It is load-bearing, not documentation: delete this and no socket is ever opened for
   * this node — `use-osc-bridge.test.tsx` measures exactly that.
   */
  listensOn: { channelPrefix: OSC_CHANNEL_PREFIX, portParameter: "port" },
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: VALUE_PORT }],
  parameters: OSC_IN_PARAMETERS,
  /**
   * PER-INSTANCE schema (§T880's mechanism, the owner's node-surface ruling).
   *
   * `customWgsl` reflects its knobs out of a shader's `struct Params`; this reflects its
   * rows out of its own `controls` list. Same hook, same consequence: the node's controls
   * follow the node's own state, and no UI file has to know that OSC exists. The static
   * schema above stays the fallback for the type-only contexts — the palette, a fresh drop
   * — where there is no stored declaration to read.
   */
  parametersFor(stored) {
    return {
      ...OSC_IN_PARAMETERS,
      ...oscControlParameters(parseOscControlNames(stored["controls"])),
    };
  },
  valueEvaluate: ({ values, channels }) => {
    const bag: Record<string, number> = {};
    for (const control of oscControlsOf(values)) {
      const raw = control.address === null ? undefined : channels?.(`${OSC_CHANNEL_PREFIX}${control.address}`);
      bag[control.channel] = oscControlValue(control, raw);
    }
    return bag;
  },
  /*
   * No passes and no diagnostics, for `midiIn`'s reason exactly: a value node reaches the
   * GPU plan only through a sink, so `compile()` is never called on this one and a
   * diagnostic emitted here would be a message nobody receives — which reads, in the
   * source, as though the problem were reported. The parse reason is surfaced where the
   * declaration is EDITED — the node's own parameters (§V288).
   */
  compile: (): CompiledNodeDescription => ({ passes: [] }),
};

export const oscOutNode: NodeDefinition = {
  type: "oscOut",
  version: 1,
  title: "OSC Out",
  category: "output",
  description:
    `Sends this node's incoming channels out as OSC, so Loom is a PEER in a studio chain rather than a leaf. One channel called value sends /address; several send /address/name each. Needs a local helper (${DEVICE_HELPER_COMMAND}) because a browser page cannot speak UDP. THERE IS NO DEFAULT DESTINATION: set Host and Port or nothing is transmitted, and broadcast and multicast addresses are refused by name — a lighting network is a network. OSC rides UDP, so the helper can report that a datagram LEFT this machine and can never report that it arrived: the inspector says sent, arrival unconfirmed, and means it. Passes its input through unchanged, so it can sit inline in a chain and its plot shows what is being sent. The transmission happens in the live session only — an offline or headless render of this document sends nothing.`,
  tags: ["value", "output", "osc", "network", "bridge", "send"],
  /*
   * T949 — THE ONE WORLD-ACTING NODE IN THE CATALOGUE, and the declaration is separate
   * from `NODE_REPRODUCIBILITY` on purpose.
   *
   * This node is `pure` there and that stays true: it publishes its input bag unchanged,
   * so the render reproduces whether or not anything is listening. What that answer
   * cannot say is that a datagram leaves the machine, and `pure` is exactly the class a
   * headless export treats as safe to evaluate. `emissionRefusal` reads THIS field, and
   * `use-osc-bridge.ts` consults it per node per frame — so a take, a headless export and
   * every Dawn gate send nothing, by a check rather than by nobody having built a pump.
   */
  sideEffect: "emits",
  inputs: [{ id: "in", label: "In", type: VALUE_PORT }],
  outputs: [{ id: "out", label: "Out", type: VALUE_PORT }],
  parameters: {
    /*
     * §T950 GAP 4 — NO DEFAULT DESTINATION, AND THIS IS WHERE IT STARTS.
     *
     * Art-Net's default is a broadcast address; defaulting a destination is §T458's
     * measured mistake (a "local relay" bound to the wildcard) wearing a different
     * protocol. So an empty host and a zero port are the shipped defaults, a fresh node
     * transmits NOTHING, and `vetOscDestination` refuses both — on the page's side before
     * a byte leaves, and again in the helper, which is the side that owns the socket.
     */
    host: {
      type: "string",
      label: "Host",
      default: "",
      description:
        "Destination IPv4 address, or localhost. Empty means nothing is sent — there is no default. A broadcast address (x.x.x.255), a multicast address and a name needing DNS are all refused.",
    },
    port: {
      type: "number",
      label: "Port",
      default: 0,
      min: 0,
      max: 65_535,
      range: "bounded",
      step: 1,
      description: `${OSC_PORT_HINT} Set both Host and Port before anything is transmitted.`,
    },
    address: {
      type: "string",
      label: "Address",
      default: "",
      description:
        "OSC address to send under, e.g. /loom/level. Empty uses this node's own name, so oscOut1 sends /oscOut1 — the mirror of how a value channel is addressed in the graph.",
    },
    rate: {
      type: "number",
      label: "Rate",
      default: 30,
      min: 1,
      // §B111: SOFT at the top — 120 is where the slider stops being useful, not a limit
      // the transport imposes, and someone driving a fast receiver may type more.
      max: 120,
      range: "soft",
      step: 1,
      description:
        "Maximum messages per second. Control data does not need a frame rate, and a receiver on the far side of a network is happier at 30 than at 120.",
    },
  },
  /*
   * A WIRE THAT ALSO LISTENS. The bag goes through unchanged so the node can sit inline
   * without breaking a chain, its plot shows exactly what is being sent, and — the part
   * that matters — this function stays PURE. The send is pumped from the session, not
   * from here; see the module note.
   */
  valueEvaluate: ({ inputs }) => inputs["in"] ?? {},
  compile: (): CompiledNodeDescription => ({ passes: [] }),
};
