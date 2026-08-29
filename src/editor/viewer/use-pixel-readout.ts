import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { decodePixel } from "@runtime/previews/index.ts";
import type { PixelProbe, PixelSample, PreviewOutputRef } from "@runtime/previews/index.ts";

/**
 * The viewer's "pixel value under the cursor" (T36).
 *
 * §V7 permits readback for explicit inspection and forbids it in the playback loop, so this
 * hook is deliberately shaped so it cannot become the latter:
 *
 *  - It is driven by pointer/keyboard events, never by a frame callback.
 *  - It issues at most one read per `intervalMs` (default 100 ms, the §V16 ceiling) and at most
 *    one at a time; a pointer moving at 120 Hz produces 10 reads a second, not 120.
 *  - It reads a 1x1 window through the export interface (§V48), not a frame.
 *
 * The sample lives in component state and nowhere else — it is not document state and never
 * reaches the store (§V16).
 */

export const READOUT_INTERVAL_MS = 100;

export interface PixelReadout {
  readonly sample: PixelSample | null;
  readonly error: string | null;
  /** Request the value at an image pixel. Coalesced and rate-limited. */
  probeAt(x: number, y: number): void;
  clear(): void;
}

export interface PixelReadoutOptions {
  intervalMs?: number;
  now?: () => number;
}

export function usePixelReadout(
  probe: PixelProbe | undefined,
  ref: PreviewOutputRef | null,
  options: PixelReadoutOptions = {},
): PixelReadout {
  const intervalMs = options.intervalMs ?? READOUT_INTERVAL_MS;
  // Memoised so the callbacks below keep a stable identity; an inline default would give
  // every render a new function and re-create the whole hook's callback graph each time.
  const now = useMemo(() => options.now ?? (() => Date.now()), [options.now]);

  const [sample, setSample] = useState<PixelSample | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pending = useRef<{ x: number; y: number } | null>(null);
  const inFlight = useRef(false);
  const lastIssued = useRef(Number.NEGATIVE_INFINITY);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Bumped whenever the target output changes, so a late reply cannot land on the new one. */
  const generation = useRef(0);

  const issue = useCallback(() => {
    timer.current = null;
    const target = pending.current;
    if (target === null || probe === undefined || ref === null) return;
    if (inFlight.current) return;
    pending.current = null;
    inFlight.current = true;
    lastIssued.current = now();
    const issuedFor = generation.current;
    void probe
      .read(ref, { x: target.x, y: target.y, width: 1, height: 1 })
      .then((image) => {
        if (issuedFor !== generation.current) return;
        // The readback window's own origin is (0,0) — the image IS the pixel.
        const decoded = decodePixel(image, 0, 0);
        setSample(decoded === null ? null : { ...decoded, x: target.x, y: target.y });
        setError(null);
      })
      .catch((cause: unknown) => {
        if (issuedFor !== generation.current) return;
        setSample(null);
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        inFlight.current = false;
      });
  }, [now, probe, ref]);

  const probeAt = useCallback(
    (x: number, y: number) => {
      if (probe === undefined || ref === null) return;
      pending.current = { x, y };
      if (timer.current !== null) return;
      const wait = Math.max(0, intervalMs - (now() - lastIssued.current));
      timer.current = setTimeout(issue, wait);
    },
    [intervalMs, issue, now, probe, ref],
  );

  const clear = useCallback(() => {
    pending.current = null;
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    setSample(null);
    setError(null);
  }, []);

  // A new output invalidates whatever was on screen and whatever is in flight.
  useEffect(() => {
    generation.current += 1;
    pending.current = null;
    setSample(null);
    setError(null);
  }, [ref]);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    },
    [],
  );

  return { sample, error, probeAt, clear };
}
