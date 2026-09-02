import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { Button } from "./button.tsx";
import styles from "./error-boundary.module.css";

/**
 * CONTAINMENT (B79, §V288).
 *
 * ## What was missing
 *
 * There was no error boundary anywhere in the tree — measured, by grep: not one
 * `componentDidCatch`, not one `getDerivedStateFromError`, in the whole of `src/`. React
 * unmounts the ENTIRE root when a render throws and nothing catches it, so any throw in any
 * surface — one number field, one preview tile, one inspector row — took the whole app with
 * it and left a WHITE SCREEN. No message, no stack on screen, no pane still standing, and
 * the user's unsaved graph gone with it.
 *
 * That is the more serious half of B79, and it is true independently of whatever throws:
 * the cost of a bug should be the bug, not the document. So the fix is not "find that one
 * throw" (which is still open — see the report on B79) but "stop a throw from being total".
 *
 * ## What it does
 *
 * The failed surface is replaced, in place, by a panel that NAMES it — which pane died and
 * what it said (§V288) — while every other pane keeps rendering and the document keeps
 * living in the store, unedited. "Reload this pane" clears the error and re-renders the
 * subtree, so a transient failure (a frame of bad runtime data, a half-applied hot update)
 * costs one click rather than the session.
 *
 * The error is also written to `console.error` with React's component stack. A white screen
 * gave a developer nothing at all; this gives them the throw and the fiber path.
 *
 * ## What a boundary CANNOT catch, and why that must be said
 *
 * React boundaries catch throws from RENDER, from lifecycle methods, and from constructors
 * below them. They do NOT catch:
 *
 *   - throws inside event handlers (`onClick`, `onBlur` — including the rename editor's
 *     blur-commit, which is exactly B79's suspected shape),
 *   - rejected promises and anything in a `setTimeout`/microtask,
 *   - throws in the boundary's own render.
 *
 * An unhandled event-handler throw does not white-screen either — the browser reports it
 * and React carries on — so the two failure modes are genuinely different and this covers
 * one of them. Claiming it covers both would be the kind of "wired, therefore safe" that
 * §V220 keeps catching.
 */

export interface ErrorBoundaryProps {
  /**
   * The surface's name, as the user knows it ("Inspector", "Graph"). It is the whole
   * diagnostic value of the panel: "something broke" is not a report, "the Inspector
   * broke" is.
   */
  name: string;
  /** Raised alongside the console record, for a shell that wants to surface it elsewhere. */
  onError?: (error: Error, info: ErrorInfo) => void;
  children?: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Named, not anonymous: the console line says WHICH surface, so a stack that lands in
    // shared code (a control, a store hook) is still attributable.
    console.error(`Loom: the ${this.props.name} pane failed to render.`, error, info.componentStack);
    this.props.onError?.(error, info);
  }

  private readonly retry = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    return (
      <div className={styles.failure} role="alert" data-testid={`pane-error-${this.props.name}`}>
        <p className={styles.title}>{this.props.name} stopped</p>
        <p className={styles.message}>{error.message || String(error)}</p>
        {/*
          The sentence that matters most is not the error, it is this one: a user staring at
          a broken pane has no way to know whether the graph they have not saved is still
          there. It is, and saying so is what stops them reloading the tab to find out.
        */}
        <p className={styles.reassurance}>
          The rest of the app is still running and your graph has not been changed.
        </p>
        <Button variant="outline" onClick={this.retry}>
          Reload this pane
        </Button>
      </div>
    );
  }
}
