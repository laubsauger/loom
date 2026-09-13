import type { LoomBackend } from "@runtime/backend/index.ts";

// Viewer publishers are session UI, not graph nodes. Their GPU ownership must
// still participate in the same offline preflight, including after pane unmount
// or document replacement. The backend, not the document's bus, owns the GPU work.
const states = new WeakMap<LoomBackend, {
  owners: Set<() => void>;
  drains: Set<Promise<void>>;
}>();
function stateFor(backend: LoomBackend) {
  let state = states.get(backend);
  if (!state) {
    state = { owners: new Set(), drains: new Set() };
    states.set(backend, state);
  }
  return state;
}

export function registerNativeViewerOutput(backend: LoomBackend, stop: () => void): () => void {
  const state = stateFor(backend);
  state.owners.add(stop);
  return () => { state.owners.delete(stop); };
}

export function trackNativeViewerDrain(backend: LoomBackend, drain: Promise<void>): void {
  const state = stateFor(backend);
  state.drains.add(drain);
  // Keep failures: neither a later take nor an unmounted pane may forget an
  // unproven native release. The caller also reports the failure in its UI.
  void drain.then(() => state.drains.delete(drain), () => {});
}

export async function drainNativeViewerOutputs(backend: LoomBackend | null): Promise<void> {
  if (!backend) return; // No device means no native viewer can have been opened.
  const state = stateFor(backend);
  for (const stop of [...state.owners]) stop();
  await Promise.all(state.drains);
}
