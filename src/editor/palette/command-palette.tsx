import { useCallback, useEffect, useId, useMemo, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { DialogContent, DialogRoot, DialogTitle } from "../../ui/primitives/dialog.tsx";
import { cx } from "../../ui/cx.ts";
import { KeyChip } from "../keymap/key-hint.tsx";
import { useKeymap, useRunCommand } from "../keymap/keymap-provider.tsx";
import { buildPaletteEntries } from "./entries.ts";
import type { PaletteEntry } from "./entries.ts";
import { fuzzyFilter } from "./fuzzy.ts";
import { registerPaletteCommands } from "./palette-commands.ts";
import styles from "./command-palette.module.css";

/**
 * Command palette (T79, §V55, §V29).
 *
 * Lists every command on the bus plus every command a binding names, shows the current
 * shortcut for each, and runs the chosen one through `bus.execute` — the same path the
 * hotkey takes. A command no track has registered yet is listed and disabled rather
 * than hidden or faked.
 *
 * Opening is itself a bus command (`ui.openCommandPalette`, bound to mod+k), so the
 * palette can be opened by a hotkey, a menu, a test or an agent without any of them
 * knowing about this component.
 */

export interface CommandPaletteProps {
  /** Controlled mode. Omit to let the bus command drive it. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  defaultOpen?: boolean;
  placeholder?: string;
  /** Cap on rendered rows; the list stays scrollable and keyboard-navigable. */
  maxResults?: number;
}

export function CommandPalette({
  open: controlledOpen,
  onOpenChange,
  defaultOpen = false,
  placeholder = "Run a command…",
  maxResults = 60,
}: CommandPaletteProps) {
  const { bus, resolved } = useKeymap();
  const run = useRunCommand();
  const listId = useId();

  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const open = controlledOpen ?? uncontrolledOpen;

  const setOpen = useCallback(
    (next: boolean) => {
      setUncontrolledOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );

  // `mod+k` names a command; the command reaches this component through the holder.
  const handlers = useMemo(
    () => ({ open: () => setOpen(true), close: () => setOpen(false) }),
    [setOpen],
  );
  useEffect(() => {
    const holder = registerPaletteCommands(bus);
    holder.current = handlers;
    return () => {
      if (holder.current === handlers) holder.current = null;
    };
  }, [bus, handlers]);

  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [status, setStatus] = useState("");

  /*
   * Commands are registered as tracks load, so the list is rebuilt each time it opens —
   * in an EFFECT, after the commit, never during the render that observed the bus.
   *
   * ## T1124 — the bug this shape exists to stop, measured
   *
   * Opening a document does not mutate the runtime, it REPLACES it (`app.tsx` calls
   * `setRuntime(createAppRuntime(…))`), and the new bus starts with only the commands the
   * composition root registers. Every command a mounted SURFACE owns — `ui.openLayouts`,
   * `layout.reset`, `ui.showProblems`, `ui.openHelp`, `ui.openSettings`,
   * `ui.showNodeInfo`, `ui.openCommandPalette` — is put back by that surface's own effect,
   * which by definition has not run yet at the moment this component renders with the new
   * bus. Building the list during that render snapshots a bus that is still half empty,
   * and because the memo's deps do not change again the snapshot NEVER refreshes: the
   * palette stays wrong for as long as it is open.
   *
   * Measured at HEAD, headless Chromium, T1123's first-boot starter (which is a document
   * open, so it swaps the runtime a beat after the canvas paints): a palette opened in
   * that window listed 50 commands instead of 85, `ui.openLayouts` absent entirely and
   * `ui.openHelp` / `ui.openSettings` / `ui.showNodeInfo` greyed as "unavailable". Every
   * one of them is reachable again by closing the palette and reopening it, which is
   * exactly the shape that keeps a bug like this out of a report — it does not reproduce
   * the second time you look.
   *
   * §V307's whole claim is that one command buys three doors. This was the palette door
   * dying silently while the other two kept working. Caught by `layout.spec.ts`'s V307
   * spec, which is the only gate that drives the palette in the composed app.
   *
   * Effects flush in tree order, and the surfaces that register are mounted ABOVE and
   * BEFORE this component (`AppShell` precedes `CommandPalette` in `app.tsx`), so their
   * re-registration lands in the same commit, before this runs.
   */
  const [entries, setEntries] = useState<readonly PaletteEntry[]>([]);
  useEffect(() => {
    setEntries(open ? buildPaletteEntries({ bus, resolved }) : []);
  }, [open, bus, resolved]);

  const results = useMemo(
    () => fuzzyFilter(query, entries, (entry) => [entry.label, entry.command]).slice(0, maxResults),
    [query, entries, maxResults],
  );

  useEffect(() => {
    setActiveIndex(0);
  }, [query, open]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setStatus("");
    }
  }, [open]);

  const runEntry = useCallback(
    (entry: PaletteEntry) => {
      if (!entry.available) {
        setStatus(`${entry.label} is not available yet — no feature has registered ${entry.command}.`);
        return;
      }
      setOpen(false);
      void run(entry.command);
    },
    [run, setOpen],
  );

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (results.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % results.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + results.length) % results.length);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(results.length - 1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const selected = results[activeIndex];
      if (selected !== undefined) runEntry(selected.item);
    }
  };

  return (
    <DialogRoot open={open} onOpenChange={setOpen}>
      <DialogContent className={styles.content} aria-label="Command palette">
        <DialogTitle className={styles.srOnly}>Command palette</DialogTitle>
        <input
          // The palette exists to take focus; Radix restores it to the opener on close.
          autoFocus
          type="text"
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-autocomplete="list"
          aria-label="Search commands"
          aria-activedescendant={
            results[activeIndex] === undefined ? undefined : `${listId}-${activeIndex}`
          }
          className={styles.input}
          placeholder={placeholder}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onInputKeyDown}
        />

        <ul id={listId} role="listbox" aria-label="Commands" className={styles.list}>
          {results.length === 0 && (
            <li className={styles.empty} role="presentation">
              No matching command.
            </li>
          )}
          {results.map((result, index) => {
            const entry = result.item;
            return (
              <li
                key={entry.command}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === activeIndex}
                aria-disabled={!entry.available}
                className={cx(
                  styles.item,
                  index === activeIndex && styles.itemActive,
                  !entry.available && styles.itemUnavailable,
                )}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => runEntry(entry)}
              >
                <span className={styles.label}>{entry.label}</span>
                <span className={styles.command}>{entry.command}</span>
                {!entry.available && <span className={styles.tag}>unavailable</span>}
                <KeyChip display={entry.display} className={styles.keys} />
              </li>
            );
          })}
        </ul>

        <p className={styles.status} role="status" aria-live="polite">
          {status}
        </p>
      </DialogContent>
    </DialogRoot>
  );
}
