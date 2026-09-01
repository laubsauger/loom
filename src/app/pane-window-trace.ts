/**
 * What a POPPED-OUT window can say about its own mount (T774).
 *
 * ## Why this exists on top of T739's probe
 *
 * T739 made the floated viewer's CANVAS report itself, and that was the right instrument
 * for the fault it was chasing: three suspects (an inert cross-document context, a 1×1
 * backing store, the wrong canvas) that all assume A RENDERED DOCUMENT WITH A BLANK CANVAS
 * IN IT. The owner's re-report does not describe that. It describes "an empty about blank
 * screen with nothing" — no pane chrome, no app background. That is a MOUNT failure, not a
 * paint failure, and T739's probe cannot see it, because the probe logs from the mounted
 * pane: if the mount is what failed, THE INSTRUMENT NEVER RUNS.
 *
 * So an absent `viewer[floated]:` line currently means any of four different things — a
 * stale tab predating the fix, a failed mount, an instrument that did not ship, or a
 * healthy float that has not ticked yet. **Removing that ambiguity is what this module is
 * for.** Silence has to become a specific gap rather than a shrug.
 *
 * ## The three things that makes true
 *
 *  1. **Log at MOUNT time, not only on a tick.** The whole sequence is traceable:
 *     `requested` → `opened` → `prepared` → `adopted` → `child-frame`, each a line, so the
 *     LAST line printed names the step that did not complete.
 *  2. **Log from the CHILD's own console as well as the parent's.** If the child is sitting
 *     at `about:blank` with nothing in it, its console is the only place that can say so,
 *     and it is a window the owner can open devtools on.
 *  3. **Make the child REPORT BACK.** The parent asks the child realm for one
 *     `requestAnimationFrame`. A window that is not rendering never fires one — so
 *     `child-frame` arriving is positive proof the child document is alive and painting,
 *     and `child-silent` after the deadline is positive proof it is not. Neither is
 *     inferrable from the parent alone.
 *
 * ## What this still cannot do
 *
 * Nothing here confirms a PICTURE. There is no WebGPU in this project's browser
 * environment and no DOM in Dawn (T739, T705), so no gate anywhere can assert that a
 * popped-out canvas paints. This module asserts the layer BELOW that — document, styles,
 * box, frames — which is exactly the layer the owner's new wording moved the suspicion to.
 */

/** Where in the float sequence a line was emitted. The last one printed is the answer. */
export type FloatStage =
  /** The parent is about to call the opener. Printed BEFORE anything can fail. */
  | "requested"
  /** The opener returned null — popup blocked. A handled state, and the pane docks back. */
  | "blocked"
  /** A window came back and its document is readable. */
  | "opened"
  /** Styles copied, body classed, this mount's root div appended. */
  | "prepared"
  /** The pane's permanent host was moved into that root — the content is now in the child. */
  | "adopted"
  /** The CHILD rendered a frame and said so. Proof the child document is alive. */
  | "child-frame"
  /** The deadline passed with no frame from the child. Proof it is not. */
  | "child-silent"
  /** The periodic re-read, so a mount that dies LATER is not silent either. */
  | "alive"
  /** This mount is letting go of the window. */
  | "closing";

/**
 * What the reading MEANS, ordered by how early in the chain the thing failed.
 *
 * §V731: the payload is the verdict, not the fields — a reader handed only fields picks
 * whichever story they arrived with, and verdicts must carry PRECEDENCE so the earliest
 * structural failure wins. A document that was replaced has nothing useful to say about
 * its box, and a child with no stylesheet has an explanation for its collapsed box that
 * `no-box` alone would send the reader straight past.
 */
export type FloatVerdict =
  /** No window at all: the opener returned null. */
  | "blocked"
  /** The window is there and its document cannot be read — closed, or cross-origin. */
  | "no-document"
  /**
   * T774's fourth suspect, caught red-handed: the window's CURRENT document is not the
   * one this mount wrote into. Everything was appended to a document the browser then
   * threw away, which is precisely "an empty about:blank with nothing in it".
   */
  | "document-replaced"
  /** The document is ours and this mount's root div is no longer in it. */
  | "root-detached"
  /** The root is there and the pane's host is not inside it — the adoption never landed. */
  | "host-missing"
  /**
   * More than one mount's root div is in the child body. Both are `height: 100%` children
   * of a `100vh`, `overflow: hidden` body, so the EMPTY one fills the window and clips the
   * live one out of sight: a window showing nothing with the pane mounted perfectly inside
   * it. Fixed in the same commit as this verdict — so seeing it means a stale bundle, or
   * that the orphan cleanup regressed.
   */
  | "roots-stacked"
  /**
   * Everything is mounted and the child's body computes to a TRANSPARENT background, so
   * the cloned stylesheets did not apply (or their tokens did not come with them). The
   * app is in the window and looks like a blank page — the "white empty screen" reading.
   */
  | "unstyled"
  /** Mounted and styled, and the root has no laid-out box in the child window. */
  | "no-box"
  /** Mounted, and too early to say whether the child renders. Not yet a fault. */
  | "awaiting-frame"
  /** Mounted, laid out, and the child window has never rendered a frame. */
  | "not-rendering"
  /** Mounted, and this realm cannot be asked for frames (a test fake with no window). */
  | "mounted-unverified"
  /** Present, styled, sized and rendering. If the owner still sees nothing, the fault is
   *  inside the pane's own content — which is where T739's probe takes over. */
  | "mounted";

