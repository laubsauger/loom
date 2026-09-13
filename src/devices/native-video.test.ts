// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { desktopInputBridge } from "./native-input.ts";
import { desktopOutputBridge } from "./native-output.ts";
import { NATIVE_INPUT_TRANSPORTS, NATIVE_OUTPUT_TRANSPORTS } from "./native-video.ts";
import { EMISSION_PUMPS } from "@domain/render/emission-pumps.ts";

afterEach(() => vi.unstubAllGlobals());
it("Spout never substitutes the available Syphon or NDI bridges", () => {
  const desktop = { input: {}, ndiInput: {}, nativeOutput: true, ndiOutput: {} };
  vi.stubGlobal("loomDesktop", desktop);
  expect(desktopInputBridge("spout")).toBeUndefined();
  expect(desktopOutputBridge("spout")).toBeUndefined();
  expect(desktopInputBridge("syphon")).toBe(desktop.input);
  expect(desktopOutputBridge("syphon")).toBe(desktop);
  expect(desktopInputBridge("ndi")).toBe(desktop.ndiInput);
  expect(desktopOutputBridge("ndi")).toBe(desktop.ndiOutput);
});
it("routes only to dedicated injected Spout capabilities", () => {
  const desktop = { spoutInput: {}, spoutOutput: {} };
  vi.stubGlobal("loomDesktop", desktop);
  expect(desktopInputBridge("spout")).toBe(desktop.spoutInput);
  expect(desktopOutputBridge("spout")).toBe(desktop.spoutOutput);
});
it("routes every output owned by the native pump explicitly", () => {
  expect(Object.keys(NATIVE_OUTPUT_TRANSPORTS).sort()).toEqual(Object.entries(EMISSION_PUMPS)
    .filter(([, path]) => path === "src/app/use-native-outputs.ts").map(([type]) => type).sort());
  expect(NATIVE_INPUT_TRANSPORTS["spoutIn"]).toBe("spout");
  expect(NATIVE_OUTPUT_TRANSPORTS["spoutOut"]).toBe("spout");
});
