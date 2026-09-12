import { createContext, useContext } from "react";
import type { PaneKey } from "./pane-tree.ts";

/**
 * Who owns each pane's permanent portal target (T193, §V96). Split out of
 * `pane-portal.tsx` by T1315b so that file exports only components.
 *
 * The context lives here rather than beside its provider for the reason the rule exists:
 * a Fast Refresh that re-evaluates the provider module would call `createContext` again,
 * and every consumer below would silently fall back to `null` — which this hook reports
 * as "not inside a <PaneHostProvider>".
 */

export interface PaneHostRegistry {
  /** The pane's permanent portal target. Created on first ask, never replaced. */
  container(paneId: PaneKey): HTMLElement;
}

export const PaneHostContext = createContext<PaneHostRegistry | null>(null);

export function usePaneHosts(): PaneHostRegistry {
  const registry = useContext(PaneHostContext);
  if (registry === null) {
    throw new Error("Pane content and outlets must be rendered inside <PaneHostProvider>.");
  }
  return registry;
}
