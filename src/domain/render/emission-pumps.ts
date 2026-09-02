import { NODE_SIDE_EFFECTS } from "./side-effects.ts";

/**
 * T1005 — THE SET OF EMISSION SITES, derived and gated the way §T949's ledger derives
 * the set of nodes.
 *
 * ## The residual gap this closes, in one sentence
 *
 * §T949's structural scan stops a send INSIDE a node definition, and its policy check
 * stops the one pump that existed — but nothing forced a SECOND pump to consult
 * `emissionRefusal`, and the author who writes the second pump is the author wiring a
 * laser (§T950). A safety property that holds because every author remembered is not a
 * property; this ledger and its gate (`emission-sites.test.ts`) make forgetting fail.
 *
 * ## What a PUMP is, structurally
 *
 * A pump is the session-side module that moves an `emits` node's data out of the
 * process: it reads the live frame loop, consults `emissionRefusal` per node, and hands
 * bytes to a transport. The node definition never emits (§T949's scan holds that), so
 * for every node with `sideEffect: "emits"` exactly this kind of module must exist —
 * and each one is a REVIEWED, NAMED thing, because it is the last code between a
 * document and hardware.
 *
 * ## How the gate finds an UNREGISTERED pump, and the honest limit
 *
 * Touching the emission surface at all is the tell: a pump must know WHICH nodes emit,
 * and the legitimate ways to know — `NODE_SIDE_EFFECTS`, `actsOnWorld`,
 * `emittingNodeTypes`, `emissionRefusal`, or naming an emitting type literal — are all
 * tokens a comments-stripped source scan can see (§V272's mechanism, §V840's per-path
 * discipline). Any module outside `src/domain/render/` and the definition tree whose
 * CODE carries one of those tokens is treated as a pump and must appear here, where the
 * companion gate then requires the `emissionRefusal` call. The stated residual: a
 * module that hardcodes a transport without ever naming an emitting node or the
 * side-effect surface is invisible to this scan — but it is then also not wired to any
 * `emits` node, and the definition scan keeps emission out of the nodes themselves.
 *
 * ## Why the ledger names FILES
 *
 * The value is a repo-relative path, so the gate can hold the registration and the
 * refusal call to each other in both directions (the `sourceReferences` /
 * `SOURCE_REFERENCE_PARAMETERS` shape §T949 reused): an `emits` node without a pump
 * fails, a pump file that forgot `emissionRefusal` fails, a row pointing at a deleted
 * file fails, and a module that became a pump without a row fails. §T950's Ether Dream
 * pump lands by adding ONE row here — and cannot land any other way.
 */
export const EMISSION_PUMPS: Readonly<Record<string, string>> = {
  /*
   * T942 tier 3 / T949. The OSC pump: reads the live value graph each frame, consults
   * `emissionRefusal` per node (a take, a headless export and every gate get the
   * refusal, §V840's three paths), and sends datagrams through the bridge helper — the
   * page itself cannot speak UDP, which is also why the egress API scan never sees a
   * socket here.
   */
  oscOut: "src/app/use-osc-bridge.ts",
};

/**
 * T1006's deriver, provided where the pumps can reach it: the node types whose data may
 * leave the process, FROM the ledger rather than from a hand-list. The OSC pump's
 * `node.type !== "oscIn" && node.type !== "oscOut"` is §B45/§V316's shape — harmless
 * with one transport, wrong the moment `laserOut` lands — and every future pump filters
 * with this instead.
 */
export function emittingNodeTypes(): readonly string[] {
  return Object.entries(NODE_SIDE_EFFECTS)
    .filter(([, effect]) => effect === "emits")
    .map(([type]) => type)
    .sort();
}
