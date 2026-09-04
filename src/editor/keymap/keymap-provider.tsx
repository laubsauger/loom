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
import type { LoomBus } from "../../domain/commands/bus.ts";
import type {
  CommandInput,
  CommandName,
  CommandResult,
  InvocationContext,
} from "../../domain/types/commands.ts";
import { selectCreatedNodes } from "@editor/selection/select-created.ts";
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
  bus: LoomBus;
  /** Actor identity every dispatch is stamped with (§V30). */
  invocationContext: InvocationContext;
  /** Chord in progress, "" when none. */
  pending: string;
}

const KeymapReactContext = createContext<KeymapContextValue | null>(null);

export interface KeymapProviderProps {
  bus: LoomBus;
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

/**
 * The one keydown wrapper both listen surfaces share, so the "someone closer already
 * handled it" rule and the consume semantics cannot drift between windows (T813).
 */
function keydownHandlerFor(engine: KeymapEngine): (event: Event) => void {
  return (event: Event): void => {
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
}

/**
 * T813 — a SECOND listen surface for the provider's ONE engine: the floated pane's
 * child window (§V97). Keydown events fire at the window that has focus, so a keymap
 * listening only on the app's window makes a floated viewer a surface that answers no
 * shortcut at all — and perform mode makes that window the PRIMARY surface.
 *
 * Deliberately the same engine and the same resolved keymap, never a second provider: a
 * floated window with DIFFERENT shortcuts would be worse than one with none. Context
 * resolution already travels — `activeContextsFor` walks `closest()` from the event's
 * own target, which lives in the child document and carries the same
 * `data-keymap-context` attributes the docked pane had. This component only adds the
 * listener; the provider keeps owning the engine's lifecycle, which is why there is no
 * `engine.reset()` here — resetting a chord because a floated window CLOSED would eat
 * the parent's half-typed sequence.
 *
 * Renders nothing. Mount it wherever the child window's handle lives (`FloatingPane`).
 */
export function KeymapWindowTarget({ target }: { target: EventTarget | null }) {
  const context = useContext(KeymapReactContext);
  useEffect(() => {
    if (context === null || target === null) return;
    const onKeyDown = keydownHandlerFor(context.engine);
    target.addEventListener("keydown", onKeyDown);
    return () => target.removeEventListener("keydown", onKeyDown);
  }, [context, target]);
  return null;
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
        onDispatch: (dispatch) => {
          // A hotkey that created nodes selects them (§V101) — `mod+v` and `mod+d` are
          // the live cases. Here rather than inside the engine so the engine stays the
          // headless, side-effect-free dispatcher its own tests exercise; and here rather
          // than at each command so a command registered later gets it for nothing.
          if (dispatch.status === "dispatched") {
            void dispatch.run.then((result) =>
              selectCreatedNodes(bus, invocationRef.current, result),
            );
          }
          dispatchRef.current?.(dispatch);
        },
      }),
    [bus, store.platform],
  );

  useEffect(() => {
    if (!enabled) return;
    const listenTarget = target === undefined ? (typeof window === "undefined" ? null : window) : target;
    if (listenTarget === null) return;

    const onKeyDown = keydownHandlerFor(engine);
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
      const result = await bus.execute(
        command as CommandName,
        input as CommandInput<CommandName>,
        invocationContext,
      );
      // "the way a hotkey would" includes this: the canvas menu's "Add node here", and
      // Paste/Duplicate from a menu row or the palette, select what they created exactly
      // as `mod+v` does above (§V78 — one behaviour, not two).
      await selectCreatedNodes(bus, invocationContext, result);
      return result;
    },
    [bus, invocationContext],
  );
}
