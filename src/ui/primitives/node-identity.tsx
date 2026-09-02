import { cx } from "../cx.ts";
import styles from "./node-identity.module.css";

export interface NodeIdentityProps {
  /**
   * T964: the node's declared category, rendered as a subtle tint on the type badge.
   * Derived from the definition rather than a hand-kept colour map, so a new category
   * cannot drift out of sync — it simply gets the default until someone gives it a hue.
   */
  readonly category?: string | undefined;
  /**
   * What the thing is CALLED — the node's label, or a definition's title. The
   * prominent half.
   */
  name: string;
  /**
   * The machine type (`geometry`, `blur`). Quiet, but never absent: it is what an
   * agent, the MCP tools and the docs address a node BY.
   */
  type: string;
  /**
   * Layout/typography the surface owns (grid sizing, its own type scale). `| undefined`
   * because a CSS-module class reads as `string | undefined` under
   * `exactOptionalPropertyTypes`.
   */
  nameClassName?: string | undefined;
  typeClassName?: string | undefined;
  /** Hover copy, per §V90 — help hangs off the label, on demand. */
  nameTitle?: string | undefined;
  typeTitle?: string | undefined;
}

/**
 * Name + type badge — T954.
 *
 * One arrangement for every surface that names a node or a node type: the NAME first
 * and primary, the machine type after it as a small quiet badge. The inspector used to
 * invert it (the type's display name bold, the same type again in machine form, and the
 * node's actual identity dim and far right), which contradicted the graph node header
 * the user had just clicked from — two surfaces, two answers to "what is this called".
 *
 * Rendered as a FRAGMENT, not a wrapper: the inspector header is a flex row and a
 * library row is a two-column grid, so the pair has to be direct children of whatever
 * lays them out. What is shared is the ORDER, the badge, and the truncation rule; what
 * each surface keeps is its own layout and type scale, handed in as class names.
 *
 * §T877's lesson applied one layer up: share the structure, not just the stylesheet,
 * or the surfaces drift apart again.
 */
export function NodeIdentity({
  name,
  type,
  category,
  nameClassName,
  typeClassName,
  nameTitle,
  typeTitle,
}: NodeIdentityProps) {
  return (
    <>
      <span
        className={cx(styles.name, nameClassName)}
        {...(nameTitle === undefined ? {} : { title: nameTitle })}
      >
        {name}
      </span>
      <span
        {...(category === undefined ? {} : { "data-category": category })}
        className={cx(styles.type, typeClassName)}
        // The badge is the ADDRESSABLE name — marked in the DOM so a surface can be
        // asked "which of these words is the machine type?" without guessing at classes.
        data-machine-type={type}
        {...(typeTitle === undefined ? {} : { title: typeTitle })}
      >
        {type}
      </span>
    </>
  );
}
