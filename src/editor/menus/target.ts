import type { MenuTarget } from "@domain/types/menus.ts";

/**
 * Resolving what was right-clicked (T126, §V78).
 *
 * ONE menu root sits over a whole pane and asks this module what the click landed on.
 * The alternative — a Radix root per node — costs a portal, a context and a subscription
 * per node on a graph that is meant to hold hundreds of them, which is exactly why the
 * canvas track declined to build it that way.
 *
 * Nothing here invents a marker. The graph canvas already ships React Flow's own DOM
 * contract on every node, edge and port handle, and those attributes are what we read:
 *
 *   node    `.react-flow__node[data-id="<nodeId>"]`
 *   edge    `.react-flow__edge[data-id="<edgeId>"]`
 *   port    `.react-flow__handle[data-nodeid="…"][data-handleid="…"]`
 *
 * The parameter surface is the one exception: the inspector renders no per-parameter
 * marker today, so the two attributes below are a REQUEST to the inspector track, not
 * something it already sets. Until it does, a right-click in the inspector resolves to
 * nothing and no menu opens — it does not throw and it does not guess a parameter.
 */

/** React Flow's own markers. Changing these means React Flow changed, not us. */
const NODE_CLASS = "react-flow__node";
const EDGE_CLASS = "react-flow__edge";
const HANDLE_CLASS = "react-flow__handle";
const RF_ID = "data-id";
const HANDLE_NODE_ID = "data-nodeid";
const HANDLE_PORT_ID = "data-handleid";

/** Ours: the inspector must put these on a parameter row for the parameter menu. */
export const PARAMETER_KEY_ATTRIBUTE = "data-parameter-key";
export const PARAMETER_NODE_ATTRIBUTE = "data-node-id";

export interface ResolveMenuTargetOptions {
  /**
   * Surface for a click that landed on nothing marked — "canvas" for the graph pane.
   * `null`/omitted means such a click resolves to nothing and no menu opens.
   */
  fallback?: MenuTarget["surface"] | null;
  /** Graph-space click position, so "add node here" lands under the cursor. */
  position?: { x: number; y: number };
  /** Stop walking here (the menu host's own element). */
  boundary?: Element | null;
}

function attribute(element: Element, name: string): string | null {
  const value = element.getAttribute(name);
  return value === null || value === "" ? null : value;
}

/**
 * The first marker found walking OUT from the clicked element wins, which is what makes
 * a click on a port resolve to the port and not to the node that contains it.
 */
function surfaceOf(element: Element): MenuTarget | null {
  const classes = element.classList;

  if (classes.contains(HANDLE_CLASS)) {
    const nodeId = attribute(element, HANDLE_NODE_ID);
    const portId = attribute(element, HANDLE_PORT_ID);
    if (nodeId !== null && portId !== null) return { surface: "port", nodeId, portId };
  }

  const parameterKey = attribute(element, PARAMETER_KEY_ATTRIBUTE);
  if (parameterKey !== null) {
    const owner = element.closest(`[${PARAMETER_NODE_ATTRIBUTE}]`);
    const nodeId = owner === null ? null : attribute(owner, PARAMETER_NODE_ATTRIBUTE);
    // A parameter with no owning node is not addressable: the reset/publish commands
    // need the node id, so resolving without one would build a half-formed command.
    if (nodeId !== null) return { surface: "parameter", nodeId, parameterKey };
  }

  if (classes.contains(NODE_CLASS)) {
    const nodeId = attribute(element, RF_ID);
    if (nodeId !== null) return { surface: "node", nodeId };
  }

  if (classes.contains(EDGE_CLASS)) {
    const edgeId = attribute(element, RF_ID);
    if (edgeId !== null) return { surface: "edge", edgeId };
  }

  return null;
}

/**
 * Walks up from the clicked element to the nearest marked ancestor. Returns `null` when
 * nothing matched and no fallback surface was given — the caller then opens no menu.
 */
export function resolveMenuTarget(
  start: Element | null,
  options: ResolveMenuTargetOptions = {},
): MenuTarget | null {
  const { fallback = null, position, boundary = null } = options;
  const withPosition = (target: MenuTarget): MenuTarget =>
    position === undefined ? target : { ...target, position: { x: position.x, y: position.y } };

  let element: Element | null = start;
  while (element !== null) {
    const found = surfaceOf(element);
    if (found !== null) return withPosition(found);
    if (element === boundary) break;
    element = element.parentElement;
  }

  return fallback === null ? null : withPosition({ surface: fallback });
}
