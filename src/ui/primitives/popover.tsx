import * as PopoverPrimitive from "@radix-ui/react-popover";
import type { ComponentProps } from "react";
import { cx } from "../cx.ts";
import styles from "./popover.module.css";

export const PopoverRoot = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;
export const PopoverClose = PopoverPrimitive.Close;

export type PopoverContentProps = ComponentProps<typeof PopoverPrimitive.Content>;

/**
 * Radix handles the focus trap, Escape-to-close and focus restoration to the
 * trigger, which is the whole V19 story for a popover.
 */
export function PopoverContent({
  className,
  sideOffset = 6,
  children,
  ...rest
}: PopoverContentProps) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        className={cx(styles.content, className)}
        sideOffset={sideOffset}
        collisionPadding={8}
        {...rest}
      >
        {children}
        <PopoverPrimitive.Arrow className={styles.arrow} width={10} height={5} />
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  );
}

/** Small caps-ish header row for a popover body. */
export function PopoverHeader({ className, ...rest }: ComponentProps<"div">) {
  return <div className={cx(styles.header, className)} {...rest} />;
}
