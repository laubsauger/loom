import { useCallback, useSyncExternalStore } from "react";
import type { ShaderCompilePipeline, ShaderCompileState } from "./compile-pipeline.ts";

/**
 * Subscribes a component to a compile pipeline.
 *
 * The pipeline is created by the caller and lives outside React, because its lifetime is
 * the node's, not the panel's: collapsing the bottom dock must not throw away the
 * retained program §V9 depends on.
 */
export function useShaderCompileState(pipeline: ShaderCompilePipeline): ShaderCompileState {
  const subscribe = useCallback(
    (onStoreChange: () => void) => pipeline.subscribe(onStoreChange),
    [pipeline],
  );
  const getSnapshot = useCallback(() => pipeline.state, [pipeline]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
