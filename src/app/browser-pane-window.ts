import type { OpenPaneWindow } from "./pane-window.tsx";

/**
 * The one real `OpenPaneWindow` (T192, §V97) — `window.open`, and nothing else. Split out
 * of `pane-window.tsx` by T1315b so that file exports only components; a test hands in its
 * own opener, so this is the only site that touches the browser.
 */

/** The real thing. Returns null when the popup was blocked — a state, not a crash. */
export const openBrowserPaneWindow: OpenPaneWindow = ({ name, title }) => {
  if (typeof window === "undefined") return null;
  const child = window.open("", name, "popup=yes,width=760,height=560");
  if (child === null) return null;
  child.document.title = title;
  return child;
};
