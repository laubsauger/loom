// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { desktopShellPresent, hostOperatingSystem } from "./host-shell.ts";

/** jsdom's navigator is read-only; redefining the property is how a platform is faked. */
function claim(source: "userAgentData" | "platform", value: string | undefined) {
  if (source === "platform") {
    Object.defineProperty(navigator, "platform", { value, configurable: true });
    return;
  }
  Object.defineProperty(navigator, "userAgentData", {
    value: value === undefined ? undefined : { platform: value },
    configurable: true,
  });
}

afterEach(() => {
  claim("userAgentData", undefined);
  claim("platform", "");
  delete (window as Window & { loomDesktop?: unknown }).loomDesktop;
});

describe("T1340b — which shell", () => {
  it("reads the injected bridge object, not a user-agent string", () => {
    expect(desktopShellPresent()).toBe(false);
    (window as Window & { loomDesktop?: unknown }).loomDesktop = {};
    expect(desktopShellPresent()).toBe(true);
    // A UA that merely LOOKS like the desktop app changes nothing: the preload either put
    // the object there or it did not.
    delete (window as Window & { loomDesktop?: unknown }).loomDesktop;
    claim("platform", "Electron");
    expect(desktopShellPresent()).toBe(false);
  });
});

describe("T1340b — which machine, and when to admit we do not know", () => {
  it("reads a platform when the two sources agree", () => {
    claim("userAgentData", "macOS");
    claim("platform", "MacIntel");
    expect(hostOperatingSystem()).toBe("macos");
    claim("userAgentData", "Windows");
    claim("platform", "Win32");
    expect(hostOperatingSystem()).toBe("windows");
  });

  it("answers `unknown` when the two sources DISAGREE, which is a case that really happens", () => {
    /* ⚑ MEASURED, NOT IMAGINED: this repo's own Playwright Chromium reports
       `userAgentData.platform === "Windows"` on a Mac whose `navigator.platform` is
       "MacIntel". The first draft of this probe preferred `userAgentData` and therefore
       told a Mac user that a macOS requirement was UNMET — a confident wrong answer about
       their own machine, which is worse than either true sentence (§V986). */
    claim("userAgentData", "Windows");
    claim("platform", "MacIntel");
    expect(hostOperatingSystem()).toBe("unknown");
    claim("userAgentData", "macOS");
    claim("platform", "Win32");
    expect(hostOperatingSystem()).toBe("unknown");
  });

  it("uses whichever single source is readable, and says unknown when neither is", () => {
    claim("userAgentData", undefined);
    claim("platform", "MacIntel");
    expect(hostOperatingSystem()).toBe("macos");
    claim("userAgentData", "Windows");
    claim("platform", "");
    expect(hostOperatingSystem()).toBe("windows");
    claim("userAgentData", undefined);
    claim("platform", "");
    expect(hostOperatingSystem()).toBe("unknown");
  });

  it("calls a platform it read and did not recognise `other`, which is not `unknown`", () => {
    // Two different claims: "we read Linux" versus "we could not read anything". A macOS
    // requirement is definitively unmet on the first and unverifiable on the second.
    claim("userAgentData", "Linux");
    claim("platform", "Linux x86_64");
    expect(hostOperatingSystem()).toBe("other");
  });
});
