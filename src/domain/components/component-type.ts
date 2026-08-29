import type { ComponentId } from "../types/ids.ts";

/**
 * How a component instance names itself in the document (§V79, §V84).
 *
 * A component instance is an ordinary `GraphNode`. Its `type` is a synthesized node type
 * carrying BOTH the component identity and the pinned version:
 *
 *     component:<componentId>@<version>
 *
 * The version belongs in the type, not only in `definitionVersion`, because the node
 * registry is keyed by type alone. A component's port set can legitimately change between
 * versions, and `registry.port(type, portId, direction)` is handed a type and nothing
 * else — so if two versions shared one type, an instance pinned to v1 would be validated
 * against v2's ports. Pinning is only real if the lookup key carries the pin (§V84).
 *
 * `definitionVersion` mirrors the same number, because that is the field §V10 says every
 * serialized node carries.
 */

export const COMPONENT_TYPE_PREFIX = "component:";

export interface ComponentTypeRef {
  componentId: ComponentId;
  version: number;
}

/**
 * `componentId` may not contain `@` — that is the version separator, and an id carrying
 * one would make the type ambiguous. Ids we mint never do; ids arriving from a file are
 * checked on the way in (see `validateComponentDefinition`).
 */
export function isValidComponentId(componentId: string): boolean {
  return componentId.length > 0 && !componentId.includes("@") && componentId.trim() === componentId;
}

export function componentNodeType(componentId: ComponentId, version: number): string {
  return `${COMPONENT_TYPE_PREFIX}${componentId}@${version}`;
}

export function isComponentNodeType(type: string): boolean {
  return type.startsWith(COMPONENT_TYPE_PREFIX);
}

/** Parses a component node type, or null when `type` is an ordinary node type. */
export function parseComponentNodeType(type: string): ComponentTypeRef | null {
  if (!isComponentNodeType(type)) return null;
  const body = type.slice(COMPONENT_TYPE_PREFIX.length);
  const at = body.lastIndexOf("@");
  if (at <= 0) return null;
  const componentId = body.slice(0, at);
  const version = Number(body.slice(at + 1));
  if (!isValidComponentId(componentId)) return null;
  if (!Number.isInteger(version) || version < 1) return null;
  return { componentId, version };
}
