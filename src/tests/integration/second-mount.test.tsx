// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import type { BackendCapabilities } from "@domain/types/backend.ts";
import { App } from "../../app/app.tsx";
import { createAppRuntime } from "../../app/app-runtime.ts";
import type { AppRuntime } from "../../app/app-runtime.ts";
import type { GpuStatus } from "../../app/gpu-status.ts";

/**
 * T531 (§V467) — A SECOND MOUNT ON ONE BUS MUST NOT TAKE THE APP DOWN.
 *
 * `registerCommand` THROWS on a duplicate name. Three modules had reached for a
 * PER-COMPONENT-INSTANCE guard — `useRef(new Set<ShaderloomBus>())` — which knows only
 * what THIS instance did, so a second App on the same bus sails straight past it and the
 * throw kills the mount. `useRuntimeCommands` was the live one (B108 named the webmcp
 * site; T493 sidestepped this one by using `bus.hasCommand` for its own `media.*`
 * commands rather than fixing it).
 *
 * ## Why this is a PROPERTY test and not a test of `runtime.resetFeedback`
 *
 * A test that mounted `useRuntimeCommands` twice would have gone green the moment that
 * one hook was fixed, and said nothing about the next module to reach for a ref — which
 * is exactly how three sites accumulated. So the subject here is the WHOLE composition
 * root: every command any part of the app registers, gated at once. A module added
 * tomorrow with an instance-scoped guard reddens this file on the day it lands, without
 * anyone adding a case.
 *
 * ## Why the assertion is the command SET, not "it did not throw"
 *
 * "Did not throw" would also pass on an app that silently registered nothing the second
 * time and left half its commands dead. So the set of command names after the second
 * mount is compared to the set after the first, exactly — same commands, none lost, none
 * duplicated — and a non-empty count is asserted first so the comparison cannot be two
 * empty sets agreeing with each other.
 */

beforeAll(() => {
  installDomStubs();
  installFlowStubs();
});
afterEach(cleanup);

const CAPABILITIES: BackendCapabilities = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
};

/** WebGPU present, so the runtime-side registrars (`runtime.*`) actually run. */
const READY: GpuStatus = { kind: "ready", capabilities: CAPABILITIES, baseline: true };

function newRuntime(): AppRuntime {
  return createAppRuntime({
    identityStorage: null,
    actor: { kind: "human", id: "tester", label: "Tester" },
  });
}

async function mountOn(runtime: AppRuntime, status: GpuStatus): Promise<void> {
  const probe = () => Promise.resolve(status);
  await act(async () => {
    render(<App runtime={runtime} storage={createMemoryStorage()} gpuProbe={probe} />);
  });
}

const commandNames = (runtime: AppRuntime): readonly string[] => [...runtime.bus.listCommands()].sort();

describe("T531 — two App mounts share one bus without a duplicate-registration throw", () => {
  for (const [label, status] of [
    ["with no WebGPU", { kind: "unavailable", reason: "no WebGPU here" } as GpuStatus],
    ["with a backend", READY],
  ] as const) {
    it(`${label}: the second mount registers the same command set, and does not throw`, async () => {
      const runtime = newRuntime();

      await mountOn(runtime, status);
      const first = commandNames(runtime);
      // Not two empty sets agreeing: the app really did register a catalogue of commands.
      expect(first.length).toBeGreaterThan(20);
      expect(new Set(first).size, "the FIRST mount already registered a name twice").toBe(first.length);

      // The line that used to throw `command "runtime.resetFeedback" is already
      // registered` and take the whole second mount down with it.
      await mountOn(runtime, status);

      expect(commandNames(runtime)).toEqual(first);
    });
  }

  it("a THIRD mount is the same again — the guard is a property of the bus, not a first-time flag", async () => {
    const runtime = newRuntime();
    await mountOn(runtime, READY);
    const first = commandNames(runtime);
    await mountOn(runtime, READY);
    await mountOn(runtime, READY);
    expect(commandNames(runtime)).toEqual(first);
  });
});
