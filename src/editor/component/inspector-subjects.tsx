import { useState } from "react";
import type { ReactNode } from "react";
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from "@ui/primitives/tabs.tsx";
import styles from "./component.module.css";

/**
 * TWO SUBJECTS, ONE AT A TIME (T1192).
 *
 * ## The state this replaces
 *
 * Inside a component the inspector pane rendered `ComponentPage` and then `Inspector`,
 * stacked in one scroll box, on the grounds that "both are true at once — you are editing
 * a component AND you have one of its nodes selected". Both ARE true; putting both on one
 * scroll was the mistake. Measured on E47's `DepthPoints_1` (nine published parameters, a
 * 366px-tall docked inspector): **2092px of component page above the selected node's first
 * parameter — 5.7 screens of scrolling to reach the thing you just clicked.** The owner:
 * *"it's bulky, very confusing and super shitty UX to have to scroll."*
 *
 * ## Why a subject switch and not a pane
 *
 * These are two SUBJECTS, not two pages of one subject. `Parameters | Common` (T269,
 * §V174) are pages of the selected NODE; the parameter page, the boundary ports and the
 * publish rows belong to the COMPONENT. So the switch sits ABOVE the node identity header
 * and the node's own tab strip, which are both part of the node subject — a single strip
 * carrying all three would leave the header naming `carve1` while the panel showed
 * `DepthPoints`.
 *
 * It exists ONLY inside a component. At the root there is one subject and this renders
 * nowhere, so the surface the user is looking at all day grows no chrome.
 *
 * ## Selection is the gesture; the switch is the override
 *
 * Clicking a node inside the component shows that node — the same thing clicking a node
 * does everywhere else in the app. Deselecting shows the component, which is what "click
 * empty space to see the container you are in" means. The switch is how you go against
 * that, and it is how you find out the other subject is there at all.
 *
 * ⚠ `nodeId` is the node THIS graph holds, resolved by the caller. Diving in leaves the
 * app's selection pointing at the INSTANCE, whose id belongs to the parent document — a
 * bare `!== null` test would open an empty node panel on the way in.
 *
 * ## Why the trail idiom
 *
 * The pane header above the canvas already reads `Main / DepthPoints_1`. This reads
 * `DepthPoints / carve1` — the same sentence one level further in, and the last crumb is
 * finally something you can click. What it does is different (it chooses a subject, it
 * does not navigate), so it carries the tab primitive's amber active marker, which the
 * breadcrumb has never had.
 */

export type InspectorSubject = "component" | "node";

export interface InspectorSubjectsProps {
  /** The component being edited — the container you are standing inside. */
  component: { name: string };
  /**
   * The selected node, ALREADY RESOLVED AGAINST THE COMPONENT'S OWN GRAPH. `null` means
   * nothing in here is selected, which is a normal state and not an error.
   *
   * `id` is not decoration: it is what tells a NEW selection from a re-render, and it is
   * the id in THIS graph, so it changes when — and only when — the user clicked something.
   */
  node: { id: string; name: string } | null;
  componentPage: ReactNode;
  nodeInspector: ReactNode;
}

export function InspectorSubjects({
  component,
  node,
  componentPage,
  nodeInspector,
}: InspectorSubjectsProps) {
  const nodeId = node?.id ?? null;
  const [subject, setSubject] = useState<InspectorSubject>(nodeId === null ? "component" : "node");

  /*
   * React's own "adjust state when a prop changes" pattern rather than an effect: an
   * effect would paint the previous subject for one frame, and the flash is exactly at
   * the moment of the click that changed the selection.
   */
  const [seenNodeId, setSeenNodeId] = useState<string | null>(nodeId);
  if (seenNodeId !== nodeId) {
    setSeenNodeId(nodeId);
    setSubject(nodeId === null ? "component" : "node");
  }

  return (
    <TabsRoot
      className={styles.subjectPages}
      value={subject}
      onValueChange={(next) => setSubject(next as InspectorSubject)}
    >
      {/*
        NAMES ONLY. Both panels already head themselves — `DepthPoints v1 editing` and
        `carve1 pointkernel` — and the first draft repeated the version and the type up
        here, one line above each. That is T954's own finding (say the type once) with the
        duplicate two rows apart instead of two words. What is left reads exactly like the
        breadcrumb over the canvas, which is the point.
      */}
      <TabsList className={styles.subjectTrail} aria-label="Inspector subject">
        <TabsTrigger className={styles.subject} value="component">
          {component.name}
        </TabsTrigger>
        <span className={styles.subjectSeparator} aria-hidden>
          /
        </span>
        <TabsTrigger className={styles.subject} value="node" disabled={node === null}>
          {/* §V91: name the STATE. Nothing is selected in here, which is why the panel
              beside it shows the component — not a failure to find a node. */}
          {node === null ? "No node selected" : node.name}
        </TabsTrigger>
      </TabsList>
      <TabsContent className={styles.subjectPanel} value="component">
        {componentPage}
      </TabsContent>
      <TabsContent className={styles.subjectPanel} value="node">
        {nodeInspector}
      </TabsContent>
    </TabsRoot>
  );
}
