import { createDeviceHub, nodeUdpSocketFactory, type DeviceHub, type UdpSocketFactory } from "./device-hub.ts";
import { createLaserHost, nodeLaserDiscovery, nodeTcpSocketFactory, type LaserHost } from "./laser-host.ts";
import { createVisionHost, nodeVisionStart, type VisionHost } from "./vision-host.ts";
import { createTerminalHost, type TerminalHost, type TerminalHostOptions } from "./terminal-host.ts";

/**
 * THE THINGS A PAGE CANNOT DO, BUILT IN ONE PLACE (T1111, extracted from `serve.ts`;
 * T1263 added the fourth, the opt-in terminal door).
 *
 * ## Why this exists
 *
 * A UDP socket, a TCP connection to a laser DAC and a spawned Apple Vision worker: three
 * doors, each with the same posture and each previously constructed inline in
 * `createHeadlessMcpServer`. T1111 added a SECOND entry point — the devices-only helper —
 * and two call sites building three hosts each is how a fourth door lands in one of them and
 * not the other. This is the one construction; both entry points call it.
 *
 * ## The posture, which is the same for all three
 *
 * **Nothing binds, dials or spawns on construction.** A UDP socket opens when an attached
 * page names a port; a TCP connection opens when a page names a host and the vet passes; the
 * Swift worker compiles and spawns when a page asks for its first mask. A running helper is
 * not a listening OSC server, is not connected to a DAC, and is not holding a camera —
 * until somebody says so. That is the same "nothing dials on load" consent the page
 * attachment has, and it is why starting this process is cheap and safe.
 *
 * ## Every OS call is a parameter with a real default
 *
 * `socketFactory`, the laser's sockets/discovery/clock and the vision worker's `start` are
 * injectable for the same reason: a gate cannot make a phone send OSC or a DAC answer, and a
 * suite that binds real ports is a suite that depends on the machine. The defaults here ARE
 * the real thing, so the product path is the untested-injection-free one.
 */
export interface DeviceDoors {
  readonly devices: DeviceHub;
  readonly laser: LaserHost;
  readonly vision: VisionHost;
  /**
   * T1263 — the FOURTH door, and the only one that is NULL by default.
   *
   * A shell as the user is not a UDP socket: it is built only when the host said so
   * (`terminal.enabled`), and its absence is what the bridge turns into a refusal BY
   * NAME of the `terminal` role — the same shape `headless`'s absence has for the agent
   * roles (§T1111). The browser product's flag→enabled mapping lives in `serve.ts`; a
   * desktop host opens the same door with `openTerminalDoor()` and no flag at all.
   */
  readonly terminal: TerminalHost | null;
  dispose(): void;
}

export interface DeviceDoorOptions {
  /** How the DEVICE role opens UDP sockets. Injected ONLY by tests (T942 tier 3). */
  readonly udpSocketFactory?: UdpSocketFactory;
  /** How often coalesced OSC readings are pushed. Injectable so a gate flushes on demand. */
  readonly deviceFlushMs?: number;
  /** Host clock for device timestamps. Injectable so a gate asserts an exact `at`. */
  readonly deviceNow?: () => number;
  /**
   * T950 — the laser door. Defaults to the REAL one (node TCP + UDP discovery + wall clock
   * for the dead-man); injectable so the emulator-backed test drives the whole message path
   * with no network and no timers of its own.
   */
  readonly laser?: LaserHost;
  /** T1029 — the vision door. Defaults to the REAL one (swiftc-compiled worker). */
  readonly vision?: VisionHost;
  /**
   * T1263 — the terminal door. ABSENT or `enabled: false` builds none, and that is the
   * default: nothing here decides to hand out a shell. `enabled: true` opens it with the
   * real `node-pty` unless a gate injects `spawn`.
   */
  readonly terminal?: TerminalDoorOptions;
}

export interface TerminalDoorOptions extends TerminalHostOptions {
  readonly enabled: boolean;
}

/**
 * The terminal door on its own (T1263), for a host that is not `serve.ts`.
 *
 * Host-agnostic on purpose: the Electron main process (§T1244) opens this without any
 * flag, because there the person who launched the app IS the person who owns the
 * machine's session and the owner asked for that to be automatic. The door's contract —
 * `open` refuses non-loopback origins, one pty per pane, `dispose` kills all — is the
 * same whichever host builds it.
 *
 * It IS `createTerminalHost` under the name a host reaches for, not a wrapper around it:
 * a second function here would be a factory no product entry point calls (the
 * composition-seams gate, §V205), and there is nothing for it to add.
 */
export { createTerminalHost as openTerminalDoor };

export function createDeviceDoors(options: DeviceDoorOptions = {}): DeviceDoors {
  const devices = createDeviceHub({
    socketFactory: options.udpSocketFactory ?? nodeUdpSocketFactory(),
    ...(options.deviceFlushMs === undefined ? {} : { flushMs: options.deviceFlushMs }),
    ...(options.deviceNow === undefined ? {} : { now: options.deviceNow }),
  });
  const laser =
    options.laser ??
    createLaserHost({
      sockets: nodeTcpSocketFactory(),
      discovery: nodeLaserDiscovery(),
      clock: {
        now: () => Date.now(),
        every: (ms, tick) => {
          const handle = setInterval(tick, ms);
          return () => clearInterval(handle);
        },
      },
    });
  const vision = options.vision ?? createVisionHost({ start: nodeVisionStart() });
  const terminal =
    options.terminal?.enabled === true
      ? createTerminalHost((({ enabled: _enabled, ...rest }) => rest)(options.terminal))
      : null;
  return {
    devices,
    laser,
    vision,
    terminal,
    dispose() {
      // The bridge host disposes the laser and the vision worker with the DEVICE CLIENT
      // (that is G2's page-death path), and the hub when the whole bridge goes. This is the
      // no-bridge case — a helper shutting down — so it says so to all four: every shell
      // dies with the helper (T1263).
      devices.dispose();
      laser.dispose();
      vision.dispose();
      terminal?.dispose();
    },
  };
}
