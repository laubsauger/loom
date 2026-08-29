import * as TabsPrimitive from "@radix-ui/react-tabs";
import type { ComponentProps } from "react";
import { cx } from "../cx.ts";
import styles from "./tabs.module.css";

export type TabsRootProps = ComponentProps<typeof TabsPrimitive.Root>;
export type TabsListProps = ComponentProps<typeof TabsPrimitive.List>;
export type TabsTriggerProps = ComponentProps<typeof TabsPrimitive.Trigger>;
export type TabsContentProps = ComponentProps<typeof TabsPrimitive.Content>;

export function TabsRoot({ className, ...rest }: TabsRootProps) {
  return <TabsPrimitive.Root className={cx(styles.root, className)} {...rest} />;
}

/**
 * Radix roving tabindex: one tab stop for the whole list, arrow keys move
 * between tabs, Home/End jump to the ends (V19).
 */
export function TabsList({ className, ...rest }: TabsListProps) {
  return <TabsPrimitive.List className={cx(styles.list, className)} {...rest} />;
}

export function TabsTrigger({ className, ...rest }: TabsTriggerProps) {
  return <TabsPrimitive.Trigger className={cx(styles.trigger, className)} {...rest} />;
}

export function TabsContent({ className, ...rest }: TabsContentProps) {
  return <TabsPrimitive.Content className={cx(styles.content, className)} {...rest} />;
}

export interface TabBadgeProps extends ComponentProps<"span"> {
  tone?: "neutral" | "warn" | "error";
}

/** Count chip for a tab label (problems, passes). Monospace, like all numerics. */
export function TabBadge({ tone = "neutral", className, ...rest }: TabBadgeProps) {
  const toneClass =
    tone === "error" ? styles.badgeError : tone === "warn" ? styles.badgeWarn : undefined;
  return <span className={cx(styles.badge, toneClass, className)} {...rest} />;
}
