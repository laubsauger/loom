import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { ComponentProps } from "react";
import { cx } from "../cx.ts";
import styles from "./dialog.module.css";

/*
 * T1315b — these are Radix's own components, re-exported under Loom names. Written as
 * `export const X = Primitive.Y` the react-refresh rule sees a member expression and
 * calls it a non-component export (it can only recognise a component by name+shape);
 * as a re-export SPECIFIER it recognises the capitalised name and is satisfied. Same
 * binding either way — this is the honest spelling, not a suppression.
 */
export {
  Root as DialogRoot,
  Trigger as DialogTrigger,
  Close as DialogClose,
} from "@radix-ui/react-dialog";

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
