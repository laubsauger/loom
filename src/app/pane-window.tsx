import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PaneId } from "./layout-storage.ts";
import { adoptPaneHost, usePaneHosts } from "./pane-portal.tsx";
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
  readonly paneId: PaneId;
  readonly title: string;
  /** Called when the window goes away — by its own close button or by a blocked popup. */
  readonly onClose: (paneId: PaneId) => void;
  /**
   * The window could not be opened at all.
   *
   * Docking the pane back is the right recovery, and on its own it is indistinguishable
   * from the click having done nothing — so whoever mounts this says WHY on screen.
   */
  readonly onBlocked?: (paneId: PaneId) => void;
  readonly open?: OpenPaneWindow;
}

export function FloatingPane({ paneId, title, onClose, onBlocked, open }: FloatingPaneProps) {
  const registry = usePaneHosts();
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const blockedRef = useRef(onBlocked);
  blockedRef.current = onBlocked;

  useEffect(() => {
    const opener = open ?? openBrowserPaneWindow;
    const name = `shaderloom-${paneId}`;
    const child = opener({ name, title: `${title} — Shaderloom` });
    if (child === null) {
      // A blocked popup must not leave the pane in limbo with nowhere to render — and
      // must not look like a button that does nothing either.
      blockedRef.current?.(paneId);
      closeRef.current(paneId);
      return;
    }

    // Claim the name. Whatever mount claimed it before this one no longer owns it, so its
    // pending close becomes a no-op instead of landing on the window this mount now uses.
    const token = Symbol(name);
    windowOwners.set(name, token);

    const doc = child.document;
    copyStyles(document, doc);
    doc.body.className = styles.body ?? "";
    const element = doc.createElement("div");
    element.className = styles.root ?? "";
    doc.body.appendChild(element);
    setRoot(element);

    const closed = () => closeRef.current(paneId);
    child.addEventListener("pagehide", closed);
    // A reload of the main window must not leave orphaned popups behind.
    const closeChild = () => child.close();
    window.addEventListener("pagehide", closeChild);

    return () => {
      child.removeEventListener("pagehide", closed);
      window.removeEventListener("pagehide", closeChild);
      setRoot(null);
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

  return null;
}
