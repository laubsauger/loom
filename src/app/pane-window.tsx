import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PaneKey } from "./pane-tree.ts";
import { adoptPaneHost, usePaneHosts } from "./pane-portal.tsx";
import {
  CHILD_FRAME_DEADLINE_MS,
  emitFloatLine,
  formatChildMount,
  formatFloatNote,
  readChildMount,
} from "./pane-window-trace.ts";
import type { ChildMountReading, FloatStage } from "./pane-window-trace.ts";
import styles from "./pane-window.module.css";

/**
 * A pane in its own window (T192, §V97).
 *
 * §V97: a floated pane shares ONE app state — same bus, same store, same runtime. That is
 * not a discipline this module has to enforce, it is a consequence of how it works: the
 * pane's content is never re-rendered anywhere. `PaneContent` keeps rendering it into the
 * pane's permanent container from its fixed position inside the ONE React tree, under the
 * ONE `AppRuntimeContext`; all this module does is move that container's DOM into the
 * child window's body. There is no second React root to give a second store to, and no
 * second runtime could be constructed here even by accident.
 *
 * ## Why this is the same infrastructure as multi-window perform mode (T110)
 *
 * A floated VIEWER has to keep showing pixels, so the window plumbing is designed around
 * the presentation seam rather than around text panes. §V64/§V70 already put the runtime
 * in charge: a surface is handed IN — `backend.present(canvas, { outputId })` — and a
 * compiled output supports N of them. Because the canvas element itself is never
 * remounted (T193), the presentation handle the viewer opened in the dock is still the
 * live one after the move, and the runtime keeps blitting into the same canvas while it
 * sits in another window. Nothing about the child window is presentation-specific, which
 * is what makes it reusable for a perform-mode output screen: open a window, adopt a
 * surface, let the runtime keep drawing.
 *
 * ## The window is structural
 *
 * `PaneWindow` is the narrow shape this module uses, not `Window` — the same reason
 * `PresentableCanvas` is structural. A test hands in a document; the browser hands in a
 * popup; neither knows about the other.
 */

export interface PaneWindow {
  readonly document: Document;
  addEventListener(type: "pagehide", listener: () => void): void;
  removeEventListener(type: "pagehide", listener: () => void): void;
  close(): void;
}

export interface OpenPaneWindowRequest {
  /** Stable per pane, so re-floating focuses the existing window rather than stacking. */
  readonly name: string;
  readonly title: string;
}

export type OpenPaneWindow = (request: OpenPaneWindowRequest) => PaneWindow | null;

/** The real thing. Returns null when the popup was blocked — a state, not a crash. */
export const openBrowserPaneWindow: OpenPaneWindow = ({ name, title }) => {
  if (typeof window === "undefined") return null;
  const child = window.open("", name, "popup=yes,width=760,height=560");
  if (child === null) return null;
  child.document.title = title;
  return child;
};

/**
 * Copies the app's styles into the child document.
 *
 * A popup opened with `about:blank` inherits nothing. Cloning the head's stylesheet nodes
 * covers both shapes the app ships in: `<style>` elements in dev (Vite injects them) and
 * `<link rel="stylesheet">` in a build. Tokens ride along with them, so §V17 holds in the
 * child window without a second theme definition existing anywhere.
 */
function copyStyles(from: Document, to: Document): void {
  for (const node of Array.from(from.head.children)) {
    if (node.tagName === "STYLE") {
      to.head.appendChild(node.cloneNode(true));
      continue;
    }
    if (node.tagName === "LINK" && node.getAttribute("rel") === "stylesheet") {
      to.head.appendChild(node.cloneNode(true));
    }
  }
}

/**
 * Who currently owns each window NAME (§V334, B51).
 *
 * The two decisions above are each correct and together were fatal. `window.open` REUSES
 * a window by name, which is what makes re-floating focus the existing window instead of
 * stacking a new one; the close below is DEFERRED so the dock can adopt the pane back in
 * the same commit. Under `StrictMode` (main.tsx) an effect runs mount → cleanup → mount,
 * so mount B is handed back the very window mount A opened — and cleanup A's queued close
 * then killed it. That was the flash-and-vanish.
 *
 * So a cleanup closes only while it still HOLDS the name. Not a `child.closed` check
 * (mount B's window is wide open — that is the problem) and not a timer (which only
 * changes which race is lost). Module level because the ownership outlives any one
 * component instance, which is exactly the thing being guarded.
 */
const windowOwners = new Map<string, symbol>();

