import { createDeviceHub, nodeUdpSocketFactory, type DeviceHub, type UdpSocketFactory } from "./device-hub.ts";
import { createLaserHost, nodeLaserDiscovery, nodeTcpSocketFactory, type LaserHost } from "./laser-host.ts";
import { createVisionHost, nodeVisionStart, type VisionHost } from "./vision-host.ts";

/**
 * THE THREE THINGS A PAGE CANNOT DO, BUILT IN ONE PLACE (T1111, extracted from `serve.ts`).
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
}

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
  return {
    devices,
    laser,
    vision,
    dispose() {
      // The bridge host disposes the laser and the vision worker with the DEVICE CLIENT
      // (that is G2's page-death path), and the hub when the whole bridge goes. This is the
      // no-bridge case — a helper shutting down — so it says so to all three.
      devices.dispose();
      laser.dispose();
      vision.dispose();
    },
  };
}
