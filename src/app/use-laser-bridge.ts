import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { EMISSION_PUMPS } from "@domain/render/emission-pumps.ts";
import { emissionRefusal, type SideEffectPolicy } from "@domain/render/side-effects.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";
import { laserStreamRegions } from "@nodes/definitions/laser-path.ts";
import type { PassDescriptor } from "@runtime/backend/plan.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";
import type { LoomBus } from "@domain/commands/bus.ts";
import type { DeviceClient } from "@/mcp/device-client.ts";
import type { LaserStateReport } from "@/mcp/device-protocol.ts";

declare module "@domain/types/commands.ts" {
  interface CommandMap {
    "laser.estop": { input: Record<string, never>; output: { fired: boolean } };
  }
}

/**
 * T950 — the LASER pump: the one registered emission site for `laserOut`
 * (`EMISSION_PUMPS`, §T1005's gates), now CARRYING ITS TRANSPORT. The owner's go
 * replaced the no-transport build; the docblock therefore names the no-fire MECHANISM
 * PER PATH, as §V840 demands of exactly this moment:
 *
 *  - a headless render, an export, every Dawn gate: constructs no React tree, so this
 *    hook — the only module that can reach `DeviceClient.laser` — never exists;
 *  - an in-app TAKE: `sync` receives policy `"blocked"` (the same holder-checked
 *    argument the OSC pump reads, per frame, no state flag) and `emissionRefusal`
 *    refuses per node before any client call;
 *  - a live session with no helper: `deviceClient()` is null — there is no socket;
 *  - a live session, helper attached, NOT ARMED: the helper's own state machine
 *    refuses ("arming is a deliberate session action and never a document state"),
 *    and this pump does not even send: it checks its session's armed flag first;
 *  - armed and streaming, page dies or stalls: the HELPER's dead-man blanks, stops
 *    and e-stops on its own clock — the failsafe on the far side of this file.
 *
 * ## Arming is SESSION state (G1), and the session lives here
 *
 * `armed` is a `useState` in a hook: it cannot be saved, cannot arrive in a document,
 * and does not survive a reload — by construction, not by convention. The surface
 * that flips it is the laserOut node's inspector section plus the always-visible
 * E-stop (G7) the app shows while armed.
 *
 * ## What a frame sends
 *
 * The planner's OWN stream: the pump reads the laserPath buffers feeding the armed
 * `laserOut` (position + tint pairs, last completed frame, through the metered
 * readback — §V185) and hands the samples to the helper flat. Unlit samples cross as
 * blanked moves — the galvo path is the plan's path, dark where the plan is dark —
 * and the parked tail is trimmed at the park marker. G3/G4/G9 are enforced again on
 * the helper side at the byte encoders; this pump cannot bypass them by existing.
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

const PARKED_Z = -1.0e6;

/** The laserPath node feeding a laserOut's points input, or null when unwired. */
export function laserSourceOf(graph: GraphDocument, laserOutId: NodeId): NodeId | null {
  for (const edge of Object.values(graph.edges)) {
    if (edge.target.nodeId === laserOutId && edge.target.portId === "points") {
      return edge.source.nodeId;
    }
  }
  return null;
}

/**
 * Planner buffers → the wire's flat (x, y, r, g, b) array. Pure, so the gate feeds it
 * bytes directly. Stops at the park marker (the plan's tail); unlit samples keep their
 * position with zero colour — blanked travel is still the galvo's path.
 */
export function samplesFromBuffers(position: Float32Array, tint: Float32Array): number[] {
  const flat: number[] = [];
  const slots = Math.min(Math.floor(position.length / 4), Math.floor(tint.length / 4));
  for (let slot = 0; slot < slots; slot += 1) {
    const base = slot * 4;
    if (position[base + 2] === PARKED_Z) break;
    // Unlit = a blanked MOVE: the position still crosses (the galvo's path is the
    // plan's path), the colour does not.
    const lit = (tint[base + 3] ?? 0) > 0;
    flat.push(
      position[base] ?? 0,
      position[base + 1] ?? 0,
      lit ? (tint[base] ?? 0) : 0,
      lit ? (tint[base + 1] ?? 0) : 0,
      lit ? (tint[base + 2] ?? 0) : 0,
    );
  }
  return flat;
}

