# Dead-note sweep (§T805)

The maintenance pass that retires comments describing a state that no longer holds. Four
species, verified before deletion; a comment that turned out to describe a *live*
limitation was left and is recorded here as such.

## (a) "FAILING GATE" blocks on tests that now pass

- **`parameter-drag.spec.ts`** — the live-drag half was a deliberately red gate; §T798
  confirmed it fixed. Converted to past-tense history (the `shader-errors.spec.ts`
  template), keeping the "do not relax the assertion" warning. The assertion itself is
  unchanged — it still gates the behaviour; only the stale "left red" prose went.
- **`phase0-exit.test.ts`** — an assertion message pointed at "the FAILING GATE note above
  this describe block". That note had already been removed and the test now asserts the
  fixed behaviour (`rejection` *is* defined). Removed the dangling pointer.
- **`shader-errors.spec.ts`** — cross-referenced the same removed note; repointed to "a
  passing regression gate". Its own history block was already in the correct past-tense
  form and is the template the others now follow.

## (b) "once T-X lands" wish-notes where T-X landed

- **`vgpu-backend.ts` `cookPolicy`** — "Read by encode() once T254's gating exists"; T254's
  idle gate exists and the render loop reads `cookPolicy` (§V156). Rewritten to present
  reality.
- Most `until T-X` hits across the tree are already *past-tense history* ("was in until
  T430", "opened at 720 until T139 fixed") — the correct form, left untouched.

### Verified LIVE, deliberately left (§T805's "say so")

- **`render-harness.ts` `renderPlanHeadless`** — says "no feedback node yet". The node now
  exists, but its ping-pong comes from the compiler's temporal split, not a node scratch
  declaration, so the function's reason to stay plan-level is arguably still live. Left;
  the stale clause wants a rewrite of the test, which is out of a deletion pass's scope.
- **`hub.ts` `noteFrame(ran?)`** — "the cook gate's answer once T254 lands … no gating
  exists today". T254 gates in the *backend*, but the telemetry `ran` seam is still never
  populated (`noteFrame` is only ever called with the frame index), so from the hub's view
  "everything ran" is still the truth. The seam note is accurate; left.
- **`scene.ts` `group`** — "Instances (and, when it lands, points) mode only". The geometry
  node's points-mode predicate is a genuine future gap, not a landed one. Left.
- **`schemas.ts`** — "Set colour… reachable … when it lands". An unbuilt row. Left.

## (c) docblocks naming never-built surfaces

- **§T783's two** (`depth-runner.ts` / inference, "the acquisition state is a problems-pane
  row") — verified already corrected by the §B156 no-model-notice work; nothing to do. The
  problems pane itself exists, so the many other "problems pane/tab" mentions are live.

## The stale filename from §T802

- Ten `concepts.test.ts` references across six files (prose, no imports) after the monolith
  was split into `concepts/`. Swapped to `concepts/*.test.ts` — a one-token change that
  names the suite accurately.

## (d) The prevention — proposed rule, for SPEC (excepted, orchestrator's)

The species above regenerate unless the convention is written down. Proposed §V:

> A comment that PREDICTS — "once T-X lands", "when it lands", a FAILING GATE left red —
> carries the task id it waits on. Landing that task deletes the comment or converts it to
> past-tense history in the same commit. A prediction with no task id, or one whose task
> has landed and whose comment still speaks in the future tense, is a dead note by
> construction.

SPEC.md is excepted from this maintenance pass, so this rule is surfaced rather than added.
