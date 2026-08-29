import type { CSSProperties } from "react";

/**
 * Inline CSS custom properties.
 *
 * Components never write a colour, only a token reference (§V17), and the value they
 * write is almost always a `var(--port-*)` chosen from data. React sets `--*` keys with
 * `style.setProperty`; the cast is only needed because `CSSProperties` has no index
 * signature for custom properties.
 */
export function cssVars(vars: Record<string, string | number>): CSSProperties {
  return vars as CSSProperties;
}
