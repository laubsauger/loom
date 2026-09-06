/**
 * T1229 — the offline walk off the main thread. One request in, one result out; the
 * walk itself is `analyseOffline`, the same function the main-thread fallback calls, so
 * where it ran cannot change what it produced.
 */
import { analyseOffline } from "./audio-offline-analysis.ts";
import type { OfflineAnalysisRequest, OfflineAnalysisResponse } from "./audio-pre-analysis.ts";

const scope = self as unknown as {
  postMessage(message: OfflineAnalysisResponse): void;
  addEventListener(type: "message", listener: (event: { data: OfflineAnalysisRequest }) => void): void;
};

scope.addEventListener("message", (event) => {
  const { id, samples, sampleRate, fps, detector } = event.data;
  try {
    scope.postMessage({ id, analysis: analyseOffline(samples, sampleRate, fps, detector) });
  } catch (error) {
    scope.postMessage({ id, failure: error instanceof Error ? error.message : String(error) });
  }
});
