/**
 * Right-click menus (T126/T127, §V78).
 *
 * What other tracks need from here:
 *  - `<ContextMenuHost bus fallbackSurface="canvas" selection toGraphPosition>` around a
 *    pane — ONE root for the whole pane; the target is resolved from the event on open.
 *  - `PARAMETER_KEY_ATTRIBUTE` / `PARAMETER_NODE_ATTRIBUTE` — the two attributes the
 *    inspector must put on a parameter row for the parameter menu to resolve.
 *  - `PLANNED_COMMANDS` — the commands these menus name that nobody has registered yet.
 *    They render disabled; registering one is all it takes to light it up.
 */

export { ContextMenuHost } from "./context-menu-host.tsx";
export type { ContextMenuHostProps } from "./context-menu-host.tsx";

export { PARAMETER_KEY_ATTRIBUTE, PARAMETER_NODE_ATTRIBUTE, resolveMenuTarget } from "./target.ts";
export type { ResolveMenuTargetOptions } from "./target.ts";

export {
  MENU_GUARD_NAMES,
  edgesForTarget,
  evaluateMenuGuard,
  isMenuGuardName,
  menuGuardValue,
  nodeForTarget,
  parameterDefault,
} from "./guards.ts";
export type { GuardVerdict, MenuContext, MenuGuardName } from "./guards.ts";

export { resolveMenuInput } from "./input.ts";
export type { MenuInputResolution } from "./input.ts";

export {
  EDGE_MENU,
  NODE_MENU,
  PARAMETER_MENU,
  PLANNED_COMMANDS,
  PORT_MENU,
  TOGGLE_GUARD,
  addNodeSubmenu,
  canvasMenu,
  menuSchemaFor,
} from "./schemas.ts";
export type { PlannedCommandName } from "./schemas.ts";
