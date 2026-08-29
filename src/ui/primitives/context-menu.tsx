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

/**
 * Sub-menu and toggle parts (U11). The graph canvas needs bypass/mute checkboxes and
 * an add-node submenu; without these a track would either fork the primitive or reach
 * for raw Radix and lose the token styling.
 */
export type ContextMenuSubTriggerProps = ComponentProps<typeof ContextMenuPrimitive.SubTrigger>;

export function ContextMenuSubTrigger({ className, ...rest }: ContextMenuSubTriggerProps) {
  return <ContextMenuPrimitive.SubTrigger className={cx(styles.item, styles.subTrigger, className)} {...rest} />;
}

export type ContextMenuSubContentProps = ComponentProps<typeof ContextMenuPrimitive.SubContent>;

export function ContextMenuSubContent({ className, ...rest }: ContextMenuSubContentProps) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.SubContent className={cx(styles.content, className)} {...rest} />
    </ContextMenuPrimitive.Portal>
  );
}

export type ContextMenuCheckboxItemProps = ComponentProps<typeof ContextMenuPrimitive.CheckboxItem>;

export function ContextMenuCheckboxItem({ className, children, ...rest }: ContextMenuCheckboxItemProps) {
  return (
    <ContextMenuPrimitive.CheckboxItem className={cx(styles.item, styles.toggleItem, className)} {...rest}>
      <span className={styles.toggleMark} aria-hidden="true">
        <ContextMenuPrimitive.ItemIndicator>✓</ContextMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </ContextMenuPrimitive.CheckboxItem>
  );
}

export const ContextMenuRadioGroup = ContextMenuPrimitive.RadioGroup;

export type ContextMenuRadioItemProps = ComponentProps<typeof ContextMenuPrimitive.RadioItem>;

export function ContextMenuRadioItem({ className, children, ...rest }: ContextMenuRadioItemProps) {
  return (
    <ContextMenuPrimitive.RadioItem className={cx(styles.item, styles.toggleItem, className)} {...rest}>
      <span className={styles.toggleMark} aria-hidden="true">
        <ContextMenuPrimitive.ItemIndicator>•</ContextMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </ContextMenuPrimitive.RadioItem>
  );
}
