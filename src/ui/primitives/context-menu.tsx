import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import type { ComponentProps } from "react";
import { cx } from "../cx.ts";
import styles from "./context-menu.module.css";

export const ContextMenuRoot = ContextMenuPrimitive.Root;
export const ContextMenuTrigger = ContextMenuPrimitive.Trigger;
export const ContextMenuSub = ContextMenuPrimitive.Sub;

export type ContextMenuContentProps = ComponentProps<typeof ContextMenuPrimitive.Content>;
export type ContextMenuItemProps = ComponentProps<typeof ContextMenuPrimitive.Item> & {
  /** Destructive actions (delete node, clear graph) get the error highlight. */
  danger?: boolean;
};

export function ContextMenuContent({ className, ...rest }: ContextMenuContentProps) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content
        className={cx(styles.content, className)}
        collisionPadding={8}
        {...rest}
      />
    </ContextMenuPrimitive.Portal>
  );
}

export function ContextMenuItem({ className, danger = false, ...rest }: ContextMenuItemProps) {
  return (
    <ContextMenuPrimitive.Item
      className={cx(styles.item, danger && styles.itemDanger, className)}
      {...rest}
    />
  );
}

export function ContextMenuLabel({
  className,
  ...rest
}: ComponentProps<typeof ContextMenuPrimitive.Label>) {
  return <ContextMenuPrimitive.Label className={cx(styles.label, className)} {...rest} />;
}

export function ContextMenuSeparator({
  className,
  ...rest
}: ComponentProps<typeof ContextMenuPrimitive.Separator>) {
  return <ContextMenuPrimitive.Separator className={cx(styles.separator, className)} {...rest} />;
}

/** Right-aligned keybinding hint inside an item. Monospace, dimmed. */
export function ContextMenuShortcut({ className, ...rest }: ComponentProps<"span">) {
  return <span className={cx(styles.shortcut, className)} {...rest} />;
}
