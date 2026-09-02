import { useCallback, useState } from "react";

import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import { EMISSION_PUMPS } from "@domain/render/emission-pumps.ts";
import { emissionRefusal, type SideEffectPolicy } from "@domain/render/side-effects.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";

/**
 * T950 — the LASER pump: the one registered emission site for `laserOut`
 * (`EMISSION_PUMPS`, §T1005's gates), consulting `emissionRefusal` per node.
 *
 * ## No transport exists in this build, and that is a MECHANISM, not a policy (§V840)
 *
 * §V840's rule is that every no-fire path names its mechanism, because "is an export"
 * is a category three paths can share while only one was verified. Here every path
 * shares ONE mechanism and it is checkable by reading this file: THIS MODULE CONSTRUCTS
 * NO SENDER OF ANY KIND — no device client, no socket factory, no bridge attachment.
 * The wire protocol is already built and emulator-gated (`src/mcp/ether-dream.ts`,
 * G2/G3/G4/G9 enforced at the byte encoders); until the bridge helper grows its laser
 * driver — with the dead-man timer on the helper side of the page boundary, where a
 * page crash cannot take it down — there is nothing here a byte could leave through.
 * When that driver lands, the send goes HERE and nowhere else: §T1005's tripwire pins
 * this file as the registered site, and its refusal gate already demands the
 * `emissionRefusal` call this module makes.
 *
 * ## What it does today
 *
 * Enumerates the document's `laserOut` nodes — the set derived from `EMISSION_PUMPS`
 * (the entries this file is registered for), never a hand-list (§T1006/§B45) — and
 * publishes one diagnostic per node into the problems pane's list (the OSC pump's
 * no-new-chrome shape): under a blocked policy, `emissionRefusal`'s own sentence;
 * live, the honest state of this build — simulation only, driver not yet available.
 */

/** The ledger path THIS module is registered under; the derivation key, not a display string. */
const PUMP_PATH = "src/app/use-laser-bridge.ts";

/** The node types this pump owns, from the ledger — never a hand-list (§T1006). */
export function laserPumpNodeTypes(): readonly string[] {
  return Object.entries(EMISSION_PUMPS)
    .filter(([, path]) => path === PUMP_PATH)
    .map(([type]) => type)
    .sort();
}

/**
 * The pump's per-sync assessment, pure so the headless gate can drive it without React:
 * one diagnostic per world-acting laser node, refusal-first.
 */
export function laserPumpDiagnostics(
  graph: GraphDocument,
  registry: NodeRegistryView,
  policy: SideEffectPolicy,
): RuntimeDiagnostic[] {
  const types = new Set(laserPumpNodeTypes());
  const diagnostics: RuntimeDiagnostic[] = [];
  for (const nodeId of Object.keys(graph.nodes).sort()) {
    const node = graph.nodes[nodeId];
    if (node === undefined || !types.has(node.type)) continue;
    const definition = registry.get(node.type);
    const refusal = emissionRefusal(definition, policy);
    if (refusal !== null) {
      // §V365: the refusal reaches a surface — a rig dark with no explanation reads as
      // a rig that is broken.
      diagnostics.push({
        severity: "info",
        code: "laser.emission.blocked",
        message: refusal,
        nodeId,
      });
      continue;
    }
    diagnostics.push({
      severity: "info",
      code: "laser.driver.absent",
      message:
        "Laser Out is simulation-only in this build: the local helper has no laser driver yet, " +
        "and this session constructs no transport, so nothing is transmitted. The preview IS the " +
        "planned stream — what you see is what a DAC would receive.",
      nodeId,
    });
  }
  return diagnostics;
}

/**
 * The session hook — the OSC pump's diagnostics-only shape: renders nothing, owns no
 * panel, feeds `app.tsx`'s one diagnostics list.
 */
export function useLaserBridge(): {
  readonly diagnostics: readonly RuntimeDiagnostic[];
  sync(graph: GraphDocument, registry: NodeRegistryView, policy: SideEffectPolicy): void;
} {
  const [diagnostics, setDiagnostics] = useState<readonly RuntimeDiagnostic[]>([]);
  const sync = useCallback((graph: GraphDocument, registry: NodeRegistryView, policy: SideEffectPolicy) => {
    const next = laserPumpDiagnostics(graph, registry, policy);
    setDiagnostics((prior) => {
      if (
        prior.length === next.length &&
        prior.every((entry, at) => entry.code === next[at]?.code && entry.nodeId === next[at]?.nodeId)
      ) {
        return prior;
      }
      return next;
    });
  }, []);
  return { diagnostics, sync };
}
