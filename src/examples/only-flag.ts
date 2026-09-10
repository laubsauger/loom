/**
 * What `--only <arg>` selects for the example regenerators (T1267, B197).
 *
 * T698 added `--only` because a bare regen sweeps every other session's in-flight
 * documents; it matched with `fileName.includes(only)`, which makes the flag no guard at
 * all for the shape sessions actually type. `--only E2` took `E2-Reaction-Diffusion` AND
 * `E20`, `E24`-`E29` — eight files, seven of them foreign work that had to be restored
 * from HEAD bytes (B197). `--only E5` would take `E55-Reactor` the same way.
 *
 * So an E-NUMBER argument (`E` followed by digits, nothing else) names ONE example and is
 * matched exactly: the file itself, or the file whose name continues with the `-` that
 * separates the number from the title. Every other argument shape keeps substring
 * matching, because that is what `--only E2-Reaction` and `--only Reaction` are — a
 * caller who typed letters typed enough to mean them.
 *
 * Shared by `build-examples.ts` and `build-thumbnails.ts` so the two flags cannot drift:
 * B197 was one bug in two files.
 *
 * T1221: the same predicate selects STARTER COMPONENTS in `build-examples.ts`, matched
 * against the file name it writes (`Bloom.loom.json`). Nothing extra is needed for that:
 * a component file name is never `E` + digits, so the exact-match branch can only ever
 * name an example, and a named argument reaches components through the substring branch
 * exactly as a caller who typed `Bloom` meant it to.
 */

/** `E` + digits and nothing else — the form that names exactly one example. */
const E_NUMBER = /^E\d+$/;

/**
 * Does `fileName` (e.g. `E2-Reaction-Diffusion.loom.json`) fall under `--only <only>`?
 */
export function matchesOnlyFlag(fileName: string, only: string): boolean {
  if (E_NUMBER.test(only)) return fileName === only || fileName.startsWith(`${only}-`);
  return fileName.includes(only);
}
