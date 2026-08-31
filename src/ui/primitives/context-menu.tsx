import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import type { ComponentProps } from "react";
import { useRef } from "react";
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
  /**
   * T524/B107, narrowed by B120 — pressing an item inside a NESTED submenu closed the
   * whole branch before the release could select it. Radix's SubContent closes itself
   * on "focus outside", detected by a flag that React's own focus-capture is supposed
   * to set as focus moves through the PORTALLED sub tree — and under React 19.2 the
   * pointerdown-driven focus lands before that flag does, so the parent sub reads its
   * child's item as OUTSIDE, closes (data-state="closed" mid-press), and the pointerup
   * finds nothing to select. Keyboard selection always worked; only the pointer path
   * died, which is why every jsdom test stayed green.
   *
   * The veto MUST NOT be unconditional (B120): focus moving to a SIBLING category's
   * submenu is the legitimate close — an unconditional preventDefault left every
   * browsed submenu standing, stacked over the next. So the veto holds only while a
   * pointer press is active INSIDE THIS submenu's own React subtree. React portal
   * events bubble through the REACT tree, so this capture handler sees a press in its
   * own portalled children (the T524 case: the whole ancestor branch of the pressed
   * item vetoes) — and does NOT see a press on a sibling trigger, which lives in the
   * parent content's subtree, so browsing closes exactly as Radix intends.
   */
  const pointerPressInside = useRef(false);
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.SubContent
        className={cx(styles.content, className)}
        onPointerDownCapture={() => {
          pointerPressInside.current = true;
          // The matching release can land anywhere (drag out, item removed mid-press).
          window.addEventListener(
            "pointerup",
            () => {
              pointerPressInside.current = false;
            },
            { once: true, capture: true },
          );
        }}
        onFocusOutside={(event) => {
          if (pointerPressInside.current) event.preventDefault();
        }}
        {...rest}
      />
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
