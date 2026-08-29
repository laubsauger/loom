import { createContext, useContext } from "react";
import type { AppRuntime } from "./app-runtime.ts";

/**
 * How a pane reaches the one bus (T51).
 *
 * Panes take the runtime from context rather than from props threaded through the
 * shell, so a pane that needs to mutate cannot quietly acquire a different store: there
 * is one provider, at the composition root, holding the one bus (§V29).
 */
export const AppRuntimeContext = createContext<AppRuntime | null>(null);

export function useAppRuntime(): AppRuntime {
  const runtime = useContext(AppRuntimeContext);
  if (runtime === null) {
    throw new Error("useAppRuntime must be used inside the app composition root.");
  }
  return runtime;
}
