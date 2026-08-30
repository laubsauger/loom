import type { PortKind, PortType } from "@domain/types/ports.ts";

/**
 * Port family → CSS custom property (§C, V26).
 *
 * The record is keyed by `PortKind`, so adding a member to the `PortType` union
 * without giving it a color is a type error, and V26 (edge hue = source port
 * family color) can never fall back to an arbitrary color.
 */
export const PORT_FAMILY_VAR: Readonly<Record<PortKind, string>> = {
  texture2d: "--port-texture2d",
  buffer: "--port-buffer",
  scalar: "--port-scalar",
  vector: "--port-vector",
  matrix: "--port-matrix",
  // A pointset is one model for meshes and particles; blue reads as "structure".
  pointset: "--port-pointset",
  scene: "--port-scene",
  material: "--port-material",
  camera: "--port-camera",
  light: "--port-light",
  transform3d: "--port-transform3d",
  event: "--port-event",
  audioFeatures: "--port-audioFeatures",
  // The CHOP wire (T273): number-family, one tier lighter than scalar so a value
  // chain reads as its own layer across the canvas.
  value: "--port-value",
};

/** `var(--port-*)` for a port kind. Never a literal color (V17). */
export function portFamilyColor(kind: PortKind): string {
  return `var(${PORT_FAMILY_VAR[kind]})`;
}

/** Convenience for the common case: color of a typed port / of its edges. */
export function portTypeColor(type: PortType): string {
  return portFamilyColor(type.kind);
}
