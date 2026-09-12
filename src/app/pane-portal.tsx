import { useLayoutEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import { adoptPaneHost, stashPaneState } from "./pane-adoption.ts";
import { PaneHostContext, usePaneHosts } from "./pane-host-registry.ts";
import type { PaneHostRegistry } from "./pane-host-registry.ts";
import type { PaneKey } from "./pane-tree.ts";
import styles from "./pane-portal.module.css";

/**
 * Relocation without remount (T193, §V96).
 *
 * ## The problem
 *
 * Moving a pane in a React tree means rendering it under a different parent. React
 * reconciles by position, so that is an unmount and a fresh mount: CodeMirror is torn
 * down and rebuilt with an empty undo history at scroll 0, a preview canvas loses its
 * GPU context, and whatever had focus does not. It is the same failure the bottom dock's
 * `forceMount` fixed for tab switching, reached by dragging instead.
 *
 * ## Why the obvious portal does not fix it
 *
 * `createPortal(content, target)` looks like the answer, but React matches a portal fiber
 * on its `containerInfo`: change the target and the old portal is DELETED and a new one
 * created — the same unmount, one level of indirection further down. A portal whose
 * target changes is not a reparent.
 *
 * ## What actually works
 *
 * Every pane gets ONE detached `<div>`, created once and never replaced, and its content
 * is portalled into that div from a fixed position in the tree (`PaneContent`, rendered
 * in a stable order by `AppShell`). React therefore never sees the pane move at all: the
 * portal target is constant for the life of the app, so the content fiber is never
 * unmounted, never re-created, and keeps its state, its DOM and its GPU resources.
 *
 * Relocation is then a DOM operation: `PaneOutlet` appends that same div into whatever
 * slot it happens to be rendered in — a dock zone, or the body of a floating window
 * (§V97). Only the outlet (an empty div) is unmounted and re-mounted by the move.
 *
 * ## What a DOM move still costs, and what is done about it
 *
 * Detaching and re-attaching an element resets scroll offsets and blurs whatever was
 * focused inside it — state the browser keeps on the element rather than in React. So the
 * move captures scroll positions, the active element and its text selection, and restores
 * all three immediately afterwards, synchronously, inside the same layout effect. That is
 * what makes "keeps its scroll, selection and undo history" true rather than nearly true.
 *
 * ## §V16
 *
 * Nothing here re-renders on drag. The arrangement is state in `AppShell`; per-frame data
 * never reaches this module, and moving a pane touches the DOM once.
 */

export function PaneHostProvider({ children }: { children: ReactNode }) {
  const containers = useRef(new Map<PaneKey, HTMLElement>());
  const registry = useMemo<PaneHostRegistry>(
    () => ({
      container(paneId) {
        const existing = containers.current.get(paneId);
        if (existing !== undefined) return existing;
        const element = document.createElement("div");
        element.className = styles.host ?? "";
        element.dataset["paneHost"] = paneId;
        containers.current.set(paneId, element);
        return element;
      },
    }),
    [],
  );
  return <PaneHostContext.Provider value={registry}>{children}</PaneHostContext.Provider>;
}

/**
 * Renders one pane's content into its permanent container.
 *
 * Must be rendered in a FIXED position in the tree for every pane, whatever the
 * arrangement says — that is the whole trick. `AppShell` maps over `PANE_IDS`, which is a
 * constant, so the list never reorders and no pane's fiber ever moves.
 */
export function PaneContent({ paneId, children }: { paneId: PaneKey; children: ReactNode }) {
  const registry = usePaneHosts();
  return createPortal(children, registry.container(paneId), paneId);
}

/** Where a pane is currently shown. Mounting one moves the pane's DOM into it. */
export function PaneOutlet({ paneId }: { paneId: PaneKey }) {
  const registry = usePaneHosts();
  const slotRef = useRef<HTMLDivElement | null>(null);

  // Layout effect, not effect: the move must land before the browser paints, or the pane
  // visibly flashes empty in its new home.
  //
  // The CLEANUP is what makes scroll and focus survive. React removes a deleted outlet's
  // DOM only after running its layout-effect destroy functions, so this is the last
  // moment at which the pane is still attached and still has measurable scroll offsets —
  // by the time the NEW outlet's effect runs, the pane is detached and every offset reads
  // 0. So the outgoing outlet captures, and the incoming one restores.
  useLayoutEffect(() => {
    const slot = slotRef.current;
    if (slot === null) return;
    const host = registry.container(paneId);
    adoptPaneHost(slot, host);
    return () => {
      stashPaneState(host);
    };
  }, [paneId, registry]);

  return <div ref={slotRef} className={styles.outlet} data-pane-outlet={paneId} />;
}