export interface FloatingPaneProps {
  readonly paneId: PaneKey;
  readonly title: string;
  /** Called when the window goes away — by its own close button or by a blocked popup. */
  readonly onClose: (paneId: PaneKey) => void;
  /**
   * The window could not be opened at all.
   *
   * Docking the pane back is the right recovery, and on its own it is indistinguishable
   * from the click having done nothing — so whoever mounts this says WHY on screen.
   */
  readonly onBlocked?: (paneId: PaneKey) => void;
  readonly open?: OpenPaneWindow;
}

/** What this mount opened, kept so the trace below can re-read it long after mount. */
interface FloatMount {
  readonly child: PaneWindow;
  /** The document this mount wrote into — compared against the window's CURRENT one, which
   *  is the only way to catch T774's fourth suspect from the parent. */
  readonly prepared: Document;
  readonly requestedAt: number;
}

export function FloatingPane({ paneId, title, onClose, onBlocked, open }: FloatingPaneProps) {
  const registry = usePaneHosts();
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const blockedRef = useRef(onBlocked);
  blockedRef.current = onBlocked;
  const mountRef = useRef<FloatMount | null>(null);
  /** Frames the child realm reported. Null while there is no realm to ask (§V469). */
  const framesRef = useRef<number | null>(null);

  useEffect(() => {
    const opener = open ?? openBrowserPaneWindow;
    const name = `shaderloom-${paneId}`;
    /*
     * T774 — the sequence has to be traceable from BEFORE the first thing that can fail.
     * With this line, "no console output at all" stops meaning four different things and
     * starts meaning one: the float was never requested.
     */
    const requestedAt = performance.now();
    emitFloatLine(
      formatFloatNote(
        paneId,
        "requested",
        `name=${name} opener=${open === undefined ? "browser" : "injected"} title=${title}`,
      ),
      null,
    );
    const child = opener({ name, title: `${title} — Shaderloom` });
    if (child === null) {
      // A blocked popup must not leave the pane in limbo with nowhere to render — and
      // must not look like a button that does nothing either.
      emitFloatLine(
        formatFloatNote(paneId, "blocked", "the opener returned no window; docking the pane back"),
        null,
      );
      blockedRef.current?.(paneId);
      closeRef.current(paneId);
      return;
    }

    // Claim the name. Whatever mount claimed it before this one no longer owns it, so its
    // pending close becomes a no-op instead of landing on the window this mount now uses.
    const token = Symbol(name);
    windowOwners.set(name, token);

    const doc = child.document;
    const view = doc.defaultView;
    // A window REUSED by name still carries the previous mount's root. Worth naming: it
    // is the difference between "a fresh window came up empty" and "we are looking at a
    // window somebody else already prepared".
    const reused = doc.body?.querySelector("[data-pane-window-root]") !== null;
    emitFloatLine(
      formatFloatNote(
        paneId,
        "opened",
        `url=${doc.URL} ready=${doc.readyState} realm=${view === null ? "none" : "yes"} reused=${reused ? "yes" : "no"} console=${view === null ? "parent-only" : "child+parent"}`,
      ),
      view,
    );

    copyStyles(document, doc);
    doc.body.className = styles.body ?? "";
    const element = doc.createElement("div");
    element.className = styles.root ?? "";
    element.dataset["paneWindowRoot"] = paneId;
    doc.body.appendChild(element);
    mountRef.current = { child, prepared: doc, requestedAt };
    framesRef.current = null;
    setRoot(element);

    emitFloatLine(
      formatFloatNote(
        paneId,
        "prepared",
        `head=${doc.head.childElementCount} body=${doc.body.childElementCount} bodyClass=${doc.body.className || "none"} rootClass=${element.className || "none"}`,
      ),
      view,
    );

    const closed = () => closeRef.current(paneId);
    child.addEventListener("pagehide", closed);
    // A reload of the main window must not leave orphaned popups behind.
    const closeChild = () => child.close();
    window.addEventListener("pagehide", closeChild);

    return () => {
      child.removeEventListener("pagehide", closed);
      window.removeEventListener("pagehide", closeChild);
      // Named, because "the window opened and then went blank" and "a cleanup closed the
      // window this mount was using" (§V334, B51) look identical from the outside.
      emitFloatLine(
        formatFloatNote(paneId, "closing", `name=${name} owned=${windowOwners.get(name) === token}`),
        view,
      );
      if (mountRef.current?.child === child) mountRef.current = null;
      setRoot(null);
      /*
       * T774 — this mount's root must not outlive this mount.
       *
       * Found by the trace above, which printed `body=2` for the child document: under
       * StrictMode (main.tsx) an effect runs mount → cleanup → mount, and `window.open`
       * REUSES the window by NAME, so mount B appends a SECOND root beside mount A's and
       * nothing ever removed the first. Both are `height: 100%` children of a `100vh`,
       * `overflow: hidden` body (pane-window.module.css), so the EMPTY one fills the
       * window and clips the live one out of sight — a popped-out window showing nothing,
       * with the pane mounted perfectly inside it, and every canvas-level check passing.
       *
       * Deferred for exactly the reason the close below is: whoever adopts the pane next
       * does it in a LAYOUT effect in this same commit, which runs before any microtask.
       * By the time this runs the orphan is empty, and the emptiness check is what keeps
       * it from ever taking live content with it.
       */
      queueMicrotask(() => {
        if (element.childElementCount === 0) element.remove();
      });
      // Deferred on purpose: the dock's outlet adopts the pane back in a LAYOUT effect
      // later in this same commit, which runs before any microtask. Closing the window
      // synchronously here would tear the child document down underneath that move and
      // cost the pane its scroll position and focus.
      queueMicrotask(() => {
        // ...but by the time it runs, a newer mount may hold the name and be using this
        // very window (§V334). Close only what is still ours.
        if (windowOwners.get(name) !== token) return;
        windowOwners.delete(name);
        child.close();
      });
    };
  }, [open, paneId, title]);

  useLayoutEffect(() => {
    if (root === null) return;
    adoptPaneHost(root, registry.container(paneId));
  }, [paneId, registry, root]);

  /*
   * T774 — the child window reports on itself, to BOTH consoles, from mount onward.
   *
   * T739's viewer probe logs from the mounted pane, so it can only ever describe a mount
   * that succeeded. The owner's re-report ("an empty about blank screen with nothing")
   * describes one that did not, and against that fault T739's instrument is silent — which
   * is why an absent `viewer[floated]:` line has been ambiguous between a stale tab, a
   * failed mount, an unshipped instrument and a float that simply has not ticked yet.
   *
   * This effect runs after adoption, whether or not the pane has any canvas, and asks the
   * CHILD REALM for a frame. A window rendering nothing never delivers one, so the pair of
   * lines it produces — `child-frame` or `child-silent` — is the one fact the parent cannot
   * derive on its own, and the fact that splits "the app is in there and looks blank" from
   * "the app is not in there".
   */
  useEffect(() => {
    const mount = mountRef.current;
    if (root === null || mount === null) return;
    const view = mount.prepared.defaultView;
    const host = registry.container(paneId);

    const read = (): ChildMountReading =>
      readChildMount({
        child: mount.child,
        prepared: mount.prepared,
        root,
        host,
        childFrames: framesRef.current,
        // The parent's clock throughout: a child window's `performance` has its own time
        // origin, and an age measured across the two would be nonsense.
        ageMs: performance.now() - mount.requestedAt,
      });
    const emit = (stage: FloatStage): ChildMountReading => {
      const reading = read();
      emitFloatLine(formatChildMount(paneId, stage, reading), view);
      return reading;
    };

    emit("adopted");

    const holder = view as (Window & { shaderloomPaneTrace?: () => ChildMountReading }) | null;
    const trace = () => emit("alive");
    if (holder !== null) holder.shaderloomPaneTrace = trace;
    (window as Window & { shaderloomPaneTrace?: () => ChildMountReading }).shaderloomPaneTrace =
      trace;

    let frameId: number | null = null;
    let deadline: number | null = null;
    if (view !== null && typeof view.requestAnimationFrame === "function") {
      framesRef.current = 0;
      frameId = view.requestAnimationFrame(() => {
        frameId = null;
        framesRef.current = (framesRef.current ?? 0) + 1;
        emit("child-frame");
      });
      // The PARENT's timer: a child that is not rendering may also not be running timers,
      // and a deadline that needs the child to fire is no deadline at all.
      deadline = window.setTimeout(() => {
        deadline = null;
        if (framesRef.current === 0) emit("child-silent");
      }, CHILD_FRAME_DEADLINE_MS);
    }

    // Same cadence as T739's viewer probe, and unconditional for the same reason: an
    // instrument that goes quiet once things look healthy hands silence its ambiguity back.
    const timer = window.setInterval(() => emit("alive"), 2000);
    return () => {
      window.clearInterval(timer);
      if (deadline !== null) window.clearTimeout(deadline);
      if (frameId !== null) view?.cancelAnimationFrame?.(frameId);
      if (holder?.shaderloomPaneTrace === trace) delete holder.shaderloomPaneTrace;
      const parent = window as Window & { shaderloomPaneTrace?: () => ChildMountReading };
      if (parent.shaderloomPaneTrace === trace) delete parent.shaderloomPaneTrace;
    };
  }, [paneId, registry, root]);

  return null;
}
