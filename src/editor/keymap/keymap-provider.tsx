import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";
import type { ShaderloomBus } from "../../domain/commands/bus.ts";
import type {
  CommandInput,
  CommandName,
  CommandResult,
  InvocationContext,
} from "../../domain/types/commands.ts";
import type { KeymapDispatch, KeymapEngine } from "./engine.ts";
import { createKeymapEngine } from "./engine.ts";
import type { ResolvedKeymap } from "./resolve.ts";
import { displayForBinding, displayForCommand } from "./resolve.ts";
import type { KeymapStore, KeymapStoreOptions } from "./store.ts";
import { createKeymapStore } from "./store.ts";
import type { KeymapEnvironment } from "./types.ts";
import { EMPTY_ENVIRONMENT } from "./types.ts";

/**
 * Thin React binding for the keymap (T76).
 *
 * All of the logic lives in the headless engine; this file only owns the window
 * listener and the context plumbing. Components never read key names — they ask the
 * keymap for a display string (§V55) and let the engine dispatch (§V52).
 */

export interface KeymapContextValue {
  store: KeymapStore;
  resolved: ResolvedKeymap;
  engine: KeymapEngine;
  bus: ShaderloomBus;
  /** Actor identity every dispatch is stamped with (§V30). */
  invocationContext: InvocationContext;
  /** Chord in progress, "" when none. */
  pending: string;
}

const KeymapReactContext = createContext<KeymapContextValue | null>(null);

export interface KeymapProviderProps {
  bus: ShaderloomBus;
  /** Supply one to share a store across trees (settings pane in a separate root). */
  store?: KeymapStore;
  storeOptions?: KeymapStoreOptions;
  /** Selection and hover for `when` guards and selection-resolved input. */
  environment?: KeymapEnvironment;
  /** Actor identity for every dispatched command (§V30). */
  invocationContext: InvocationContext;
  /** Defaults to `window`. */
  target?: EventTarget | null;
  /** Stop listening without unmounting (modal capture, recording a rebind). */
  enabled?: boolean;
  onDispatch?: (dispatch: KeymapDispatch) => void;
  children?: ReactNode;
}

export function KeymapProvider({
  bus,
  store: providedStore,
  storeOptions,
  environment = EMPTY_ENVIRONMENT,
  invocationContext,
  target,
  enabled = true,
  onDispatch,
  children,
}: KeymapProviderProps) {
  const [fallbackStore] = useState(() => providedStore ?? createKeymapStore(storeOptions));
  const store = providedStore ?? fallbackStore;
  const resolved = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [pending, setPending] = useState("");

  // Latest-value refs so the engine is created once and still sees fresh state.
  const environmentRef = useRef(environment);
  environmentRef.current = environment;
  const invocationRef = useRef(invocationContext);
  invocationRef.current = invocationContext;
  const dispatchRef = useRef(onDispatch);
  dispatchRef.current = onDispatch;
  const storeRef = useRef(store);
  storeRef.current = store;

  const engine = useMemo(
    () =>
      createKeymapEngine({
        bus,
        platform: store.platform,
        getResolved: () => storeRef.current.getSnapshot(),
        getEnvironment: () => environmentRef.current,
        getInvocationContext: () => invocationRef.current,
        onPendingChange: setPending,
        onDispatch: (dispatch) => dispatchRef.current?.(dispatch),
      }),
    [bus, store.platform],
  );

  useEffect(() => {
    if (!enabled) return;
    const listenTarget = target === undefined ? (typeof window === "undefined" ? null : window) : target;
    if (listenTarget === null) return;

    const onKeyDown = (event: Event): void => {
      const keyboardEvent = event as KeyboardEvent;
      // Someone closer to the action already handled it (a Radix dialog, a
      // CodeMirror binding): the keymap does not second-guess them.
      if (keyboardEvent.defaultPrevented) return;
      const result = engine.handleKey(keyboardEvent);
      if (result.consumed) {
        keyboardEvent.preventDefault();
        keyboardEvent.stopPropagation();
      }
    };

    listenTarget.addEventListener("keydown", onKeyDown);
    return () => {
      listenTarget.removeEventListener("keydown", onKeyDown);
      engine.reset();
    };
  }, [enabled, engine, target]);

  const value = useMemo<KeymapContextValue>(
    () => ({ store, resolved, engine, bus, invocationContext, pending }),
    [store, resolved, engine, bus, invocationContext, pending],
  );

  return <KeymapReactContext.Provider value={value}>{children}</KeymapReactContext.Provider>;
}

export function useKeymap(): KeymapContextValue {
  const value = useContext(KeymapReactContext);
  if (value === null) {
    throw new Error("useKeymap must be used inside a <KeymapProvider>.");
  }
  return value;
}

/** Optional form, for chrome that may render outside a provider (storybook, tests). */
export function useOptionalKeymap(): KeymapContextValue | null {
  return useContext(KeymapReactContext);
}

/**
 * The display string a menu item or tooltip should show (§V55) — never a hardcoded
 * "⌘Z". `null` when the command has no binding, so the caller renders nothing.
 */
export function useCommandKeyDisplay(command: string): string | null {
  const keymap = useOptionalKeymap();
  return keymap === null ? null : displayForCommand(keymap.resolved, command);
}

export function useBindingKeyDisplay(bindingId: string): string | null {
  const keymap = useOptionalKeymap();
  return keymap === null ? null : displayForBinding(keymap.resolved, bindingId);
}

/**
 * Runs a bus command the way a hotkey would — for a toolbar button, menu item or the
 * command palette, so there stays exactly one mutation path (§V29). Resolves to `null`
 * when no track has registered the command yet, instead of throwing.
 */
export function useRunCommand(): (
  command: string,
  input?: Record<string, unknown>,
) => Promise<CommandResult<CommandName> | null> {
  const { bus, invocationContext } = useKeymap();
  return useCallback(
    async (command, input = {}) => {
      if (!bus.hasCommand(command)) return null;
      return bus.execute(
        command as CommandName,
        input as CommandInput<CommandName>,
        invocationContext,
      );
    },
    [bus, invocationContext],
  );
}
