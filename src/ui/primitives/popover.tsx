import * as PopoverPrimitive from "@radix-ui/react-popover";
import type { ComponentProps } from "react";
import { cx } from "../cx.ts";
import styles from "./popover.module.css";

/*
 * T1315b — these are Radix's own components, re-exported under Loom names. Written as
 * `export const X = Primitive.Y` the react-refresh rule sees a member expression and
 * calls it a non-component export (it can only recognise a component by name+shape);
 * as a re-export SPECIFIER it recognises the capitalised name and is satisfied. Same
 * binding either way — this is the honest spelling, not a suppression.
 */
export {
  Root as PopoverRoot,
  Trigger as PopoverTrigger,
  Anchor as PopoverAnchor,
  Close as PopoverClose,
} from "@radix-ui/react-popover";

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
