/**
 * T1335b — THE SEAM THAT MAKES "DO NOT REGENERATE SHADER TEXT EVERY FRAME" A TYPE RATHER
 * THAN A RULE.
 *
 * ## The problem this replaces
 *
 * §T259 runs the whole compiler EVERY FRAME for any animated document, and a node's
 * `compile()` builds the WGSL it hands to its pass. Emission therefore conflates "this
 * node's VALUES changed" with "this node's SOURCE changed", and the second almost never
 * happens: §T1333b measured `src/points/codegen.ts` at 39.4% of ALL main-thread script time
 * on E32 Pasture, rebuilding text from bytes that were identical sixty times a second.
 *
 * Two of those were fixed by hand. That is not a fix — it is a rule somebody has to
 * remember, and the owner said so: *"this needs to be ABSTRACTED AWAY so that it's not a
 * rule that is written down that we have to respect, but something that is AUTOMATICALLY
 * APPLIED wherever it is useful."*
 *
 * ⚑ **AND AN AUDIT CANNOT BE THE ANSWER (§V1012).** Which emitter is expensive is a
 * property of the DOCUMENT, not of the emitter: E32 puts 39.4% of script in the point
 * kernel and never touches the shared-module resolver; E55 Reactor does the reverse at
 * 3.37%; E24 makes neither measurable. A list of hot sites is a snapshot of one
 * `.loom.json`. An audit fixes the documents somebody measured; a seam fixes the ones
 * nobody has written yet.
 *
 * ## The design test, and how it is met
 *
 * A contributor who has never read any of this must not be able to write a
 * per-frame-regenerating emitter that TYPECHECKS. So the pass descriptors in
 * `runtime/backend/plan.ts` do not take a `string` — they take `EmittedWgsl`, which only
 * this module can produce. A raw template literal is not assignable, and the compiler
 * refuses the uncached path for free, forever.
 *
 * ## Why the KEY is the tagged template, and not what was proposed first
 *
 * The obvious cache is a `WeakMap` on the emitter's request object. Measured at
 * `point-kernel-advanced.ts:274` and it would have missed EVERY FRAME: the request is a
 * fresh object literal inside `compile()`, with its arrays and its kernel body rebuilt per
 * call. It would have looked like a working cache and cached nothing.
 *
 * A tagged template's `TemplateStringsArray` is, by the language's own guarantee, the SAME
 * frozen object on every evaluation of that call site. So the site itself is the key root —
 * no stringify, no hashing, no copying a five-kilobyte kernel body to build a key, and
 * nothing to keep in sync. The interpolated values walk a small trie below it.
 *
 * Anything the `WeakMap` holds dies with the module that owns the call site, so the cache
 * is bounded by construction rather than by a policy; the per-level cap below bounds the
 * one case that is not — a site interpolated with unboundedly many distinct values.
 *
 * ## What this covers, and what it deliberately does not
 *
 * It covers every WGSL string that reaches a pass descriptor. It does NOT cover expression
 * compilation or parameter reflection: the same shape, already memoised through
 * `params-reflection.ts`'s `remember`, and branding every string in the application is a
 * different project. If those should live under one seam it is a row of its own, argued
 * rather than assumed.
 */

declare const emitted: unique symbol;

/**
 * WGSL that came from this module, and therefore from a cache. The brand is phantom — at
 * runtime this IS the string, so every existing reader keeps working unchanged.
 */
export type EmittedWgsl = string & { readonly [emitted]: true };

/** What may be interpolated into a shader template: things a `Map` can key by value. */
export type WgslValue = string | number | boolean;

interface SiteNode {
  text?: EmittedWgsl;
  children?: Map<WgslValue, SiteNode>;
}

/**
 * Distinct value-combinations remembered per call site, matching `remember`'s own cap for
 * the same reason: a shader editor types a new source per keystroke, and a cache that
 * remembers every one of them is a leak with a docblock.
 */
const SITE_CACHE_LIMIT = 64;

const bySite = new WeakMap<TemplateStringsArray, SiteNode>();

/**
 * Build WGSL, once per distinct set of interpolated values per call site.
 *
 *     const shader = wgsl`fn main() { let k = ${gain}; }`;
 *
 * Writing the natural thing is what gets the cache, which is the whole point: there is no
 * second, slower spelling to avoid.
 */
