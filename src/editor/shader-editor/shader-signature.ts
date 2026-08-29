import type { ShaderCompileRequest } from "./compile-types.ts";

/**
 * Cache key derivation (doc §9.3: "cache by normalized shader text, entry points, target
 * signature, constants, and binding layout").
 *
 * Normalisation is deliberately shallow: line endings and trailing whitespace only.
 * Stripping comments would widen the cache, but doing it correctly needs a real WGSL
 * lexer (nested block comments, `//` inside a would-be token), and a *wrong* strip makes
 * two different shaders share a key — which serves the user a stale program and looks
 * like a compiler bug. Cheap and provably safe beats clever here.
 */
export function normalizeShaderSource(source: string): string {
  return source
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
}

function bindingKey(request: ShaderCompileRequest): string {
  // Sorted: the layout is a set, not a sequence — reordering the same bindings must not
  // miss the cache, but changing a group, binding or resource class must.
  return request.bindingLayout
    .map((binding) => `${binding.group}.${binding.binding}:${binding.kind}`)
    .slice()
    .sort()
    .join(",");
}

function constantKey(request: ShaderCompileRequest): string {
  return Object.entries(request.constants)
    .map(([name, value]) => `${name}=${value}`)
    .sort()
    .join(",");
}

/**
 * A stable string identifying the compiled artifact a request would produce.
 * `nodeId` is intentionally absent: two nodes with identical shaders share one compile.
 */
export function shaderSignature(request: ShaderCompileRequest): string {
  return JSON.stringify({
    source: normalizeShaderSource(request.source),
    entryPoints: request.entryPoints.slice().sort(),
    target: request.targetSignature,
    constants: constantKey(request),
    bindings: bindingKey(request),
  });
}
