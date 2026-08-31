import { evaluateAst, parseExpression, scopeFromFrame } from "../expressions/index.ts";
import type { ParameterDefinition } from "../types/parameters.ts";

/**
 * A bounded parameter, an unbounded expression, and the gap between them (T368).
 *
 * ## The bug this exists for
 *
 * `transform.r` is limited to ±360 and `ramp.phase` to ±1. `time * 7` on either one is
 * CORRECT at t=0, correct while anyone is looking at it, and pinned at the limit from
 * t≈51 onward — a rotation that silently stops. Measured before this landed: resolving
 * that expression at t=100 produced 360 and EXACTLY ZERO diagnostics. The clamp was not
 * merely late, it was mute (§V240 — the failure that reaches no diagnostic at all).
 *
 * ## Why the fix is a diagnostic and not a wrap
 *
 * The tempting alternative is to let angular and phase parameters WRAP: 370° is 10°, and
 * clamping a cyclic quantity is the wrong arithmetic. It was rejected, for three reasons
 * that stack:
 *
 *  - a wrap needs a PERIOD, and the manifest declares a RANGE. For both real cases the
 *    range is two periods wide (±360 for a 360° turn, ±1 for a unit phase), so "wrap into
 *    the declared range" has no single answer: 370 could honestly become 10 or -350;
 *  - it would change what a SHIPPED DOCUMENT means, in both directions and silently
 *    (§V311). A stored `time * 7` that pins today would spin after the change; the same
 *    document opened in an older build would pin again, with nothing in the file saying
 *    which arithmetic it was authored against;
 *  - it fixes only the cyclic parameters. Every bounded parameter has this failure —
 *    opacity, radius, gain — and they must all still clamp, so the diagnostic is needed
 *    regardless. Having it, the wrap buys nothing that `mod()` does not (T370).
 *
 * So: the clamp stays, and the two remedies the grammar now offers are named in the
 * message (§V288). `clamp()` holds at the limit, `mod()` wraps.
 *
 * ## AMENDED by T537 (§B111) — the third option T368 never weighed
 *
 * The owner hit this again, from the other end: "we need to make sure that rotations can
 * continue on. right now they just get clamped." The three arguments above are each still
 * true and none of them survives contact with the option they do not mention.
 *
 * The choice was framed as CLAMP versus WRAP, and wrap loses for exactly the reasons
 * given. But TouchDesigner does neither: `min`/`max` are the slider's travel, `clampMin`/
 * `clampMax` are separate opt-in flags, and with them off a rotation driven by time simply
 * KEEPS GOING — 725° is stored as 725°, because the trigonometry downstream is already
 * periodic and needs no help. There is no period to guess (answering the first argument),
 * nothing is folded and so nothing is reinterpreted (the second), and every genuinely
 * bounded parameter still clamps and still reports (the third — which is now the reason
 * the classification is per-parameter rather than global).
 *
 * The three arguments were arguments against WRAPPING. They were read as arguments for
 * CLAMPING, and the gap between those is where B111 lived for two tasks. The diagnostic
 * T368 built is kept whole; `numericRangeOf` below now decides WHICH parameters it is
 * true of, and E13-Prism's `abstime * 7 % 360` — a user-level workaround for this defect,
 * carried unquestioned through T497 — no longer needs its modulo.
 *
 * ## Two audiences, two moments
 *
 * `rangeRemedy` is the sentence, shared so the resolver and the inspector cannot drift.
 * `forecastClamp` is the prediction, for the moment the expression is being TYPED —
 * because the runtime warning arrives at frame 3100, and the live editor's per-frame
 * re-resolve discards its diagnostics (they would be a 60Hz firehose). A warning nobody
 * is in the room for is the shape §V220 keeps catching.
 */

export interface NumericRange {
  readonly min: number | null;
  readonly max: number | null;
}

/**
 * The ends that actually CLAMP; null when nothing does (§B111, T537).
 *
 * This is the single place the declaration is read, which is why every consumer got the
 * fix at once rather than site by site (§V437): the resolver's clamp, the resolver's
 * `clamped` diagnostic, the "clamps at 400 from t≈57s" forecast the inspector shows while
 * an expression is being typed, and the remedy sentence all ask this one function. A
 * `cyclic` parameter answers `null` here, so `abstime * 7` on a rotation is not pinned, is
 * not warned about, and is not offered a `mod()` it does not need.
 *
 * `definition.min`/`max` remain the SLIDER's travel unconditionally. What varies is how
 * many of those two numbers are also a limit, which is what `range` declares.
 */
