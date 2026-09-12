/**
 * Moving a pane's permanent host between slots, and between DOCUMENTS, without losing
 * what the browser keeps on the element rather than in React state (T193, T705, §V96).
 *
 * Split out of `pane-portal.tsx` by T1315b so that file exports only components. Nothing
 * here touches React: it is scroll offsets, focus, text selection and one event.
 */

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
export const PANE_ADOPTED_EVENT = "loom:pane-adopted";

/**
 * What an outgoing `PaneOutlet` leaves for whoever adopts the host next.
 *
 * The capture has to happen in the OUTGOING outlet's layout-effect cleanup — the last
 * moment the pane is still attached and its scroll offsets still read non-zero.
 */
export function stashPaneState(host: HTMLElement): void {
  stashed.set(host, capturePaneState(host));
}