export interface ChildMountInput {
  /** The window handle this mount holds. Null before it is opened, or when blocked. */
  readonly child: { readonly document: Document } | null;
  /** The document THIS mount prepared and appended its root into. */
  readonly prepared: Document | null;
  /** The root div this mount created inside `prepared`. */
  readonly root: HTMLElement | null;
  /** The pane's permanent host — the one element that travels with the content (§V96). */
  readonly host: HTMLElement | null;
  /**
   * Frames the CHILD realm has reported rendering, or null when there is no realm to ask.
   * Null is reported as unknown and never folded into 0 (§V469): "I could not ask" and
   * "I asked and it never rendered" are the two answers this instrument exists to keep
   * apart, exactly as T739 kept "unreadable" apart from "black".
   */
  readonly childFrames: number | null;
  /** Milliseconds since the float was requested, so "not yet" is not reported as "never". */
  readonly ageMs: number;
}

export interface ChildMountReading {
  readonly documentUrl: string | null;
  readonly readyState: string | null;
  /** Whether the prepared document still belongs to a window. */
  readonly hasRealm: boolean;
  /** Whether the window's current document is still the one we prepared. */
  readonly documentCurrent: boolean;
  readonly headNodes: number;
  readonly bodyChildren: number;
  readonly rootConnected: boolean;
  readonly hostInRoot: boolean;
  readonly rootWidth: number;
  readonly rootHeight: number;
  /** The child body's COMPUTED background, or null when there is no realm to compute in. */
  readonly bodyBackground: string | null;
  /** Canvases present in the child document — 0 while a viewer has no output yet. */
  readonly canvases: number;
  /** Root divs in the child body. Must be exactly 1: see `roots-stacked`. */
  readonly paneRoots: number;
  readonly childFrames: number | null;
  readonly ageMs: number;
  readonly verdict: FloatVerdict;
}

/**
 * A background that paints nothing. The child body carries `--bg-void` once styles land.
 *
 * Reads the ALPHA out of the computed value rather than matching a colour string: §V17
 * keeps colour literals out of source, and a literal here would also be wrong — an opaque
 * black and a transparent one carry the SAME three channel numbers and opposite answers,
 * so only an explicit fourth component reading zero decides it. Three-component form is
 * always opaque.
 */
function isTransparent(background: string): boolean {
  const value = background.trim().toLowerCase();
  if (value === "" || value === "transparent") return true;
  const inside = /^rgba?\(([^)]*)\)$/.exec(value)?.[1];
  if (inside === undefined) return false;
  const parts = inside.split(",").map((part) => part.trim());
  return parts.length === 4 && Number(parts[3]) === 0;
}

/**
 * How long the child gets to render its first frame before silence counts as a fault.
 *
 * A popup that opens behind the parent, or on a background display, can be throttled hard
 * by the browser, so this is generous on purpose — a false `not-rendering` would send the
 * reader at the window machinery when the window is merely slow.
 */
export const CHILD_FRAME_DEADLINE_MS = 2000;

