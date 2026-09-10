import { useCallback } from "react";
import type { RefObject } from "react";

/**
 * A visibility gate for external-store subscriptions (T1239).
 *
 * The telemetry hub and the value-history ring notify at 10 Hz whether or not anything
 * that renders them is on screen. Every dock pane stays MOUNTED while hidden (§V96), so a
 * hidden Performance tab re-rendered its whole table ten times a second for nobody — and
 * on E24 that was most of the idle commit budget. This hook wraps a store's `subscribe` so
 * the listener runs only while the subscribing element is visible, and runs once more the
 * instant the element becomes visible again. The store keeps aggregating; only the DOM
 * stops. A pane that comes back shows current data on its first paint (§V86) and never
 * rendered while it was hidden.
 *
 * Mechanism, and why not an IntersectionObserver: `Element.checkVisibility()` answers
 * synchronously, so the decision is made on the tick itself; the hidden → visible flip
 * is caught by ONE MutationObserver over the element's ancestors (a `display:none` class
 * or `data-state` on some ancestor is how every pane and tab in this app hides), whose
 * callback runs as a microtask — before the frame that first shows the pane paints. An
 * IntersectionObserver delivers a task AFTER that frame, which is exactly one stale paint,
 * and one created in the main window never fires for a pane floated into another one.
 * Both primitives here come from the element's own document, so a floated pane works, and
 * the ancestor chain is re-collected whenever it changed (a pane moved between zones).
 *
 * Where `checkVisibility` does not exist (jsdom) everything counts as visible.
 */

export type Subscribe = (listener: () => void) => () => void;

/** True unless the element has no rendered box (`display:none` on it or any ancestor). */
export function isElementVisible(element: Element): boolean {
  return typeof element.checkVisibility === "function" ? element.checkVisibility() : true;
}

function ancestorsOf(element: Element): Element[] {
  const chain: Element[] = [];
  for (let node = element.parentElement; node !== null; node = node.parentElement) {
    chain.push(node);
  }
  return chain;
}

function sameChain(a: readonly Element[], b: readonly Element[]): boolean {
  return a.length === b.length && a.every((node, index) => node === b[index]);
}

export function useVisibleSubscribe(
  ref: RefObject<Element | null>,
  subscribe: Subscribe,
): Subscribe {
  return useCallback(
    (listener: () => void) => {
      const element = ref.current;
      // Subscribed before the element exists (never the case under React, which
      // subscribes from a passive effect) — no gate is better than a gate that never opens.
      if (element === null) return subscribe(listener);

      let visible = isElementVisible(element);
      let chain: Element[] = [];
      let observer: MutationObserver | null = null;

      /** Re-reads visibility; true when it just flipped to visible. */
      const check = (): boolean => {
        const now = isElementVisible(element);
        const shown = now && !visible;
        visible = now;
        return shown;
      };

      const arm = (): void => {
        const next = ancestorsOf(element);
        if (observer !== null && sameChain(chain, next)) return;
        observer?.disconnect();
        chain = next;
        const Observer = element.ownerDocument.defaultView?.MutationObserver;
        if (Observer === undefined) {
          observer = null;
          return;
        }
        observer = new Observer(() => {
          arm();
          if (check()) listener();
        });
        for (const node of chain) observer.observe(node, { attributes: true });
      };

      arm();
      const unsubscribe = subscribe(() => {
        arm();
        check();
        if (visible) listener();
      });
      return () => {
        observer?.disconnect();
        observer = null;
        unsubscribe();
      };
    },
    [ref, subscribe],
  );
}
