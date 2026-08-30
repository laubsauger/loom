import { componentLibrarySchema, parseComponentDefinition } from "@domain/components/index.ts";
import type { ComponentRegistry } from "@domain/components/index.ts";
import type { GraphComponentDefinition } from "@domain/types/components.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";

/**
 * The starter component set, as the running app sees it (T190, §V94, §V193).
 *
 * `src/examples/catalogue.ts` walks `examples/components/` with `node:fs` for the headless
 * gate. This is the same directory read the only way a browser can read it — Vite inlines
 * each file at build time — and deliberately the SAME BYTES the gate checks, never a
 * re-export of the in-memory definitions that produced them. A shipped component the user
 * instantiates must be the file, or §V94 stops proving anything about the format.
 *
 * It exists because B23 happened three times (§V193): built, schema'd, unit-tested, and
 * nothing in `src/app` ever handed it to anything. A starter set nobody can instantiate is
 * the same shape of nothing.
 *
 * The glob is the whole registration step, as it is for the examples: dropping a
 * `.loom.json` into `examples/components/` puts it in the library.
 */

const RAW_COMPONENTS = import.meta.glob("../../../examples/components/*.loom.json", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Readonly<Record<string, string>>;

export interface StarterSetInstall {
  readonly installed: readonly GraphComponentDefinition[];
  /**
   * Why a shipped file did not install. Never thrown: a build that shipped a broken
   * component must still start, with the rest of the library present and the reason said
   * out loud rather than an app that fails to boot (§V8).
   */
  readonly diagnostics: readonly RuntimeDiagnostic[];
}

function fileNameOf(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
}

/** Every definition the shipped files carry, sorted by file name so order never drifts. */
export function readStarterComponents(): StarterSetInstall {
  const installed: GraphComponentDefinition[] = [];
  const diagnostics: RuntimeDiagnostic[] = [];

  for (const path of Object.keys(RAW_COMPONENTS).sort()) {
    const fileName = fileNameOf(path);
    const text = RAW_COMPONENTS[path] as string;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      diagnostics.push({
        severity: "error",
        code: "component.starter.invalidJson",
        message: `Shipped component "${fileName}" is not valid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
      continue;
    }

    const library = (raw as { componentLibrary?: unknown }).componentLibrary;
    const parsedLibrary = componentLibrarySchema.safeParse(library);
    if (!parsedLibrary.success) {
      diagnostics.push({
        severity: "error",
        code: "component.starter.invalidLibrary",
        message: `Shipped component "${fileName}" carries no readable component library.`,
      });
      continue;
    }

    for (const candidate of parsedLibrary.data.components) {
      const parsed = parseComponentDefinition(candidate);
      if (!parsed.ok) {
        diagnostics.push({
          severity: "error",
          code: "component.starter.invalidDefinition",
          message: `Shipped component "${fileName}" did not validate: ${parsed.issues.join(", ")}`,
        });
        continue;
      }
      installed.push(parsed.definition);
    }
  }

  return { installed, diagnostics };
}

/**
 * Installs the starter set into a catalogue.
 *
 * A definition the user's project already carries at the same id and version WINS: opening
 * a project must not have its components silently replaced by the shipped ones. That is
 * §V79 read the right way round — one definition per id and version, and the document's is
 * the one the document's instances were pinned against.
 */
export function installStarterComponents(registry: ComponentRegistry): StarterSetInstall {
  const { installed, diagnostics } = readStarterComponents();
  const kept: GraphComponentDefinition[] = [];
  const problems: RuntimeDiagnostic[] = [...diagnostics];

  for (const definition of installed) {
    if (registry.has(definition.componentId, definition.version)) continue;
    try {
      registry.register(definition);
      kept.push(definition);
    } catch (error) {
      problems.push({
        severity: "error",
        code: "component.starter.rejected",
        message: `Shipped component "${definition.name}" was refused by the catalogue: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }

  return { installed: kept, diagnostics: problems };
}
