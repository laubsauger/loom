/**
 * Prop equality for the control kit's `React.memo` boundaries (T1177).
 *
 * ═══════════════════════════════════════════════════════════════════════════════════
 * THE RULE: EQUAL MEANS *PROVEN* EQUAL. EVERYTHING ELSE IS A RE-RENDER.
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * A memo boundary that wrongly answers "equal" is a SILENTLY STALE PANEL — the number on
 * screen stops being the number in the document and nothing says so. That is strictly
 * worse than the slowness the boundary exists to remove, and §B181 is what it looks like
 * from the inside: twenty-six green tests, every one of them resolving a STATIC parameter,
 * while every driven parameter had been frozen for months. So this comparator's default
 * answer is FALSE. It claims equality only for shapes it has walked to the bottom of:
 * primitives, plain records of them, and arrays of either. A function it did not recognise
 * by identity, a class instance, a Map, a Date, anything past `MAX_DEPTH` — all of those
 * are "I do not know", which is spelled `false`.
 *
 * WHY STRUCTURAL AND NOT `Object.is` ALONE. The three props that carry a parameter row's
 * answer are minted fresh by the resolver on every read: a compound's `value` is a new
 * array, `components` a new array of records, and `diagnostic` a new object every time —
 * and by §V108 a clock-reading expression is EXPECTED to fail the frameless read, so every
 * expression row on E55's `reactor1` carries one. Identity alone therefore never bails out
 * on exactly the rows that cost the most, which is the whole reason those rows are slow.
 *
 * WHY THE PROP COMPARISON IS KEY-DRIVEN AND NOT A HAND-WRITTEN FIELD LIST. A field list is
 * a thing to forget, and forgetting one is invisible: the row simply stops updating for
 * that prop. `sameProps` below walks the UNION of both objects' own keys, so a prop added
 * to the component next year is compared without anybody remembering to come here.
 */

/**
 * How deep a walk may go before the answer becomes "I do not know".
 *
 * Four is what the kit's actual props need: `components` (array) → a resolved component
 * (record) → its `slot` (record) → a binding (record). A cap rather than a cycle check
 * because these are document and resolver values, never graphs — and a cap that is reached
 * costs a re-render, never a wrong answer.
 */
const MAX_DEPTH = 4;

/**
 * True only when `a` and `b` would render identically, for the value shapes this kit
 * passes. Anything not walked to the bottom answers false.
 */
export function sameRenderedValue(a: unknown, b: unknown, depth = 0): boolean {
  // Covers every primitive, both nulls, a shared object, and NaN === NaN.
  if (Object.is(a, b)) return true;
  if (depth >= MAX_DEPTH) return false;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;

  const aIsArray = Array.isArray(a);
  if (aIsArray !== Array.isArray(b)) return false;
  if (aIsArray) {
    const left = a as readonly unknown[];
    const right = b as readonly unknown[];
    if (left.length !== right.length) return false;
    return left.every((item, index) => sameRenderedValue(item, right[index], depth + 1));
  }

  // A plain record and nothing else. A Map, a Set, a Date or a class instance carries
  // state these keys cannot see, so it is never claimed equal by structure.
  if (Object.getPrototypeOf(a) !== Object.prototype) return false;
  if (Object.getPrototypeOf(b) !== Object.prototype) return false;

  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every(
    (key) => Object.hasOwn(right, key) && sameRenderedValue(left[key], right[key], depth + 1),
  );
}

/**
 * `React.memo`'s comparator over a whole props object — the union of both sides' own keys,
 * each through `sameRenderedValue`.
 *
 * The union, not `prev`'s keys: a prop that APPEARS (a `diagnostic` arriving, a `liveValue`
 * starting to differ) must not read as unchanged because the previous render had no such
 * key to compare.
 */
export function sameProps<P extends object>(previous: P, next: P): boolean {
  const left = previous as Record<string, unknown>;
  const right = next as Record<string, unknown>;
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    if (!sameRenderedValue(left[key], right[key])) return false;
  }
  return true;
}
