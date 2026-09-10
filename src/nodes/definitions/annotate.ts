import type { CompiledNodeDescription, NodeDefinition } from "../../domain/types/node-definition.ts";

/**
 * Annotate (T1262) — TD's Network Comment / annotate COMP: a resizable coloured box with
 * a title and a body that sits BEHIND the nodes to structure and annotate a graph.
 *
 * It is a NODE DEFINITION rather than a new document entity, and that is the whole
 * design: persistence, migrations, selection, copy/paste, undo, delete, agent tools and
 * the command bus all come free (§V29), and the compiler prunes it — no sink reaches a
 * node with no ports, so a document renders bit-for-bit the same with or without one
 * (`annotate.test.ts` pins the plan signature against E24).
 *
 * No ports, no `sink`, no passes. `compile()` exists because the interface requires it
 * and a headless manifest sweep calls it; it can never contribute GPU work.
 *
 * SIZE is `GraphNode.size` (§V116), not a parameter: the canvas already commits every
 * resize gesture as one `setNodeSize` patch, and a `width`/`height` pair here would be a
 * second source of truth for the same box. The view gives an unsized box a default.
 *
 * COLOUR is an ENUM OF TOKEN NAMES, never a free hex (§V17): the twelve `--category-*`
 * hues are the app's one named palette, and the view maps the name to
 * `var(--category-<name>)`. A stored colour no token knows falls back to `utility`.
 */

export const ANNOTATE_TYPE = "annotate";

/**
 * The palette, in the order the inspector offers it. Every value is the suffix of a
 * `--category-*` token in `src/ui/tokens.css`; `annotate.test.ts` pins that the two
 * lists agree, so a colour cannot be offered that the stylesheet cannot paint.
 */
export const ANNOTATION_COLORS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "utility", label: "Slate" },
  { value: "generator", label: "Blue" },
  { value: "input", label: "Teal" },
  { value: "filter", label: "Green" },
  { value: "value", label: "Sage" },
  { value: "shader", label: "Steel" },
  { value: "composite", label: "Violet" },
  { value: "temporal", label: "Lavender" },
  { value: "points", label: "Rose" },
  { value: "output", label: "Brick" },
  { value: "color", label: "Amber" },
  { value: "render", label: "Gold" },
];

export const DEFAULT_ANNOTATION_COLOR = "utility";

/** The stored colour, or the default when the value names no token. */
export function annotationColorOf(stored: unknown): string {
  return typeof stored === "string" && ANNOTATION_COLORS.some((option) => option.value === stored)
    ? stored
    : DEFAULT_ANNOTATION_COLOR;
}

export const annotateNode: NodeDefinition = {
  type: ANNOTATE_TYPE,
  version: 1,
  title: "Annotation",
  category: "utility",
  description:
    "A coloured note box that sits behind the nodes. Title, body and colour structure a graph; it renders nothing and the compiler skips it.",
  tags: ["comment", "note", "annotate", "structure"],
  inputs: [],
  outputs: [],
  parameters: {
    title: { type: "string", label: "Title", default: "Note" },
    body: {
      type: "string",
      label: "Body",
      default: "",
      multiline: true,
      description: "Free text, shown under the title. Newlines are kept.",
    },
    color: {
      type: "enum",
      label: "Colour",
      default: DEFAULT_ANNOTATION_COLOR,
      options: ANNOTATION_COLORS,
      description: "One of the app's named hues. The box takes the hue at low alpha and its border at full.",
    },
  },
  compile(): CompiledNodeDescription {
    return { passes: [] };
  },
};
