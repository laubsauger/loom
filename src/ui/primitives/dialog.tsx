import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { ComponentProps } from "react";
import { cx } from "../cx.ts";
import styles from "./dialog.module.css";

export const DialogRoot = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export type DialogContentProps = ComponentProps<typeof DialogPrimitive.Content>;

/**
 * Modal surface for confirmations and capability grants (§C agent authority).
 * Radix supplies the focus trap, Escape handling and focus restore (V19);
 * every dialog must still render a `DialogTitle` for the accessible name.
 */
export function DialogContent({ className, children, ...rest }: DialogContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className={styles.overlay} />
      <DialogPrimitive.Content className={cx(styles.content, className)} {...rest}>
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogTitle({ className, ...rest }: ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title className={cx(styles.title, className)} {...rest} />;
}

export function DialogDescription({
  className,
  ...rest
}: ComponentProps<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description className={cx(styles.description, className)} {...rest} />;
}

export function DialogFooter({ className, ...rest }: ComponentProps<"div">) {
  return <div className={cx(styles.footer, className)} {...rest} />;
}
