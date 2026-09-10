import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { TERMINAL_PANE_HINT } from "@devices/helper.ts";
import type { TerminalClient, TerminalPaneSession, TerminalRefusal } from "@devices/terminal-client.ts";
import { KEYMAP_CONTEXT_ATTRIBUTE } from "@editor/keymap/index.ts";
import { Button } from "@ui/primitives/button.tsx";
import styles from "./terminal-pane.module.css";

/**
 * T1263 — THE `terminal` PANE: one shell from the local helper, in a dock tab.
 *
 * ## One pty per pane, by construction
 *
 * The pane asks for its session in an effect and closes it in that effect's cleanup.
 * The dock renders every tab as its own component instance (`app-shell.tsx`,
 * `contents[tab.role]` under `key={tab.key}`), so two terminal tabs are two instances
 * are two shells, and closing a tab unmounts its instance, which kills its shell. A
 * layout restore mounts a NEW instance, which opens a NEW shell — nothing here can
 * re-attach, because nothing here remembers a session across a mount.
 *
 * ## Why the pane starts IDLE, with a button
 *
 * The dock mounts every tab's content whether or not the tab is showing, and the
 * default layout carries a terminal tab (last in the bottom dock) so the pane is where
 * a user looks for it. Spawning in the mount effect would therefore start a hidden
 * shell on every boot of a paired tab — twice under StrictMode — for nobody. So the
 * shell is asked for by a CLICK, never by a mount: the pane is the unit of consent
 * (`terminal-host.ts`), and consent is a gesture, not an arrangement. "New shell" and
 * "Try again" after an exit or a refusal are the same gesture again.
 *
 * ## Why xterm is built only after the helper said yes
 *
 * The pane's other states — no helper paired, helper without the door, shell exited —
 * are one sentence and one button, and none of them needs a cell grid. Building the
 * terminal lazily also keeps the pane renderable where xterm cannot run (a jsdom test
 * of the hint sentence). The first size asked for is nominal; the real one follows from
 * `fit` the moment the grid exists, exactly as a resize does later.
 *
 * ## Theme
 *
 * xterm paints its own cells and cannot read a CSS variable, so the four colours it
 * needs are READ from the tokens at build time (`getComputedStyle`) rather than spelled
 * here — no literal colour in a component, and the pane follows the theme it mounted in.
 */

export interface TerminalPaneProps {
  readonly client: TerminalClient;
}

type Phase =
  /** Nothing asked for yet, or the last shell is gone and nothing asked since. */
  | { readonly kind: "idle" }
  | { readonly kind: "opening" }
  | { readonly kind: "open"; readonly pid: number; readonly shell: string }
  | { readonly kind: "exited"; readonly exitCode: number | null }
  | { readonly kind: "refused"; readonly reason: string; readonly detail: TerminalRefusal };

/** The nominal grid a shell is asked for before the pane has measured itself. */
const NOMINAL_COLS = 80;
const NOMINAL_ROWS = 24;

const TOKEN_NAMES = {
  background: "--bg-panel",
  foreground: "--text",
  cursor: "--signal",
  selectionBackground: "--selection-bg",
} as const;

function themeFromTokens(element: HTMLElement): Partial<Record<keyof typeof TOKEN_NAMES, string>> {
  const view = element.ownerDocument.defaultView;
  if (view === null) return {};
  const computed = view.getComputedStyle(element);
  const theme: Partial<Record<keyof typeof TOKEN_NAMES, string>> = {};
  for (const [key, token] of Object.entries(TOKEN_NAMES) as [keyof typeof TOKEN_NAMES, string][]) {
    const value = computed.getPropertyValue(token).trim();
    if (value !== "") theme[key] = value;
  }
  return theme;
}