export interface LaserSessionSurface {
  readonly report: LaserStateReport | null;
  readonly armed: boolean;
  readonly detail: string;
  connect(host: string, maxPps: number): Promise<string | null>;
  arm(): Promise<string | null>;
  disarm(): Promise<void>;
  estop(): Promise<void>;
  clearEstop(): Promise<string | null>;
}

export function useLaserBridge(options: {
  /** The OSC hook's shared device client — one device attachment per tab. */
  deviceClient: () => DeviceClient | null;
  backend?: () => LoomBackend | null;
  /** For G7's key binding: `laser.estop` registers as a bus command, so the keymap
   *  reaches it without the render loop — a hung graph is exactly when it is needed. */
  bus?: LoomBus;
}): {
  readonly diagnostics: readonly RuntimeDiagnostic[];
  readonly session: LaserSessionSurface;
  /**
   * T1076: `passes` is the current plan's pass list, and it is what tells the pump WHERE
   * the planned stream is. The stream used to be two buffers whose ids the pump rebuilt
   * from the source node id by convention; it is now two REGIONS of one packed buffer,
   * and the plan is the only thing that says so. Omitted (or from a compile with no laser
   * plan), the pump reports a missing stream rather than reading bytes that mean
   * something else.
   */
  sync(
    graph: GraphDocument,
    registry: NodeRegistryView,
    policy: SideEffectPolicy,
    pointRate?: number,
    passes?: ReadonlyArray<PassDescriptor>,
  ): void;
} {
  const [diagnostics, setDiagnostics] = useState<readonly RuntimeDiagnostic[]>([]);
  const [report, setReport] = useState<LaserStateReport | null>(null);
  const [armed, setArmed] = useState(false);
  const [detail, setDetail] = useState("");
  const armedRef = useRef(false);
  armedRef.current = armed;
  const inFlight = useRef(false);
  const pushHooked = useRef(false);

  const client = options.deviceClient;

  const run = useCallback(
    async (command: Parameters<DeviceClient["laser"]>[0]): Promise<string | null> => {
      const live = client();
      if (live === null) return "no helper is attached — pair this tab first (pnpm mcp:serve)";
      if (!pushHooked.current) {
        pushHooked.current = true;
        live.onLaserState((said) => {
          setDetail(said);
          // The dead-man or a device e-stop disarms the SESSION too: light does not
          // come back until a person re-arms, which is the whole point of the gesture.
          if (said.includes("e-stop") || said.includes("dead-man") || said.includes("estopped")) {
            setArmed(false);
          }
        });
      }
      try {
        const outcome = await live.laser(command);
        setReport(outcome.state);
        return outcome.ok ? null : outcome.reason;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
    [client],
  );

  const estopRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    const bus = options.bus;
    if (bus === undefined || bus.hasCommand("laser.estop")) return;
    bus.registerCommand({
      name: "laser.estop",
      description:
        "EMERGENCY STOP the laser output: blank, stop, e-stop the DAC and disarm this session. Safe to fire at any time; does nothing when no laser is connected.",
      handler: () => {
        void estopRef.current();
        return { status: "applied", output: { fired: true }, diagnostics: [] };
      },
    });
  }, [options.bus]);

  const session = useMemo<LaserSessionSurface>(
    () => ({
      report,
      armed,
      detail,
      async connect(host, maxPps) {
        return run({ kind: "connect", host, ...(maxPps > 0 ? { maxPps } : {}) });
      },
      async arm() {
        const refusal = await run({ kind: "arm" });
        if (refusal === null) setArmed(true);
        return refusal;
      },
      async disarm() {
        setArmed(false);
        await run({ kind: "disarm" });
      },
      async estop() {
        setArmed(false);
        await run({ kind: "estop" });
      },
      async clearEstop() {
        return run({ kind: "clearEstop" });
      },
    }),
    [armed, detail, report, run],
  );
  estopRef.current = session.estop;

  const sync = useCallback(
    (
      graph: GraphDocument,
      registry: NodeRegistryView,
      policy: SideEffectPolicy,
      pointRate = 30000,
      passes: ReadonlyArray<PassDescriptor> = [],
    ) => {
      const types = new Set(laserPumpNodeTypes());
      const next: RuntimeDiagnostic[] = [];
      for (const nodeId of Object.keys(graph.nodes).sort()) {
        const node = graph.nodes[nodeId];
        if (node === undefined || !types.has(node.type)) continue;
        const definition = registry.get(node.type);
        const refusal = emissionRefusal(definition, policy);
        if (refusal !== null) {
          // §V365: the refusal reaches a surface — a rig dark with no explanation
          // reads as a rig that is broken.
          next.push({ severity: "info", code: "laser.emission.blocked", message: refusal, nodeId });
          continue;
        }
        if (client() === null) {
          next.push({
            severity: "info",
            code: "laser.helper.absent",
            message:
              "Laser Out needs the local helper (pnpm mcp:serve) — a page cannot open TCP. Pair this tab in the Connections section and connect from the node's Laser section.",
            nodeId,
          });
          continue;
        }
        if (!armedRef.current) {
          next.push({
            severity: "info",
            code: "laser.disarmed",
            message:
              "Laser Out is DISARMED — nothing is transmitted. Arming is a deliberate action in the node's Laser section, once per session, never saved with the document (G1).",
            nodeId,
          });
          continue;
        }
        // ARMED AND LIVE: this frame's planned stream goes out. One laser session per
        // tab (the device itself is single-host), so the first armed target streams.
        const source = laserSourceOf(graph, nodeId as NodeId);
        const backend = options.backend?.() ?? null;
        const stream = source === null ? null : laserStreamRegions(passes, source);
        if (source === null || backend === null || stream === null) {
          next.push({
            severity: "warning",
            code: "laser.source.missing",
            message:
              source === null
                ? "Laser Out has no planned stream — wire a Laser Path node into its Samples input."
                : backend === null
                  ? "No live backend to read the planned stream from."
                  : "The wired Laser Path emitted no plan this compile — check its diagnostics.",
            nodeId,
          });
          continue;
        }
        if (!inFlight.current) {
          inFlight.current = true;
          void (async () => {
            try {
              /* T1076: ONE readback. `position` and `tint` are regions of the planner's
                 packed buffer, sliced at the offsets the plan named — the bytes are the
                 bytes the two separate buffers held, so the decoder is unchanged. */
              const packed = await backend.readBuffer(stream.resourceId);
              const samples = samplesFromBuffers(
                new Float32Array(packed, stream.position.offset, stream.position.bytes / 4),
                new Float32Array(packed, stream.tint.offset, stream.tint.bytes / 4),
              );
              if (samples.length > 0) await run({ kind: "stream", samples, pointRate });
            } catch {
              // A readback refusal (outside-frame, halted) skips the frame; the DAC
              // plays the previous block's blanked tail — darkness, not garbage (G3).
            } finally {
              inFlight.current = false;
            }
          })();
        }
        next.push({
          severity: "info",
          code: "laser.armed",
          message: "Laser Out is ARMED and streaming the planned samples to the DAC.",
          nodeId,
        });
      }
      setDiagnostics((prior) => {
        if (
          prior.length === next.length &&
          prior.every((entry, at) => entry.code === next[at]?.code && entry.nodeId === next[at]?.nodeId)
        ) {
          return prior;
        }
        return next;
      });
    },
    [client, options, run],
  );

  return { diagnostics, session, sync };
}
