import type { ProjectSettings } from "../types/graph.ts";

/**
 * What a settings edit costs (T272, §V178).
 *
 * §V178 exists because of one specific mistake: treating "settings changed" as a single
 * event. Do that and dragging an fps field rebuilds every GPU resource sixty times a
 * second — the picture stutters, and it stutters BECAUSE the user is adjusting how often
 * it draws, which is about as confusing as a bug can get.
 *
 * So the classification is PER FIELD, and it is a pure function of the two values rather
 * than of which command ran: an edit that sets a field to the value it already had is not
 * a change, whoever asked for it.
 *
 * STRUCTURAL fields decide what the compiler emits and what the backend allocates:
 *   - `outputResolution` sizes every target the plan names;
 *   - `workingFormat` decides their pixel format;
 *   - `limits` is what the plan is validated against, so a change can make a legal plan
 *     illegal or the reverse (§V24).
 *
 * The rest are RATES and BUDGETS the running loop reads each frame. `fps` is the
 * denominator of timeline time (§V176) so it changes the animation timebase — a big deal
 * for what the user sees, and still not a reason to recompile anything.
 *
 * `randomSeed` is the interesting one and it is deliberately structural. Seeds reach
 * shaders through the shared frame block, so a seed edit needs no new pipeline — but the
 * plan captures it at compile time (§V45: same seed, same field, on any GPU), so without
 * a recompile the change would simply not take. Classifying it as a rate would make it
 * silently do nothing, which is worse than the rebuild it costs.
 */

/** Fields whose change requires a recompile. Everything else is read per frame. */
export const STRUCTURAL_SETTINGS = [
  "outputResolution",
  "workingFormat",
  "limits",
  "randomSeed",
] as const satisfies ReadonlyArray<keyof ProjectSettings>;

export interface SettingsChange {
  /** Fields whose value actually differs, sorted. Empty means the patch was a no-op. */
  readonly changed: ReadonlyArray<keyof ProjectSettings>;
  /** True when at least one changed field is structural — the recompile gate. */
  readonly structural: boolean;
}

const STRUCTURAL = new Set<string>(STRUCTURAL_SETTINGS);

/**
 * Deep equality by serialization.
 *
 * The values here are small, JSON-shaped and fully owned by the document, so this is
 * exact rather than approximate — and it treats `{width, height}` correctly, which a
 * reference comparison would not: a patch rebuilding an identical resolution object
 * would otherwise read as a change and recompile the world.
 */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export function classifySettingsChange(
  before: ProjectSettings,
  after: ProjectSettings,
): SettingsChange {
  const keys = new Set<string>([...Object.keys(before), ...Object.keys(after)]);
  const changed: Array<keyof ProjectSettings> = [];
  for (const key of [...keys].sort()) {
    const field = key as keyof ProjectSettings;
    if (same(before[field], after[field])) continue;
    changed.push(field);
  }
  return {
    changed,
    structural: changed.some((field) => STRUCTURAL.has(field)),
  };
}

/**
 * The projection a compile depends on.
 *
 * This is how §V178 is ENFORCED rather than merely documented: the compile memo keys on
 * this string, so a non-structural edit produces an identical key and no recompile can
 * happen — not "should not", cannot. A new structural field must be added to
 * `STRUCTURAL_SETTINGS` to appear here, and a new field that belongs in neither list is
 * the case a test should catch rather than a reviewer.
 */
export function structuralSettingsKey(settings: ProjectSettings): string {
  const projected: Record<string, unknown> = {};
  for (const field of STRUCTURAL_SETTINGS) projected[field] = settings[field];
  return JSON.stringify(projected);
}
