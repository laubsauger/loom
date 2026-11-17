import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";

/**
 * T1555b — THE PROBLEMS SURFACE IS A REGISTRY OF SOURCES.
 *
 * `app.tsx` used to concatenate about twenty diagnostic sources by hand, and `clearProblems`
 * separately named the seven that accumulate, so a new source had to join two lists and the
 * headless twin (`mcp/serve.ts`) answered `diagnostics.get` from the compile alone: an agent
 * saw fewer problems than the person did. Now each source is ONE registration, both
 * composition roots read the list through the two functions below, and
 * `problem-sources.test.ts` fails on a hook that hands the app diagnostics without one.
 *
 * No React here: `mcp/serve.ts` runs in Node and reads the same functions.
 */
export interface ProblemSource {
  /** A stable name for the source: what the gate and the headless parity table call it. */
  readonly id: string;
  /**
   * The source's diagnostics now. Called on every read, so it hands back what the source
   * already holds and does not build a fresh array per call: the app reuses its list for
   * as long as every source returns the same array it returned last time.
   */
  readonly read: () => readonly RuntimeDiagnostic[];
  /**
   * Present on ACCUMULATING sources only (T465): empties what the source has retained.
   * Anything still true reports again on its own, which proves it is live. A derived source
   * has nothing to clear, because it is rebuilt from the current state on every read.
   */
  readonly clear?: () => void;
}

/** Every source's diagnostics, concatenated in registration order. */
export function readProblemSources(sources: readonly ProblemSource[]): RuntimeDiagnostic[] {
  return sources.flatMap((source) => source.read());
}

/** The Problems pane's Clear (T465): empties every accumulating source, and touches nothing else. */
export function clearProblemSources(sources: readonly ProblemSource[]): void {
  for (const source of sources) source.clear?.();
}

/**
 * The app's sources that the headless server (`mcp/serve.ts`) cannot have, and why.
 *
 * Every id the app registers is either registered by the headless server too or named here,
 * and nothing is both. `problem-sources.test.ts` checks this in both directions, so a new
 * app source makes the author decide what the headless server should say about it.
 */
export const HEADLESS_ABSENT_PROBLEM_SOURCES: Readonly<Record<string, string>> = {
  harmonyAudio: "generated audio playback uses the browser's shared AudioContext; headless graph evaluation is silent.",
  valueGraph:
    "no value graph runs headless. A channel reference that cannot resolve is reported by the compile instead (`parameter.channels.unavailable`).",
  media:
    "media playback lives in the browser's media elements and the tab's file store, and this process has neither.",
  fileReferences: "the files a document refers to live in a browser tab's file store, and this process holds none.",
  floatMaps: "prepared numerical files load from the browser's retained file handles; headless callers supply explicit numerical media sources instead.",
  screenCapture: "screen capture is `getDisplayMedia`, a browser API.",
  meshes: "mesh imports load from a browser tab's file store, and this process holds none.",
  nativeInputs:
    "native video inputs (Syphon, NDI, Spout) are opened through the desktop shell's bridge in a page, and this process opens none.",
  phoneCameras: "phone cameras arrive over a page's device client and phone door, and a headless session has none.",
  nativeOutputs:
    "native video outputs (Syphon, NDI, Spout) are opened through the desktop shell's bridge in a page, and this process opens none.",
  requirements:
    "the host facts a node's requirements are checked against (browser or desktop, helper reachable) are a page's facts (`pageHostFacts`), and this process has no such model.",
  osc: "the OSC session belongs to the page's bridge hook. This process only hosts the door that page dials.",
  laser: "the laser session belongs to the page's bridge hook. This process only hosts the door that page dials.",
  vision: "the Vision session belongs to the page's bridge hook. This process only hosts the door that page dials.",
  rejection:
    "a refused GESTURE has nowhere else to show. An agent's refused command already returns its diagnostics in the tool result.",
  autosave: "the autosave snapshot ring is IndexedDB in a browser tab.",
  project: "this server registers no project.save or project.open (the T597 waiver), so it has no save or open to report on.",
  frameLoop: "there is no frame loop. This server renders one offline frame per change, and the backend reports a failed one.",
  componentEditing: "there is no component editor in this process.",
  renderRange: "render-range takes are recorded in a browser tab (WebCodecs and a file handle), and this server records none.",
};
