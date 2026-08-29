import { useMemo, useState, useSyncExternalStore } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { Button } from "../../ui/primitives/button.tsx";
import { cx } from "../../ui/cx.ts";
import { KeyChip } from "./key-hint.tsx";
import { eventStrokeToKeys, formatKeys, isModifierKeyName, strokeFromEvent } from "./keys.ts";
import { useOptionalKeymap } from "./keymap-provider.tsx";
import type { ResolvedBinding, ResolvedKeymap } from "./resolve.ts";
import type { KeymapStore } from "./store.ts";
import type { KeyContext } from "./types.ts";
import { KEY_CONTEXTS } from "./types.ts";
import styles from "./keybinding-settings.module.css";

/**
 * Keybinding settings pane (T78, §V54).
 *
 * Rebind, unbind, reset one binding, reset the whole map — with conflicts DETECTED and
 * SHOWN rather than silently resolved by table order. A conflicting rebind is still
 * allowed: the user is told what they collided with instead of being blocked, which is
 * the only way to get out of a partially-remapped state.
 *
 * Every control is a real button or input: reachable by Tab, activated by Enter/Space,
 * with the token focus ring (§V19).
 */

const CONTEXT_LABELS: Record<KeyContext, string> = {
  global: "Global",
  graph: "Graph",
  inspector: "Inspector",
  viewer: "Viewer",
  text: "Text editing",
};

export interface KeybindingSettingsProps {
  /** Falls back to the surrounding `<KeymapProvider>`'s store. */
  store?: KeymapStore;
  /** Lets the pane mark bindings whose command no track has registered yet. */
  isCommandAvailable?: (command: string) => boolean;
  className?: string;
}

