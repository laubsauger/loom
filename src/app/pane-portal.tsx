import { createContext, useContext, useLayoutEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";
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

export interface PaneHostRegistry {
  /** The pane's permanent portal target. Created on first ask, never replaced. */
  container(paneId: PaneKey): HTMLElement;
}

const PaneHostContext = createContext<PaneHostRegistry | null>(null);

export function usePaneHosts(): PaneHostRegistry {
  const registry = useContext(PaneHostContext);
  if (registry === null) {
    throw new Error("Pane content and outlets must be rendered inside <PaneHostProvider>.");
  }
  return registry;
}

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
      stashed.set(host, capturePaneState(host));
    };
  }, [paneId, registry]);

  return <div ref={slotRef} className={styles.outlet} data-pane-outlet={paneId} />;
}

/** State a detaching pane left behind, consumed by whoever adopts it next. */
const stashed = new WeakMap<HTMLElement, PaneState>();

interface ScrollMark {
  readonly element: Element;
  readonly top: number;
  readonly left: number;
}

function collectScroll(root: Element, out: ScrollMark[]): void {
  if (root.scrollTop !== 0 || root.scrollLeft !== 0) {
    out.push({ element: root, top: root.scrollTop, left: root.scrollLeft });
  }
  for (const child of Array.from(root.children)) collectScroll(child, out);
}

interface TextRestore {
  readonly kind: "field";
  readonly start: number | null;
  readonly end: number | null;
}

function isTextField(element: Element): element is HTMLInputElement | HTMLTextAreaElement {
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
}

/** Everything the browser keeps on the ELEMENT rather than in React state. */
interface PaneState {
  readonly scrolls: readonly ScrollMark[];
  readonly active: HTMLElement | null;
  readonly field: TextRestore | null;
  readonly range: Range | null;
}

function capturePaneState(host: HTMLElement): PaneState {
  const scrolls: ScrollMark[] = [];
  collectScroll(host, scrolls);

  const fromDocument = host.ownerDocument;
  const active =
    fromDocument.activeElement instanceof HTMLElement && host.contains(fromDocument.activeElement)
      ? fromDocument.activeElement
      : null;

  let field: TextRestore | null = null;
  let range: Range | null = null;
  if (active !== null && isTextField(active)) {
    field = { kind: "field", start: active.selectionStart, end: active.selectionEnd };
  } else {
    const selection = fromDocument.defaultView?.getSelection?.() ?? null;
    if (selection !== null && selection.rangeCount > 0) {
      const candidate = selection.getRangeAt(0);
      if (host.contains(candidate.commonAncestorContainer)) range = candidate.cloneRange();
    }
  }
  return { scrolls, active, field, range };
}

function restorePaneState(slot: HTMLElement, state: PaneState): void {
  for (const mark of state.scrolls) {
    mark.element.scrollTop = mark.top;
    mark.element.scrollLeft = mark.left;
  }

  const active = state.active;
  if (active === null) return;
  active.focus({ preventScroll: true });
  if (state.field !== null && isTextField(active)) {
    if (state.field.start !== null && state.field.end !== null) {
      active.setSelectionRange(state.field.start, state.field.end);
    }
    return;
  }
  if (state.range === null) return;
  // The nodes moved with the host, so the range still points at them; the SELECTION
  // object belongs to whichever document the host now lives in.
  const selection = slot.ownerDocument.defaultView?.getSelection?.() ?? null;
  if (selection === null) return;
  selection.removeAllRanges();
  selection.addRange(state.range);
}

/**
 * Moves `host` into `slot`, carrying scroll, focus and text selection across.
 *
 * Exported for the floating-window path, which appends the same host into a different
 * DOCUMENT — `appendChild` adopts the node, so the one implementation covers both.
 */
export function adoptPaneHost(slot: HTMLElement, host: HTMLElement): void {
  if (host.parentElement === slot) return;
  const state = stashed.get(host) ?? capturePaneState(host);
  stashed.delete(host);
  const documentChanged = host.ownerDocument !== slot.ownerDocument;
  slot.appendChild(host);
  restorePaneState(slot, state);
  /*
   * T705 — tell the pane's content it changed DOCUMENTS. A ResizeObserver belongs to
   * the window it was constructed in: when a pane floats, an observer made in the dock
   * fires one last time mid-detach (clientWidth 0 — which is how the viewer's canvas
   * ended up 1×1 and the popped-out window read as an empty page) and then never
   * again, because its element now lives in a document that window does not observe.
   * React cannot signal this either — relocation without remount (§V96) means no
   * fiber ever re-renders. So the HOST, the one element that provably travels with
   * the content, carries the signal: anything holding a per-document resource listens
   * here and re-arms against its new `ownerDocument`.
   */
  if (documentChanged) host.dispatchEvent(new Event(PANE_ADOPTED_EVENT));
}

/** Fired on a pane's permanent host when adoption moved it to a DIFFERENT document. */
export const PANE_ADOPTED_EVENT = "shaderloom:pane-adopted";
