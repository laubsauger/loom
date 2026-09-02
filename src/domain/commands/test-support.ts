import type { Actor, InvocationContext } from "../types/commands.ts";
import type { GraphPatch, GraphPatchOperation } from "../types/patch.ts";
import { createGraphStore, type GraphStore } from "../graph/store.ts";
import { createSequentialIdFactory } from "../graph/ids.ts";
import { createTestRegistry } from "../../nodes/registry/test-nodes.ts";
import type { CapabilityGrantStore } from "./grants.ts";
import { createDomainBus } from "./index.ts";
import type { LoomBus } from "./bus.ts";

/** Shared fixtures for the domain tests. Deterministic ids and timestamps. */

export interface Harness {
  bus: LoomBus;
  store: GraphStore;
}

export function createHarness(
  options: { idPrefix?: string; grants?: CapabilityGrantStore } | string = {},
): Harness {
  const resolved = typeof options === "string" ? { idPrefix: options } : options;
  const store = createGraphStore({
    ids: createSequentialIdFactory(resolved.idPrefix ?? "t"),
    now: () => "2026-08-29T00:00:00.000Z",
  });
  const { bus } = createDomainBus({
    store,
    registry: createTestRegistry().view(),
    ...(resolved.grants === undefined ? {} : { grants: resolved.grants }),
  });
  return { bus, store };
}

export function contextFor(actor: Actor, overrides: Partial<InvocationContext> = {}): InvocationContext {
  return { actor, projectId: "project-1", capabilities: [], ...overrides };
}

export const alice: Actor = { kind: "human", id: "alice" };
export const bob: Actor = { kind: "human", id: "bob" };
export const agent: Actor = { kind: "agent", id: "claude", label: "Claude" };

export function patch(baseRevision: number, operations: GraphPatchOperation[], label?: string): GraphPatch {
  return { baseRevision, operations, ...(label === undefined ? {} : { label }) };
}
