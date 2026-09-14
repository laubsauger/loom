/**
 * T1340b — WHAT SHELL AND WHAT MACHINE, as two probes rather than as guesses scattered
 * through the surfaces that ask.
 *
 * Both answers are deliberately narrow. The requirement vocabulary
 * (`@domain/types/requirements.ts`) has an explicit "cannot tell" verdict, and these
 * functions are what feed it: their job is to be HONEST about ignorance, not to produce
 * a value for every field.
 */

/**
 * Is this the Loom desktop app?
 *
 * PRESENCE OF THE INJECTED BRIDGE OBJECT, never a user-agent string — the same rule
 * `native-video.ts` states for transports one level down. A preload either put
 * `loomDesktop` on the window or it did not, which is a fact; "this looks like Electron"
 * is a pattern match on a string a browser is free to change.
 */
export function desktopShellPresent(): boolean {
  return (window as Window & { loomDesktop?: unknown }).loomDesktop !== undefined;
}

export type HostOperatingSystem = "macos" | "windows" | "other" | "unknown";

function classify(reported: unknown): HostOperatingSystem | null {
  if (typeof reported !== "string" || reported === "") return null;
  const lower = reported.toLowerCase();
  if (lower.includes("mac")) return "macos";
  if (lower.includes("win")) return "windows";
  return "other";
}

/**
 * Which operating system, or `unknown`.
 *
 * ⚠ `unknown` IS A REAL RETURN VALUE AND MUST STAY ONE. `navigator.userAgentData` is
 * Chromium-only and `navigator.platform` is deprecated and freezable; a browser that offers
 * a usable neither gets `unknown`, and the caller shows "cannot tell" rather than assuming
 * the majority. `other` is a POSITIVE finding — we read a platform and it was neither macOS
 * nor Windows — and is not the same claim.
 *
 * ⚑ THE TWO SOURCES ARE CROSS-CHECKED, AND THE DISAGREEING CASE IS REAL, NOT THEORETICAL.
 * Measured in this repo's own Playwright lane: Chromium there reports
 * `userAgentData.platform === "Windows"` while `navigator.platform === "MacIntel"`. Taking
 * either one on its own — the first draft preferred `userAgentData` — produced a confident
 * "you are on Windows" about a Mac, and put a macOS requirement in a user's face as UNMET
 * on the machine that meets it. A UA override, a privacy extension and a reduced-entropy
 * build all produce the same shape. When the two disagree the honest answer is that we do
 * not know, which is precisely what the third verdict is for (§V986).
 */
export function hostOperatingSystem(): HostOperatingSystem {
  const data = (navigator as Navigator & { userAgentData?: { platform?: unknown } }).userAgentData;
  const hinted = classify(data?.platform);
  const legacy = classify(navigator.platform);
  if (hinted === null) return legacy ?? "unknown";
  if (legacy === null) return hinted;
  return hinted === legacy ? hinted : "unknown";
}
