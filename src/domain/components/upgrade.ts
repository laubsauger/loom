import type { ComponentMigration, GraphComponentDefinition } from "../types/components.ts";
import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type { GraphNode } from "../types/graph.ts";
import type { PortId } from "../types/ids.ts";
import type { StoredParameter } from "../types/parameters.ts";
import { validateStoredParameter } from "../parameters/validate.ts";
import { defaultValueOf } from "./parameter-defaults.ts";
import { readComponentInstance } from "./instance.ts";
import type { ComponentRegistryView } from "./registry.ts";

/**
 * Version pinning and explicit upgrade (T136, §V84, §V10).
 *
 * An instance pins a version. Registering a newer definition must NOT change a saved
 * project: the user opens a file they saved six months ago and it renders what it
 * rendered six months ago, even though the component has moved on three versions since.
 *
 * Upgrading is therefore something the user does, to one instance or to a set, after
 * being told what it will cost — which parameters disappear, which ports go and which
 * edges die with them. This module produces that answer; it never applies it.
 */

export interface ComponentUpgradePlan {
  fromVersion: number;
  toVersion: number;
  /** Migrated published values for the new version — stored form, envelopes kept (T202). */
  parameters: Record<string, StoredParameter>;
  /** Published keys the new version no longer has. Their values are lost. */
  dropped: readonly string[];
  /** Published keys the new version adds; they take the new definition's default. */
  added: readonly string[];
  /** Keys whose value did not survive the new definition's type or range. */
  reset: readonly string[];
  /** Exposed ports that disappear — every edge into them is cut. */
  removedInputs: readonly PortId[];
  removedOutputs: readonly PortId[];
  /** The migration steps the target definition declares, for the confirmation UI. */
  migrations: readonly ComponentMigration[];
  diagnostics: readonly RuntimeDiagnostic[];
}

/**
 * The declared migration chain between two versions.
 *
 * A gap is reported, not filled in. §V84 says an upgrade is migrated; a version step
 * nobody wrote a migration for is exactly the case where values are about to be dropped
 * without anyone having thought about it, and the user deserves to be told before it
 * happens rather than after.
 */
export function migrationChain(
  target: GraphComponentDefinition,
  fromVersion: number,
  toVersion: number,
): { steps: ComponentMigration[]; gaps: Array<{ from: number; to: number }> } {
  const declared = [...(target.migrations ?? [])].sort((a, b) => a.fromVersion - b.fromVersion);
  const steps: ComponentMigration[] = [];
  const gaps: Array<{ from: number; to: number }> = [];
  let at = fromVersion;
  while (at < toVersion) {
    const step = declared.find((migration) => migration.fromVersion === at);
    if (step === undefined) {
      gaps.push({ from: at, to: at + 1 });
      at += 1;
      continue;
    }
    steps.push(step);
    at = step.toVersion;
  }
  return { steps, gaps };
}

export interface UpgradePlanInput {
  instance: GraphNode;
  /** The version the instance is pinned to. Absent when it is no longer installed. */
  from: GraphComponentDefinition | undefined;
  to: GraphComponentDefinition;
}

export function planComponentUpgrade(input: UpgradePlanInput): ComponentUpgradePlan {
  const state = readComponentInstance(input.instance);
  const fromVersion = state?.version ?? input.from?.version ?? 0;
  const diagnostics: RuntimeDiagnostic[] = [];
  // Stored form, not bare values: a published parameter carrying a mode envelope (T202)
  // survives the upgrade with its retained payloads intact.
  const parameters: Record<string, StoredParameter> = {};
  const dropped: string[] = [];
  const added: string[] = [];
  const reset: string[] = [];

  const stored = state?.parameters ?? {};
  const toKeys = new Set(input.to.parameters.map((published) => published.key));

  for (const published of input.to.parameters) {
    const previous = stored[published.key];
    if (previous === undefined) {
      added.push(published.key);
      parameters[published.key] = defaultValueOf(published.definition);
      continue;
    }
    // A value that no longer fits the re-authored control — a narrowed range, a changed
    // type — falls back to the new default and is REPORTED. Silently clamping would
    // change what the project renders without saying so.
    const invalid = validateStoredParameter(published.key, published.definition, previous, input.instance.id);
    if (invalid !== null) {
      reset.push(published.key);
      parameters[published.key] = defaultValueOf(published.definition);
      diagnostics.push({
        ...invalid,
        severity: "warning",
        code: "component.upgrade.valueReset",
        message: `"${published.key}" was reset to its default: ${invalid.message}`,
      });
      continue;
    }
    parameters[published.key] = previous;
  }

  for (const key of Object.keys(stored).sort()) {
    if (!toKeys.has(key)) dropped.push(key);
  }
  if (dropped.length > 0) {
    diagnostics.push({
      severity: "warning",
      code: "component.upgrade.droppedParameters",
      message: `Version ${input.to.version} of "${input.to.name}" no longer publishes ${dropped.join(", ")}; ${
        dropped.length === 1 ? "that value is" : "those values are"
      } lost.`,
      nodeId: input.instance.id,
    });
  }

  const toInputs = new Set(input.to.inputs.map((port) => port.externalId));
  const toOutputs = new Set(input.to.outputs.map((port) => port.externalId));
  const removedInputs = (input.from?.inputs ?? [])
    .map((port) => port.externalId)
    .filter((externalId) => !toInputs.has(externalId));
  const removedOutputs = (input.from?.outputs ?? [])
    .map((port) => port.externalId)
    .filter((externalId) => !toOutputs.has(externalId));
  if (removedInputs.length + removedOutputs.length > 0) {
    diagnostics.push({
      severity: "warning",
      code: "component.upgrade.removedPorts",
      message: `Upgrading drops the ports ${[...removedInputs, ...removedOutputs].join(", ")}; edges connected to them are removed.`,
      nodeId: input.instance.id,
    });
  }

  const chain = migrationChain(input.to, fromVersion, input.to.version);
  for (const gap of chain.gaps) {
    diagnostics.push({
      severity: "warning",
      code: "component.upgrade.noMigration",
      message: `"${input.to.name}" declares no migration for version ${gap.from} → ${gap.to}.`,
      suggestion: "Check the parameter values after upgrading; nothing describes what changed (§V84, §V10).",
    });
  }

  return {
    fromVersion,
    toVersion: input.to.version,
    parameters,
    dropped,
    added,
    reset,
    removedInputs,
    removedOutputs,
    migrations: chain.steps,
    diagnostics,
  };
}

export interface AvailableUpgrade {
  componentId: string;
  pinnedVersion: number;
  latestVersion: number;
}

/**
 * Whether a newer version exists for this instance. Purely informational: nothing acts
 * on it without the user asking, which is the whole of §V84.
 */
export function availableUpgrade(
  instance: GraphNode,
  components: ComponentRegistryView,
): AvailableUpgrade | null {
  const state = readComponentInstance(instance);
  if (state === null) return null;
  const latest = components.latest(state.componentId);
  if (latest === undefined || latest.version <= state.version) return null;
  return {
    componentId: state.componentId,
    pinnedVersion: state.version,
    latestVersion: latest.version,
  };
}
