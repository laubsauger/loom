import { useEffect, useRef } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentUnit } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { lintGutter, setDiagnostics } from "@codemirror/lint";
import type { Diagnostic } from "@codemirror/lint";
import { cx } from "@ui/cx.ts";
import type { ShaderEditorMarker } from "./compile-types.ts";
import { wgsl } from "./wgsl-language.ts";
import { json } from "./json-language.ts";
import { shaderEditorHighlighting } from "./theme.ts";
import styles from "./shader-editor.module.css";

export interface ShaderEditorProps {
  value: string;
  /** T492: highlighting follows the parameter's declared language. Default WGSL. */
  language?: "wgsl" | "json" | undefined;
  onChange?: ((value: string) => void) | undefined;
  /** Fired when focus leaves the editor — the natural moment to commit and compile. */
  onBlur?: (() => void) | undefined;
  markers?: readonly ShaderEditorMarker[] | undefined;
  readOnly?: boolean | undefined;
  /** Accessible name for the editing region. */
  label?: string | undefined;
  className?: string | undefined;
}

const readOnlyCompartment = new Compartment();

/**
 * CodeMirror 6, hosting WGSL (T20).
 *
 * ## §V53 — this is a `text` key context
 *
 * The container carries `data-keymap-context="text"`, and CodeMirror's own history keymap
 * handles `mod+z` inside it. Both halves matter: the attribute is what lets the keymap
 * engine (`src/editor/keymap`, track Q) resolve the narrowest context and *not* dispatch
 * the graph's undo, and the history keymap is what makes the undo the user does get be
 * an undo of their typing. Nothing here imports the keymap engine — the marker is a DOM
 * attribute precisely so the two can be built independently.
 */
export function ShaderEditor({
  value,
  language = "wgsl",
  onChange,
  onBlur,
  markers,
  readOnly = false,
  label = "WGSL shader source",
  className,
}: ShaderEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Held in refs so a new callback identity never tears down the editor and loses the
  // cursor, the selection and the undo history with it.
  const onChangeRef = useRef(onChange);
  const onBlurRef = useRef(onBlur);
  const applyingExternal = useRef(false);

  onChangeRef.current = onChange;
  onBlurRef.current = onBlur;

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          highlightSpecialChars(),
          drawSelection(),
          rectangularSelection(),
          bracketMatching(),
          indentUnit.of("  "),
          history(),
          search(),
          highlightSelectionMatches(),
          lintGutter(),
          language === "json" ? json() : wgsl(),
          shaderEditorHighlighting,
          // History first: mod+z must reach the text history before anything else can
          // claim it (§V53).
          keymap.of([...historyKeymap, ...defaultKeymap, ...searchKeymap, indentWithTab]),
          readOnlyCompartment.of(EditorState.readOnly.of(readOnly)),
          EditorView.contentAttributes.of({ "aria-label": label }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !applyingExternal.current) {
              onChangeRef.current?.(update.state.doc.toString());
            }
            if (update.focusChanged && !update.view.hasFocus) onBlurRef.current?.();
          }),
        ],
      }),
    });
    viewRef.current = view;

    return () => {
      viewRef.current = null;
      view.destroy();
    };
    // Mount once per LANGUAGE. `value`, `readOnly` and `label` are synced by the effects
    // below; rebuilding the view on every prop change would discard the undo history. A
    // language change means a different parameter is the subject, so a fresh view (and a
    // fresh history) is the correct behavior, not a loss.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language]);

  // External value changes (node switch, undo of the graph, agent edit) replace the doc.
  useEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    applyingExternal.current = true;
    try {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    } finally {
      applyingExternal.current = false;
    }
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    view.dispatch({
      effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(readOnly)),
    });
  }, [readOnly]);

  useEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    const length = view.state.doc.length;
    const list: Diagnostic[] = (markers ?? []).map((marker) => ({
      from: Math.min(marker.from, length),
      to: Math.min(Math.max(marker.to, marker.from), length),
      severity: marker.severity,
      message: marker.message,
    }));
    view.dispatch(setDiagnostics(view.state, list));
  }, [markers]);

  return (
    <div
      ref={hostRef}
      className={cx(styles.editor, className)}
      data-keymap-context="text"
      data-testid="shader-editor-surface"
    />
  );
}
