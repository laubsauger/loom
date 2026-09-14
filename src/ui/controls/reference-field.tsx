import type { CSSProperties } from "react";
import { cx } from "../cx.ts";
import { NodeIdentity, TypeBadge } from "../primitives/node-identity.tsx";
import { EnumField } from "./enum-field.tsx";
import type { ValueListener } from "./types.ts";
import styles from "./controls.module.css";

/**
 * A parameter that NAMES another node — T987.
 *
 * ## The defect this replaces
 *
 * Seven parameters in the catalogue hold a node's name instead of taking a wire
 * (`SOURCE_REFERENCE_PARAMETERS`): a Feedback's source, a Geometry's material, a Render's
 * camera/scenes/lights/projectors, and the two point renderers' camera. The compiler
 * turns each name into a synthesized edge (§V373) and the canvas draws the relationship
 * as a dashed, hued line (T248), so the plumbing has always worked. Every one of them was
 * declared `type: "string"`, so every one of them rendered as a PLAIN TEXT BOX.
 *
 * The owner, looking at Render Instances: *"render instances is missing an actual visible
 * parameter that shows where it gets positions from… i cant see where the lfo reference
 * is actually wired to. we must have forgotten the ui param but actually have the
 * plumbing in place since the example works and we see the dashed reference line."*
 *
 * ⚑ THE PARAMETER WAS NOT MISSING. IT WAS UNRECOGNISABLE. A reference lived in a string
 * field, and a string field looks like text, not like a connection: no shared colour with
 * the line it causes, no picker, and nothing naming what the name resolved TO. The owner
 * read the screen correctly and drew the only conclusion it offered.
 *
 * ## What makes this read as a reference rather than as text
 *
 *  - THE HUE IS THE LINE'S HUE. `REFERENCE_KIND_COLOR` — the one table the canvas strokes
 *    its dashed line from — arrives as `color` and paints a short DASHED rule beside every
 *    named reference. The mark is literally the line, at row scale, in the same token.
 *    That is the tie the owner went looking for and could not find, and it is ONE shared
 *    table rather than a matching pair of constants precisely so it cannot drift.
 *  - THE NAME IS RESOLVED, NOT ECHOED. What is offered and what is shown carry the
 *    referenced node's TYPE beside its name, so the panel says `cam1 — camera` where the
 *    text box said `cam1`; and a name matching no node in the document says *no such node*
 *    instead of looking exactly like a working one (§V369's refusal, at the control).
 *  - IT IS A PICKER. `EnumField` offers the nodes this parameter may legally name — the
 *    affordance a text box lacked. A reference is a CHOICE among what exists, and the name
 *    is the one thing on this row that cannot be guessed.
 *
 * ## Why not a new `ParameterDefinition` type
 *
 * There is nothing for one to declare. `NodeDefinition.sourceReferences` already states
 * which parameters carry names and which input the synthesized edge feeds, and the port
 * behind that input already declares the KIND it accepts — so "this is a reference" and
 * "a camera is what it takes" are both on record. A `type: "reference"` would restate them
 * in a third place and drag persistence, migrations and the agent schemas through a change
 * that adds no fact. The stored value stays a plain string, so no document moves.
 *
 * ## Lists
 *
 * Three of the seven hold an ORDERED list of names (draw order, light order). The picker
 * appends and each chip removes, which keeps ONE control over one document field — a
 * select beside a text box is exactly the two-controls-one-field wart §T811 filed and
 * §T994 fixed for the device parameters.
 */

export interface ReferenceTargetView {
  /** The name as WRITTEN in the parameter (§B170: a node's label, never its id). */
  readonly name: string;
  /** The named node's machine type, or null when the document has no node by that name. */
  readonly type: string | null;
}

export interface ReferenceCandidateView {
  readonly name: string;
  readonly type: string;
}

export interface ReferenceFieldProps {
  label: string;
  /**
   * The relationship's colour — `REFERENCE_KIND_COLOR[kind]`, the same entry the canvas
   * strokes the dashed line with. Handed in rather than looked up here because the table
   * lives with the lines, in `src/editor`, and this kit is the layer underneath.
   */
  color: string;
  /** What the parameter names right now, in written order. */
  targets: readonly ReferenceTargetView[];
  /** Every node this parameter may legally name, by name and machine type. */
  candidates: readonly ReferenceCandidateView[];
  /** True when the parameter holds an ordered LIST of names rather than one. */
  list: boolean;
  /** What the reference feeds, as the port declares it — `camera`, `material`, `scene`. */
  noun: string;
  disabled?: boolean;
  id?: string;
  describedBy?: string;
  /** The whole parameter string: one name, or the list joined by spaces. */
  onChange: ValueListener<string>;
}

