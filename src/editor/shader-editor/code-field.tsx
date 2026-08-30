import { useRef, useState } from "react";
import { ShaderEditor } from "./shader-editor.tsx";
import styles from "./code-field.module.css";

export interface CodeFieldProps {
  id: string;
  label: string;
  value: string;
  language: "wgsl" | "json";
  disabled: boolean;
  onCommit: (next: string) => void;
}

/**
 * T492: the inline face of THE code editor — the same CodeMirror the shader pane
 * mounts (T356: one editor, never a second), compact enough for an inspector row,
 * committing when focus leaves exactly as the pane does. Enlarging is the pane's job:
 * the inspector row is where you tweak, the code pane is where you write.
 */
export function CodeField({ id, label, value, language, disabled, onCommit }: CodeFieldProps) {
  const [draft, setDraft] = useState(value);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // External change (undo, agent edit, node switch) replaces the buffer.
  const subjectRef = useRef(value);
  if (subjectRef.current !== value) {
    subjectRef.current = value;
    setDraft(value);
  }
  return (
    <div className={styles.field} data-parameter-code={id}>
      <ShaderEditor
        value={draft}
        language={language}
        onChange={setDraft}
        onBlur={() => {
          if (draftRef.current !== subjectRef.current) onCommit(draftRef.current);
        }}
        readOnly={disabled}
        label={label}
      />
    </div>
  );
}