export function numericRangeOf(definition: ParameterDefinition): NumericRange | null {
  if (definition.type !== "number" && definition.type !== "vector") return null;
  // Absent means `bounded` — what every parameter did before the declaration existed, so
  // omission changes nothing. `parameter-range-census.test.ts` forbids omission in the
  // catalogue, so this default is only ever reached by an ad-hoc spec.
  const kind = definition.range ?? "bounded";
  if (kind === "cyclic" || kind === "soft") return null;
  const min = definition.min ?? null;
  const max = kind === "floor" ? null : (definition.max ?? null);
  return min === null && max === null ? null : { min, max };
}

/**
 * How to keep `source` inside `range`, as expression text that actually parses.
 *
 * Both halves are offered where both are honest, and the message does not pretend to
 * know which the author meant: on a rotation the wrap is right, on an opacity the hold
 * is, and advice confidently given for the wrong one is worse than advice not given
 * (§V293). `mod` appears only when its result — [0, max) — is provably inside the
 * declared range, which is why a range starting above zero gets the hold alone.
 */
export function rangeRemedy(source: string, range: NumericRange): string | null {
  const trimmed = source.trim();
  if (trimmed === "") return null;
  const { min, max } = range;
  const wrap =
    max !== null && max > 0 && min !== null && min <= 0
      ? `mod(${trimmed}, ${max})`
      : null;
  const hold =
    min !== null && max !== null
      ? `clamp(${trimmed}, ${min}, ${max})`
      : max !== null
        ? `min(${trimmed}, ${max})`
        : min !== null
          ? `max(${trimmed}, ${min})`
          : null;
  if (hold === null) return null;
  return wrap === null
    ? `Hold it with ${hold}.`
    : `Hold it with ${hold}, or wrap it with ${wrap}.`;
}

export interface ClampForecast {
  /** Timeline seconds at which the value first leaves the range. */
  readonly atSeconds: number;
  /** The bound it runs into. */
  readonly limit: number;
  /** The remedy sentence, when the range affords one. */
  readonly remedy: string | null;
}

/**
 * Does this expression leave the range within the horizon, and when (T368)?
 *
 * Answered by RUNNING it, not by reading it: probe once a second, then bisect the second
 * it crossed in. An expression this module cannot evaluate — one reading `op()`, which
 * needs a graph — forecasts NOTHING rather than guessing, because a confident prediction
 * about an expression you could not run is the same lie the clamp was telling.
 *
 * The horizon is ten minutes, which is 601 evaluations of a small AST: microseconds, once
 * per keystroke. `frame` and `walltime` advance with it so an expression reading them is
 * probed the way it will really run.
 */
export function forecastClamp(
  source: string,
  range: NumericRange,
  horizonSeconds = 600,
): ClampForecast | null {
  const parsed = parseExpression(source);
  if (!parsed.ok) return null;

  const at = (seconds: number): number | null => {
    const result = evaluateAst(
      parsed.ast,
      scopeFromFrame({
        timeSeconds: seconds,
        deltaSeconds: 1 / 60,
        frameIndex: Math.round(seconds * 60),
        mode: "offline",
        randomSeed: 0,
      }),
    );
    return result.ok ? result.value : null;
  };

  const outside = (value: number | null): boolean =>
    value !== null &&
    ((range.min !== null && value < range.min) || (range.max !== null && value > range.max));

  const first = at(0);
  // Not evaluable at all (an `op()` reference, an unknown name): no claim to make.
  if (first === null) return null;
  if (outside(first)) return forecastAt(0, first, range, source);

  let previous = 0;
  for (let seconds = 1; seconds <= horizonSeconds; seconds += 1) {
    const value = at(seconds);
    if (value === null) return null;
    if (!outside(value)) {
      previous = seconds;
      continue;
    }
    // Bisect the second it crossed in, so the reported time is the one a user would see
    // on the transport rather than the probe grid's rounding of it.
    let low = previous;
    let high = seconds;
    for (let step = 0; step < 12; step += 1) {
      const mid = (low + high) / 2;
      if (outside(at(mid))) high = mid;
      else low = mid;
    }
    return forecastAt(high, value, range, source);
  }
  return null;
}

function forecastAt(
  seconds: number,
  value: number,
  range: NumericRange,
  source: string,
): ClampForecast {
  const limit = range.max !== null && value > range.max ? range.max : (range.min ?? 0);
  return { atSeconds: seconds, limit, remedy: rangeRemedy(source, range) };
}

/** One sentence for the inspector: what will happen, when, and what to write instead. */
export function describeForecast(forecast: ClampForecast): string {
  const when = forecast.atSeconds < 10 ? forecast.atSeconds.toFixed(1) : String(Math.round(forecast.atSeconds));
  const remedy = forecast.remedy === null ? "" : ` ${forecast.remedy}`;
  return `Clamps at ${forecast.limit} from t ≈ ${when}s.${remedy}`;
}