export function readChildMount(input: ChildMountInput): ChildMountReading {
  const { child, prepared, root, host, childFrames, ageMs } = input;

  // A closed or cross-origin window throws on the property ACCESS itself, so the read is
  // guarded rather than the comparison.
  const current = ((): Document | null => {
    try {
      return child?.document ?? null;
    } catch {
      return null;
    }
  })();

  const view = prepared?.defaultView ?? null;
  const bodyBackground =
    view !== null && prepared !== null && prepared.body !== null
      ? view.getComputedStyle(prepared.body).backgroundColor
      : null;

  const base = {
    documentUrl: prepared?.URL ?? null,
    readyState: prepared?.readyState ?? null,
    hasRealm: view !== null,
    documentCurrent: prepared !== null && current === prepared,
    headNodes: prepared?.head.childElementCount ?? 0,
    bodyChildren: prepared?.body?.childElementCount ?? 0,
    rootConnected: root !== null && root.isConnected,
    hostInRoot: root !== null && host !== null && root.contains(host),
    rootWidth: root?.clientWidth ?? 0,
    rootHeight: root?.clientHeight ?? 0,
    bodyBackground,
    canvases: prepared?.querySelectorAll("canvas").length ?? 0,
    paneRoots: prepared?.querySelectorAll("[data-pane-window-root]").length ?? 0,
    childFrames,
    ageMs,
  };

  return { ...base, verdict: verdictOf(base, child, prepared) };
}

function verdictOf(
  reading: Omit<ChildMountReading, "verdict">,
  child: ChildMountInput["child"],
  prepared: Document | null,
): FloatVerdict {
  if (child === null) return "blocked";
  if (prepared === null) return "no-document";
  if (!reading.documentCurrent) return "document-replaced";
  if (!reading.rootConnected) return "root-detached";
  if (!reading.hostInRoot) return "host-missing";
  // Before styling and before the box: a second root is a complete explanation for a
  // window that shows nothing, and a reader given only `no-box` would never find it.
  if (reading.paneRoots > 1) return "roots-stacked";
  // Before the box, deliberately: missing stylesheets are a CAUSE of a collapsed box, and
  // a reader told only `no-box` goes looking at layout rather than at the copied styles.
  if (reading.bodyBackground !== null && isTransparent(reading.bodyBackground)) return "unstyled";
  if (reading.rootWidth === 0 || reading.rootHeight === 0) return "no-box";
  // No realm means no `requestAnimationFrame` to ask. Say that, rather than claiming a
  // health the instrument did not measure.
  if (reading.childFrames === null) return "mounted-unverified";
  if (reading.childFrames === 0) {
    return reading.ageMs < CHILD_FRAME_DEADLINE_MS ? "awaiting-frame" : "not-rendering";
  }
  return "mounted";
}

/** One line, in the shape of the boot stamp and T739's probe: prefix, facts, verdict. */
export function formatChildMount(
  paneId: string,
  stage: FloatStage,
  reading: ChildMountReading,
): string {
  const facts = [
    `url=${reading.documentUrl ?? "none"}`,
    `ready=${reading.readyState ?? "none"}`,
    `realm=${reading.hasRealm ? "yes" : "none"}`,
    `doc=${reading.documentCurrent ? "ours" : "replaced"}`,
    `head=${reading.headNodes}`,
    `body=${reading.bodyChildren}`,
    `root=${reading.rootConnected ? `${reading.rootWidth}x${reading.rootHeight}` : "detached"}`,
    `host=${reading.hostInRoot ? "in" : "missing"}`,
    `bg=${reading.bodyBackground === null ? "unknown" : reading.bodyBackground.replace(/\s+/g, "")}`,
    `canvas=${reading.canvases}`,
    `roots=${reading.paneRoots}`,
    `frames=${reading.childFrames === null ? "unavailable" : reading.childFrames}`,
    `age=${Math.round(reading.ageMs)}ms`,
  ].join(" ");
  return `float[${paneId}] ${stage}: ${facts} -> ${reading.verdict}`;
}

/** A line with no reading behind it yet — `requested` and `blocked` happen before there is
 *  anything to read, and they still have to print, because they are the two lines that
 *  turn "no output at all" into "the opener was never reached" vs "the popup was blocked". */
export function formatFloatNote(paneId: string, stage: FloatStage, note: string): string {
  return `float[${paneId}] ${stage}: ${note}`;
}

/** Structural on purpose: a child window is another realm, and the only thing wanted from
 *  it here is its console — which is also all a test fake has to provide. */
export interface FloatConsoleTarget {
  readonly console: Pick<Console, "info">;
}

/**
 * Prints one line to the PARENT console and, when there is one, to the CHILD's own.
 *
 * Both, not either. The parent's console is the devtools the owner already has open and
 * where the boot stamp lands; the child's is the only console that can speak for a window
 * the parent believes is fine. When the two disagree, that disagreement IS the finding.
 */
export function emitFloatLine(line: string, childView: FloatConsoleTarget | null): void {
  console.info(line);
  if (childView === null || childView === (globalThis as unknown as FloatConsoleTarget)) return;
  try {
    childView.console.info(line);
  } catch {
    // A window that closed between the read and the write. The parent line still landed.
  }
}
