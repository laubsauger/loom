import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type { ComponentProps, ReactNode } from "react";
import { cx } from "../cx.ts";
import styles from "./tooltip.module.css";

export const TooltipProvider = TooltipPrimitive.Provider;
export const TooltipRoot = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export type TooltipContentProps = ComponentProps<typeof TooltipPrimitive.Content>;

export function TooltipContent({
  className,
  sideOffset = 6,
  children,
  ...rest
}: TooltipContentProps) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        className={cx(styles.content, className)}
        sideOffset={sideOffset}
        {...rest}
      >
        {children}
        <TooltipPrimitive.Arrow className={styles.arrow} width={8} height={4} />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

export interface TooltipProps {
  /** Tooltip body. Kept short — this is a hint, not documentation. */
  label: ReactNode;
  side?: TooltipContentProps["side"];
  /** The trigger. Rendered with `asChild`, so pass a single focusable element. */
  children: ReactNode;
}

/**
 * Convenience wrapper for the 95% case. Radix keeps the trigger keyboard
 * reachable and shows the tooltip on focus as well as hover (V19).
 * Requires a `TooltipProvider` above it (the app shell mounts one).
 */
export function Tooltip({ label, side = "bottom", children }: TooltipProps) {
  return (
    <TooltipRoot>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
    </TooltipRoot>
  );
}