export function wgsl(strings: TemplateStringsArray, ...values: readonly WgslValue[]): EmittedWgsl {
  const root = bySite.get(strings);
  let node: SiteNode;
  if (root === undefined) {
    node = {};
    bySite.set(strings, node);
  } else {
    node = root;
  }
  for (const value of values) {
    const existing = node.children;
    let children: Map<WgslValue, SiteNode>;
    if (existing === undefined) {
      children = new Map<WgslValue, SiteNode>();
      node.children = children;
    } else {
      children = existing;
    }
    const found = children.get(value);
    let child: SiteNode;
    if (found !== undefined) {
      child = found;
    } else {
      child = {};
      children.set(value, child);
      /* Insertion order is age; the oldest goes. `child` is already held, so evicting it
         on the very call that created it would still return the right text — it would only
         cost the next call a rebuild. */
      if (children.size > SITE_CACHE_LIMIT) {
        const oldest = children.keys().next();
        if (oldest.done !== true) children.delete(oldest.value);
      }
    }
    node = child;
  }
  const hit = node.text;
  if (hit !== undefined) return hit;
  let text = strings[0] ?? "";
  for (let index = 0; index < values.length; index += 1) {
    text += String(values[index]) + (strings[index + 1] ?? "");
  }
  node.text = text as EmittedWgsl;
  return node.text;
}

/**
 * A GENERATOR's output, keyed by the inputs the generator actually varies on.
 *
 * `wgsl` covers the common case — a template with values interpolated into it — but a code
 * generator does not interpolate, it LOOPS: the point kernel walks an attribute schema and a
 * storage map and assembles hundreds of lines. There is no template object to key on, so the
 * caller declares its key, and declaring it is the price of getting branded text back. That
 * keeps the invariant the brand exists for — no emitter reaches a pass descriptor without a
 * cache — while admitting that one class of emitter cannot be keyed by its call site.
 *
 * ⚠ **THE KEY IS THE CALLER'S PROMISE, and an incomplete one ships a stale shader that passes
 * every identity test perfectly.** That failure mode is why the invalidation, not the hit, is
 * the case worth a test (§V968): change a generator input, assert the RENDERED PIXELS move.
 * A key that names every structural input is correct; one that forgets a flag is a silent
 * defect a type cannot catch.
 */
export function emitFrom(keys: readonly WgslValue[], build: () => string): EmittedWgsl {
  let node = byGenerator;
  for (const key of keys) {
    const existing = node.children;
    let children: Map<WgslValue, SiteNode>;
    if (existing === undefined) {
      children = new Map<WgslValue, SiteNode>();
      node.children = children;
    } else {
      children = existing;
    }
    const found = children.get(key);
    if (found !== undefined) {
      node = found;
      continue;
    }
    const child: SiteNode = {};
    children.set(key, child);
    if (children.size > SITE_CACHE_LIMIT) {
      const oldest = children.keys().next();
      if (oldest.done !== true) children.delete(oldest.value);
    }
    node = child;
  }
  const hit = node.text;
  if (hit !== undefined) return hit;
  node.text = build() as EmittedWgsl;
  return node.text;
}

/**
 * Generators share one root rather than a per-site `WeakMap`, because their key already
 * names the generator (every caller leads with its own name) and a generator is not a
 * template object that can die with its module.
 */
const byGenerator: SiteNode = {};

/**
 * THE TRUST BOUNDARY: a plan that was BUILT ELSEWHERE, being read back.
 *
 * `plan.ts`'s readers take `unknown` and validate it into descriptors. The text in such a
 * plan was emitted by a node's `compile()` when the plan was first built — this only
 * re-labels it after a round trip, and it generates nothing.
 *
 * ⚠ It is not a way to get branded text out of a string you just assembled. A `compile()`
 * that reaches for this is writing the uncached emitter the brand exists to refuse, and the
 * name is deliberately unusable there: nothing in `src/nodes/**` should import it.
 */
export function wgslFromPlan(text: string): EmittedWgsl {
  return text as EmittedWgsl;
}

/**
 * WGSL THE USER WROTE, or that a document carries — a `customWgsl` source, a point kernel.
 *
 * There is nothing to memoise here and the brand is honest rather than a loophole: the text
 * is not BUILT per frame, it IS the parameter, handed over from the store as the same string
 * every frame. What the caller must not do is assemble text and launder it through this;
 * that is what `wgsl` is for, and the two names are deliberately different so a reviewer can
 * see which one a diff chose.
 */
export function authoredWgsl(source: string): EmittedWgsl {
  return source as EmittedWgsl;
}
