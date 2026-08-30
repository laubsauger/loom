/** Component editing surfaces (T130, T137). React lives here and nowhere else in track U. */

export { BreadcrumbTrail } from "./breadcrumb-trail.tsx";
export type { BreadcrumbTrailProps } from "./breadcrumb-trail.tsx";

export { ComponentInspector } from "./component-inspector.tsx";
export type { ComponentInspectorProps } from "./component-inspector.tsx";

export { installStarterComponents, readStarterComponents } from "./starter-set.ts";
export type { StarterSetInstall } from "./starter-set.ts";

export {
  resolveComponentNavigation,
  resolveComponentParameters,
  resolveInstanceValues,
} from "./component-scope.ts";
export type {
  ComponentNavigationInput,
  ComponentResolvedParameters,
  ResolveInComponentOptions,
} from "./component-scope.ts";