/** What a name that resolves to nothing reads as, everywhere in this control. */
const NO_SUCH_NODE = "no such node";

/** The stored spelling of a list: space-separated, which is what `sourceReferenceTokens` splits. */
const joinNames = (names: readonly string[]): string => names.join(" ");

export function ReferenceField({
  label,
  color,
  targets,
  candidates,
  list,
  noun,
  disabled = false,
  id,
  describedBy,
  onChange,
}: ReferenceFieldProps) {
  const written = targets.map((target) => target.name);
  /*
   * A list's picker only ever offers what is NOT already named. A duplicate name is a
   * duplicate synthesized edge — the same geometry drawn twice, the same light counted
   * twice — so the option is absent rather than present-and-refused (§V830: no gesture
   * beats a gesture that declines).
   */
  const offered = list ? candidates.filter((entry) => !written.includes(entry.name)) : candidates;
  const optionFor = (entry: ReferenceCandidateView) => ({
    value: entry.name,
    label: `${entry.name} — ${entry.type}`,
  });

  /*
   * A single reference's select IS the value, so a dangling name has to be an OPTION or
   * the control cannot show what the document holds. It is spelled out here rather than
   * left to `EnumField`'s generic "(unknown)" fallback because "unknown" describes the
   * OPTION LIST, and the fact worth stating is about the DOCUMENT: nothing is called this.
   */
  const dangling = list ? [] : targets.filter((target) => target.type === null);

  const options = [
    ...dangling.map((target) => ({ value: target.name, label: `${target.name} — ${NO_SUCH_NODE}` })),
    list
      ? { value: "", label: offered.length === 0 ? `No ${noun} to add` : `Add ${noun}…` }
      : { value: "", label: candidates.length === 0 ? `No ${noun} in this document` : "— none —" },
    ...offered.map(optionFor),
  ];

  const pick = (name: string, phase: Parameters<ValueListener<string>>[1]): void => {
    if (!list) {
      onChange(name, phase);
      return;
    }
    if (name === "") return;
    onChange(joinNames([...written, name]), phase);
  };

  const remove = (name: string): void => {
    onChange(joinNames(written.filter((entry) => entry !== name)), "commit");
  };

  /*
   * The dashed mark: the canvas line, at row scale, in the canvas line's own colour. One
   * per NAMED reference — beside the select when the parameter holds a single name (the
   * select is the reference there), and on every chip when it holds a list (each chip is
   * its own line). `aria-hidden`, because the text beside it already says everything.
   */
  const dash = <span className={styles.referenceDash} aria-hidden />;

  return (
    <div
      className={styles.reference}
      data-reference-noun={noun}
      /*
       * The relationship's colour, as a custom property the stylesheet reads — so the
       * dashed mark is painted from the SAME token the canvas line is stroked with. §V17
       * holds: the value is the `var(--port-…)` reference handed down from
       * `REFERENCE_KIND_COLOR`, never a literal.
       */
      style={{ "--reference-hue": color } as CSSProperties}
    >
      {!list || targets.length === 0 ? null : (
        <ul className={styles.referenceChips}>
          {targets.map((target) => (
            <li
              className={cx(styles.referenceChip, target.type === null && styles.referenceDangling)}
              key={target.name}
              data-reference-target={target.name}
              {...(target.type === null ? { "data-reference-dangling": "true" } : {})}
            >
              {dash}
              {target.type === null ? (
                <>
                  <span className={styles.referenceName}>{target.name}</span>
                  {/*
                    A badge, but NOT `NodeIdentity`'s: that one marks its badge as the
                    node's addressable machine type, and there is no node here to address.
                    `TypeBadge` takes a label that is not an address exactly for this.
                  */}
                  <TypeBadge label={NO_SUCH_NODE} className={styles.referenceMissing} />
                </>
              ) : (
                <NodeIdentity
                  name={target.name}
                  type={target.type}
                  nameClassName={styles.referenceName}
                />
              )}
              <button
                type="button"
                className={cx(styles.referenceRemove, "nodrag")}
                aria-label={`Remove ${target.name} from ${label}`}
                disabled={disabled}
                onPointerDown={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
                onClick={() => remove(target.name)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className={styles.referencePick}>
        {list ? null : dash}
        <EnumField
          // A list's picker ADDS; its label has to say so, or the control announces itself
          // as the value it is not.
          label={list ? `Add to ${label}` : label}
          // Held at the empty option for a list, so the select falls back to "Add …" after
          // every pick instead of freezing on the last name added.
          value={list ? "" : (written[0] ?? "")}
          options={options}
          disabled={disabled}
          {...(id === undefined ? {} : { id })}
          {...(describedBy === undefined ? {} : { describedBy })}
          onChange={pick}
        />
      </div>
    </div>
  );
}
