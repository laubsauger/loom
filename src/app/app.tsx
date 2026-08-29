import { AppShell } from "./app-shell.tsx";

/**
 * Application root. Deliberately thin: the shell owns layout, and the panes are
 * slots the graph / inspector / editor / viewer tracks fill in later waves.
 */
export function App() {
  return <AppShell />;
}
