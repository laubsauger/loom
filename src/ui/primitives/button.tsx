import type { ComponentProps } from "react";
import { cx } from "../cx.ts";
import styles from "./button.module.css";

export interface ButtonProps extends ComponentProps<"button"> {
  variant?: "ghost" | "outline" | "danger";
  size?: "sm" | "md";
}

/**
 * Chrome button: toolbar, dialog footer, pane header action.
 * Native `<button>` on purpose — it is focusable, Enter/Space activated and
 * announced without any extra work (V19). Parameter controls are a separate
 * kit and live in `src/ui/controls/`.
 */
export function Button({
  variant = "ghost",
  size = "sm",
  type = "button",
  className,
  ...rest
}: ButtonProps) {
  const variantClass =
    variant === "outline" ? styles.outline : variant === "danger" ? styles.danger : undefined;
  return (
    <button
      type={type}
      className={cx(styles.button, variantClass, size === "md" && styles.md, className)}
      {...rest}
    />
  );
}