function matchesFilter(binding: ResolvedBinding, needle: string): boolean {
  if (needle === "") return true;
  const haystack = [
    binding.label,
    binding.command,
    binding.id,
    binding.display ?? "",
    binding.effectiveKeys ?? "",
    CONTEXT_LABELS[binding.context],
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

function conflictSummary(resolved: ResolvedKeymap, bindingId: string): string | null {
  for (const conflict of resolved.conflicts) {
    if (!conflict.bindings.some((binding) => binding.id === bindingId)) continue;
    const others = conflict.bindings
      .filter((binding) => binding.id !== bindingId)
      .map((binding) => binding.label)
      .join(", ");
    return `${conflict.display} also runs ${others}.`;
  }
  return null;
}

export function KeybindingSettings({
  store: providedStore,
  isCommandAvailable,
  className,
}: KeybindingSettingsProps) {
  const keymap = useOptionalKeymap();
  const store = providedStore ?? keymap?.store;
  if (store === undefined) {
    throw new Error("<KeybindingSettings> needs a store prop or a surrounding <KeymapProvider>.");
  }
  return (
    <KeybindingSettingsBody
      store={store}
      {...(isCommandAvailable === undefined ? {} : { isCommandAvailable })}
      {...(className === undefined ? {} : { className })}
    />
  );
}

interface BodyProps {
  store: KeymapStore;
  isCommandAvailable?: (command: string) => boolean;
  className?: string;
}

function KeybindingSettingsBody({ store, isCommandAvailable, className }: BodyProps) {
  const [filter, setFilter] = useState("");
  const [capturing, setCapturing] = useState<string | null>(null);
  const [status, setStatus] = useState("");

  // The store is a plain observable, so React is told about it the standard way.
  const resolved = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  const needle = filter.trim().toLowerCase();
  const groups = useMemo(() => {
    const byContext = new Map<KeyContext, ResolvedBinding[]>();
    for (const context of KEY_CONTEXTS) byContext.set(context, []);
    for (const binding of resolved.bindings) {
      if (!matchesFilter(binding, needle)) continue;
      byContext.get(binding.context)?.push(binding);
    }
    return [...byContext.entries()].filter(([, bindings]) => bindings.length > 0);
  }, [resolved, needle]);

  const overrideCount = Object.keys(store.getOverrides()).length;

  function commit(binding: ResolvedBinding, keys: string | null): void {
    const result = store.setOverride(binding.id, keys);
    if (result.status !== "ok") {
      setStatus(result.message);
      return;
    }
    setCapturing(null);
    if (keys === null) {
      setStatus(`${binding.label} is now unbound.`);
      return;
    }
    const display = formatKeys(keys, store.platform) ?? keys;
    const conflict = conflictSummary(store.getSnapshot(), binding.id);
    setStatus(
      conflict === null
        ? `${binding.label} is now ${display}.`
        : `${binding.label} is now ${display}. Conflict: ${conflict}`,
    );
  }

  function onCaptureKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, binding: ResolvedBinding): void {
    const stroke = strokeFromEvent(event.nativeEvent);
    if (stroke === null) return;
    // Never let a captured key escape to the live keymap while recording.
    event.preventDefault();
    event.stopPropagation();
    if (isModifierKeyName(stroke.key)) return;
    if (stroke.key === "escape" && !stroke.ctrl && !stroke.meta && !stroke.alt && !stroke.shift) {
      setCapturing(null);
      setStatus("Rebinding cancelled.");
      return;
    }
    commit(binding, eventStrokeToKeys(stroke, store.platform));
  }

  return (
    <section className={cx(styles.pane, className)} aria-label="Keyboard shortcuts">
      <header className={styles.header}>
        <label className={styles.search}>
          <span className={styles.searchLabel}>Filter</span>
          <input
            type="search"
            className={styles.input}
            value={filter}
            placeholder="Command or key"
            onChange={(event) => setFilter(event.target.value)}
          />
        </label>
        <Button
          variant="outline"
          onClick={() => {
            store.resetAll();
            setStatus("All shortcuts reset to defaults.");
          }}
          disabled={overrideCount === 0}
        >
          Reset all
        </Button>
      </header>

      <p className={styles.status} role="status" aria-live="polite">
        {status}
      </p>

      {resolved.conflicts.length > 0 && (
        <ul className={styles.conflicts} aria-label="Shortcut conflicts">
          {resolved.conflicts.map((conflict) => (
            <li
              key={`${conflict.kind}:${conflict.keys}:${conflict.bindings.map((b) => b.id).join("+")}`}
              className={conflict.severity === "error" ? styles.conflictError : styles.conflictWarn}
            >
              {conflict.message}
            </li>
          ))}
        </ul>
      )}

      {groups.map(([context, bindings]) => (
        <div key={context} className={styles.group}>
          <h3 className={styles.groupTitle}>{CONTEXT_LABELS[context]}</h3>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Command</th>
                <th scope="col">Shortcut</th>
                <th scope="col">
                  <span className={styles.visuallyHidden}>Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {bindings.map((binding) => {
                const conflict = conflictSummary(resolved, binding.id);
                const unavailable =
                  isCommandAvailable !== undefined && !isCommandAvailable(binding.command);
                return (
                  <tr key={binding.id} className={styles.row} data-conflict={conflict !== null}>
                    <td className={styles.commandCell}>
                      <span className={styles.label}>{binding.label}</span>
                      <span className={styles.command}>{binding.command}</span>
                      {binding.unconfirmed === true && (
                        <span className={styles.tag} title="Not confirmed against a TouchDesigner install">
                          unverified
                        </span>
                      )}
                      {unavailable && (
                        <span className={styles.tag} title="No feature has registered this command yet">
                          unavailable
                        </span>
                      )}
                      {conflict !== null && <span className={styles.conflictNote}>{conflict}</span>}
                    </td>
                    <td className={styles.keysCell}>
                      <KeyChip display={binding.display} unbound />
                      {binding.source === "override" && <span className={styles.tag}>custom</span>}
                    </td>
                    <td className={styles.actions}>
                      <Button
                        aria-label={`Change shortcut for ${binding.label}`}
                        aria-pressed={capturing === binding.id}
                        variant={capturing === binding.id ? "outline" : "ghost"}
                        onClick={() =>
                          setCapturing((current) => (current === binding.id ? null : binding.id))
                        }
                        onKeyDown={(event) => {
                          if (capturing !== binding.id) return;
                          onCaptureKeyDown(event, binding);
                        }}
                      >
                        {capturing === binding.id ? "Press a key…" : "Change"}
                      </Button>
                      <Button
                        aria-label={`Unbind ${binding.label}`}
                        onClick={() => commit(binding, null)}
                        disabled={!binding.isBound}
                      >
                        Unbind
                      </Button>
                      <Button
                        aria-label={`Reset ${binding.label} to default`}
                        onClick={() => {
                          store.resetBinding(binding.id);
                          setCapturing(null);
                          setStatus(
                            `${binding.label} reset to ${formatKeys(binding.defaultKeys, store.platform) ?? binding.defaultKeys}.`,
                          );
                        }}
                        disabled={!store.hasOverride(binding.id)}
                      >
                        Reset
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}
    </section>
  );
}
