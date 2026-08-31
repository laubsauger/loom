import { useMemo } from "react";

/**
 * A per-pane store that must not outlive the DOCUMENT that filled it (T733, B106, §V79).
 *
 * ## The rule this exists to enforce
 *
 * A load builds a whole new `AppRuntime` — new bus, new `documentIdentity` — but it
 * REMOUNTS NOTHING (`adoptDocument`, `app.tsx`). So the census T726 wrote holds: anything
 * keyed on a BUS resets, and anything keyed on a NODE id inside a `useMemo(…, [])`, a ref,
 * or the backend does not. Every store this wraps is a `Map<NodeId, …>`, and a node id is
 * the name a person typed — E13 and E33 share `shot` and `eye`, E31 and E32 share
 * twenty-one ids, `out` is in all twenty-nine shipped examples — so "keyed by node id"
 * means "shared with the next project" unless something says otherwise. This is that
 * something.
 *
 * Two concrete leaks it closes, both on surfaces the owner named: a slot rect measured in
 * one project keeps positioning a same-named node's preview tile in the next, and an
 * inspection camera the user swung in one project is silently the framing another
 * project's 3D preview opens on. `preview-orbit-store.ts`'s own docblock already promised
 * the second could not happen ("does not survive a reload"); this is that sentence
 * becoming true rather than descriptive (§V186).
 *
 * ## Why the exemption
 *
 * The identity is a KEY, not an input: nothing inside `create` reads it, which is exactly
 * why the dependency checker cannot see the claim being made and reports the dependency as
 * unnecessary (§V676 — the rule is right about the body and wrong about the property).
 * `create` is deliberately absent from the array for the same reason it is safe to be: a
 * caller passes a module-level factory, so it never changes, and re-minting a store
 * because a closure was re-created would throw away live state for nothing.
 *
 * NOT a general-purpose "reset on document change". It answers one question — is this
 * value allowed to outlive the document it was built for — and the answer is no for
 * anything keyed by node id. A value keyed by something a load does not reuse does not
 * belong here.
 */
export function usePerDocument<T>(documentIdentity: string, create: () => T): T {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(create, [documentIdentity]);
}
