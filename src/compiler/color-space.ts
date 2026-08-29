import type { NodeId, PortId } from "../domain/types/ids.ts";
import type { RuntimeDiagnostic } from "../domain/types/diagnostics.ts";
import type { TextureFormat } from "../domain/types/node-definition.ts";
import { CompilerDiagnosticCode, compilerDiagnostic } from "./diagnostics.ts";

/**
 * Colour space propagation (doc §16.2).
 *
 * The working space is linear. Encoded (sRGB) pixels are decoded on import, encoded again
 * only at the display output, and data textures — masks, normals, IDs, depth — bypass
 * conversion entirely. Getting this wrong does not crash anything; it just makes every
 * composite subtly wrong, which is why it is tracked rather than assumed.
 *
 * `PortType.texture2d` does not carry `space` yet (it lands at the wave-2 barrier), so the
 * compiler carries it as its own field, derived from the resolved format and inherited with
 * exactly the same precedence. When the port type grows the field, this module reads it
 * from there instead and nothing else moves.
 */
export type ColorSpace = "linear" | "encoded" | "data";

/**
 * The space a format implies when nothing upstream says otherwise.
 *
 * An `-srgb` format IS the encoding, a single-channel float is data by construction, and
 * everything else is working-space linear.
 */
export function colorSpaceForFormat(format: TextureFormat): ColorSpace {
  if (format.endsWith("-srgb")) return "encoded";
  if (format === "r32float" || format === "depth24plus") return "data";
  return "linear";
}

export interface ColorSpaceRequest {
  readonly nodeId: NodeId;
  readonly nodeType: string;
  /** Spaces arriving on each connected input, in declaration order. */
  readonly inputs: ReadonlyArray<{ readonly portId: PortId; readonly space: ColorSpace }>;
  /** Space implied by the format this node resolved to. */
  readonly resolved: ColorSpace;
  /** True when the node's format came from an input rather than from a policy or override. */
  readonly inherited: boolean;
}

export interface ColorSpaceOutcome {
  readonly space: ColorSpace;
  readonly diagnostics: ReadonlyArray<RuntimeDiagnostic>;
}

/**
 * §V13 in colour terms: mixing an encoded input with a linear one is a missing conversion
 * node, not something to paper over. The compiler names the mismatch and keeps going — it
 * never inserts a conversion the user cannot see.
 */
export function resolveColorSpace(request: ColorSpaceRequest): ColorSpaceOutcome {
  const { nodeId, nodeType, inputs, resolved, inherited } = request;
  const diagnostics: RuntimeDiagnostic[] = [];

  // Data inputs are exempt: a mask alongside a colour layer is normal, not a mismatch.
  const colorInputs = inputs.filter((input) => input.space !== "data");
  const distinct = [...new Set(colorInputs.map((input) => input.space))].sort();

  if (distinct.length > 1) {
    diagnostics.push(
      compilerDiagnostic(
        "warning",
        CompilerDiagnosticCode.colorSpaceMismatch,
        `Node "${nodeId}" (${nodeType}) mixes ${distinct.join(" and ")} inputs: ${colorInputs
          .map((input) => `"${input.portId}" is ${input.space}`)
          .join(", ")}.`,
        {
          nodeId,
          suggestion:
            "Insert an explicit colour-space conversion node on the odd input; the compiler never converts silently (§V13, doc §16.2).",
        },
      ),
    );
  }

  const first = colorInputs[0];
  const space = inherited && first !== undefined ? first.space : resolved;
  return { space, diagnostics };
}