export function TerminalPane({ client }: TerminalPaneProps) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  /** Bumped by every "open" gesture; 0 is "never asked", so the effect does nothing. */
  const [attempt, setAttempt] = useState(0);
  const surface = useRef<HTMLDivElement | null>(null);
  const session = useRef<TerminalPaneSession | null>(null);
  const terminal = useRef<Terminal | null>(null);
  /** Output that arrived before the grid existed; flushed into it once it does. */
  const backlog = useRef<string[]>([]);

  useEffect(() => {
    if (attempt === 0) return;
    backlog.current = [];
    setPhase({ kind: "opening" });
    const opened = client.open({
      cols: NOMINAL_COLS,
      rows: NOMINAL_ROWS,
      onOpened: (info) => {
        setPhase({ kind: "open", pid: info.pid, shell: info.shell });
      },
      onOutput: (data) => {
        const live = terminal.current;
        if (live === null) backlog.current.push(data);
        else live.write(data);
      },
      onExit: (exitCode) => {
        setPhase({ kind: "exited", exitCode });
      },
      onRefused: (reason, detail) => {
        setPhase({ kind: "refused", reason, detail });
      },
    });
    session.current = opened;
    return () => {
      session.current = null;
      // Closing the pane kills the shell: the whole of "one pty per pane".
      opened.close();
    };
  }, [client, attempt]);

  useEffect(() => {
    if (phase.kind !== "open") return;
    const host = surface.current;
    const live = session.current;
    if (host === null || live === null) return;
    // The font, like the colours, is read from what the tokens resolved to on this
    // element: xterm measures glyphs on a canvas, where a `var()` is not a font.
    const face = host.ownerDocument.defaultView?.getComputedStyle(host);
    const fontSize = Number.parseFloat(face?.fontSize ?? "");
    const term = new Terminal({
      cursorBlink: true,
      ...(face === undefined || face.fontFamily === "" ? {} : { fontFamily: face.fontFamily }),
      ...(Number.isFinite(fontSize) ? { fontSize } : {}),
      allowProposedApi: false,
      theme: themeFromTokens(host),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    terminal.current = term;
    for (const chunk of backlog.current) term.write(chunk);
    backlog.current = [];
    const keys = term.onData((data) => {
      live.write(data);
    });
    const refit = (): void => {
      fit.fit();
      live.resize(term.cols, term.rows);
    };
    refit();
    // The pane's own window, not the opener's — a floated pane observes in its portal
    // document (§V658), and an observer from the wrong window never fires there.
    const Observer = host.ownerDocument.defaultView?.ResizeObserver;
    const observer = Observer === undefined ? null : new Observer(refit);
    observer?.observe(host);
    term.focus();
    return () => {
      observer?.disconnect();
      keys.dispose();
      terminal.current = null;
      term.dispose();
    };
  }, [phase.kind]);

  const again = useCallback(() => {
    setAttempt((n) => n + 1);
  }, []);

  return (
    <div className={styles.pane} {...{ [KEYMAP_CONTEXT_ATTRIBUTE]: "text" }}>
      {phase.kind === "open" ? (
        <div ref={surface} className={styles.surface} data-terminal-pid={phase.pid} />
      ) : (
        <div className={styles.state} data-tone={phase.kind === "refused" && phase.detail === "refused" ? "error" : undefined}>
          {phase.kind === "idle" ? (
            <>
              <Button variant="outline" onClick={again}>
                Open shell
              </Button>
              {/* The one hint sentence, from helper.ts (T1110): what a shell needs, before asking. */}
              <span>Shells come from the local helper: {TERMINAL_PANE_HINT}.</span>
            </>
          ) : null}
          {phase.kind === "opening" ? <span>Opening a shell…</span> : null}
          {phase.kind === "exited" ? (
            <>
              <span>
                {phase.exitCode === null
                  ? "The shell went away with the local helper."
                  : `The shell exited (${String(phase.exitCode)}).`}
              </span>
              <Button variant="outline" onClick={again}>
                New shell
              </Button>
            </>
          ) : null}
          {phase.kind === "refused" ? (
            <>
              <span>{phase.reason}</span>
              <Button variant="outline" onClick={again}>
                Try again
              </Button>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
