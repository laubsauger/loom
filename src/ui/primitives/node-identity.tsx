import { cx } from "../cx.ts";
import styles from "./node-identity.module.css";

export interface TypeBadgeProps {
  /** The machine type or capability the badge names. Rendered verbatim. */
  label: string;
  /** T964's subtle tint, keyed off a declared category. Absent means the default. */
  readonly category?: string | undefined;
  /** Layout the surface owns. The badge's own chrome is NOT the surface's to restate. */
  className?: string | undefined;
  /** Hover copy, per §V90 — help hangs off the label, on demand. */
  title?: string | undefined;
  /**
   * What the badge IS, for surfaces that are asked "which of these words is the machine
   * type?". `NodeIdentity` marks its badge as the addressable name; a surface naming
   * something else (a derived facet, say) passes its own attribute or none.
   */
  readonly machineType?: string | undefined;
}

/**
 * The small quiet badge — T954's chrome, extracted so it can be WORN rather than copied.
 *
 * ⚑ EXTRACTED BECAUSE `NodeIdentity`'S OWN DOCBLOCK ASKED FOR IT: "share the STRUCTURE,
 * not just the stylesheet, or the surfaces drift apart again." The example library had
 * grown its own pill — same intent, different border radius, its own line height, a
 * hand-kept colour — and the owner read the two side by side and said so. A second
 * implementation of a badge is a second answer to "what does a facet look like here".
 *
 * The badge owns border, radius, mono, size, case and tint. The surface owns layout and
 * nothing else.
 */
export function TypeBadge({ label, category, className, title, machineType }: TypeBadgeProps) {
  return (
    <span
      {...(category === undefined ? {} : { "data-category": category })}
      className={cx(styles.type, className)}
      {...(machineType === undefined ? {} : { "data-machine-type": machineType })}
      {...(title === undefined ? {} : { title })}
    >
      {label}
    </span>
  );
}

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
      {/*
        The badge is the ADDRESSABLE name — marked in the DOM so a surface can be asked
        "which of these words is the machine type?" without guessing at classes.
      */}
      <TypeBadge
        label={type}
        machineType={type}
        {...(category === undefined ? {} : { category })}
        {...(typeClassName === undefined ? {} : { className: typeClassName })}
        {...(typeTitle === undefined ? {} : { title: typeTitle })}
      />
    </>
  );
}
