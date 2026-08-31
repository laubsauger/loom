// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { usePerDocument } from "./use-per-document.ts";

/**
 * T733 — a store keyed by NODE ID does not outlive the document that filled it.
 *
 * The claim is about IDENTITY, and it is worth stating why that is the whole property
 * rather than a detail of it. Every store this wraps is a `Map<NodeId, …>`; a load builds
 * a new runtime and a new `documentIdentity` but REMOUNTS NOTHING, so the map survives —
 * and node ids are the names a person typed, which two projects collide on constantly
 * (E13/E33 share `shot` and `eye`, E31/E32 share twenty-one ids, `out` is in all
 * twenty-nine shipped examples). A carried map therefore does not look stale from the
 * inside: every key it is asked for is a key it has. Minting a NEW store is the only
 * answer that does not depend on enumerating what to clear.
 *
 * Both directions are gated, and the second is not decoration: `useMemo(create, [])` fails
 * the first, and `create()` called unconditionally fails the second — a store re-minted on
 * every render throws away the very state it exists to hold (an inspection camera the user
 * is mid-drag on, a slot rect the preview tick is about to read) and would be a worse bug
 * than the one being fixed.
 */

afterEach(cleanup);

/** A distinguishable instance per call, which is all the claim needs. */
function makeStore(): { id: number } {
  makeStore.calls += 1;
  return { id: makeStore.calls };
}
makeStore.calls = 0;

describe("usePerDocument (T733, B106)", () => {
  it("hands back the SAME store while the document is the same", () => {
    const { result, rerender } = renderHook(
      ({ identity }: { identity: string }) => usePerDocument(identity, makeStore),
      { initialProps: { identity: "document-a" } },
    );
    const first = result.current;

    // Re-render for any of the hundred reasons a pane re-renders — a selection, a hover, a
    // frame. None of them is a load.
    rerender({ identity: "document-a" });
    rerender({ identity: "document-a" });

    expect(result.current).toBe(first);
  });

  it("mints a NEW store when the document changes", () => {
    const { result, rerender } = renderHook(
      ({ identity }: { identity: string }) => usePerDocument(identity, makeStore),
      { initialProps: { identity: "document-a" } },
    );
    const first = result.current;

    rerender({ identity: "document-b" });

    // NOT merely "not the same value" — a fresh object, so nothing keyed by node id can be
    // read across the boundary, and every consumer whose effect depends on the store
    // re-arms against the new one (`NodePreviewSlot` re-measures its slot rect that way).
    expect(result.current).not.toBe(first);

    // And it does not oscillate back: the previous document's store is gone, not cached.
    const second = result.current;
    rerender({ identity: "document-a" });
    expect(result.current).not.toBe(first);
    expect(result.current).not.toBe(second);
  });
});
