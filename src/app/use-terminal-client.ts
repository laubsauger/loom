import { useEffect, useState } from "react";
import {
  createTerminalClient,
  type TerminalClient,
  type TerminalClientOptions,
} from "@devices/terminal-client.ts";

/**
 * B213 — WHO OWNS THE TAB'S ONE TERMINAL CLIENT, AND FOR HOW LONG.
 *
 * ## The bug this shape exists to make impossible
 *
 * The app held the client in a `[]`-memo and disposed it from an effect cleanup. Under
 * `<StrictMode>` (`main.tsx`) React mounts, runs every cleanup and re-runs every effect,
 * so the cleanup disposed the ONE instance the memo would ever hand out while the memo
 * did not re-run. `dispose()` latches — deliberately, it means the tab is going away —
 * and every later `open()` refused with "This tab is going away.". The terminal had
 * never worked in a dev build; the owner met it on their first click.
 *
 * The third instance of this shape (B96's value-history store, the B172 follow-up's
 * runtime), and the only one of the three where the resource is genuinely one-way: a
 * client that un-disposed would be lying about the socket it holds. So the LIFETIME
 * moves instead of the semantics — the effect run that creates an instance is the run
 * that disposes it, which is what React's mount/cleanup/mount rehearsal is asking for.
 * A rehearsal now costs one throwaway client that never connected (constructing one
 * opens nothing: the (c) rule in `terminal-client.ts`), and a real unmount still kills
 * the shells the tab holds.
 *
 * ## Why the caller may get `null`
 *
 * The client exists from the first effect, not the first render, so the tab renders
 * empty for one commit. That is the honest report of "nothing owns a shell yet" and it
 * is invisible in the product: the pane is idle-with-a-button until someone clicks it.
 */

const LOOM_TAB: TerminalClientOptions = { client: "a Loom tab" };

/** The tab's terminal client, or `null` until the mount effect has built one. */
export function useTerminalClient(options: TerminalClientOptions = LOOM_TAB): TerminalClient | null {
  const [client, setClient] = useState<TerminalClient | null>(null);
  useEffect(() => {
    const live = createTerminalClient(options);
    setClient(live);
    return () => {
      // Only retract what is still ours: a re-run has already published its own.
      setClient((current) => (current === live ? null : current));
      live.dispose();
    };
  }, [options]);
  return client;
}
