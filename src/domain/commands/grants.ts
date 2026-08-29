import type { Actor, CapabilityClass, CapabilityGrant } from "../types/commands.ts";
import { actorKeyOf } from "../graph/store.ts";

/**
 * The bus-owned capability grant store (T90, §V38).
 *
 * §V38's whole claim is "calling a tool never grants a capability" — which was untrue
 * while the bus read grants off `InvocationContext.capabilities`, because any adapter
 * could fabricate that array. Grants now live HERE, keyed by actor, written only by
 * whoever holds the store (the composition root's confirm flow, tests) and read by the
 * bus at check time. The context field still exists in the frozen contract but is
 * advisory: the bus never consults it for authorization again.
 *
 * The clock is injected. The previous code turned an invalid `expiresAt` into "valid
 * forever" via `Date.parse` NaN; here an invalid date is refused AT GRANT TIME — the
 * one moment someone is looking — rather than misinterpreted forever after.
 */

export interface CapabilityGrantStore {
  /** Records a grant. Throws on an unparseable `expiresAt` — never "valid forever". */
  grant(actor: Actor, capability: CapabilityClass, options?: { expiresAt?: string }): void;
  revoke(actor: Actor, capability: CapabilityClass): void;
  revokeAll(actor: Actor): void;
  /** Live (unexpired) grants for an actor, sorted by capability for determinism. */
  list(actor: Actor): ReadonlyArray<CapabilityGrant>;
  has(actor: Actor, capability: CapabilityClass): boolean;
}

export interface CapabilityGrantStoreOptions {
  /** Injectable clock (ms since epoch); expiry tests stop depending on wall time. */
  now?: () => number;
}

interface StoredGrant {
  readonly grantedAt: string;
  readonly expiresAtMs: number | undefined;
  readonly expiresAt: string | undefined;
}

export function createCapabilityGrantStore(
  options: CapabilityGrantStoreOptions = {},
): CapabilityGrantStore {
  const now = options.now ?? Date.now;
  const byActor = new Map<string, Map<CapabilityClass, StoredGrant>>();

  const liveGrants = (actor: Actor): Map<CapabilityClass, StoredGrant> => {
    const key = actorKeyOf(actor);
    const grants = byActor.get(key);
    if (grants === undefined) return new Map();
    const at = now();
    for (const [capability, grant] of grants) {
      if (grant.expiresAtMs !== undefined && grant.expiresAtMs <= at) grants.delete(capability);
    }
    return grants;
  };

  return {
    grant(actor, capability, grantOptions = {}) {
      const { expiresAt } = grantOptions;
      let expiresAtMs: number | undefined;
      if (expiresAt !== undefined) {
        expiresAtMs = Date.parse(expiresAt);
        if (Number.isNaN(expiresAtMs)) {
          throw new Error(
            `Capability grant for "${capability}" has an unparseable expiresAt ("${expiresAt}"); refusing rather than treating it as forever (§V38).`,
          );
        }
      }
      const key = actorKeyOf(actor);
      const grants = byActor.get(key) ?? new Map<CapabilityClass, StoredGrant>();
      grants.set(capability, {
        grantedAt: new Date(now()).toISOString(),
        expiresAtMs,
        expiresAt,
      });
      byActor.set(key, grants);
    },

    revoke(actor, capability) {
      byActor.get(actorKeyOf(actor))?.delete(capability);
    },

    revokeAll(actor) {
      byActor.delete(actorKeyOf(actor));
    },

    list(actor) {
      return [...liveGrants(actor).entries()]
        .map(([capability, grant]) => ({
          capability,
          grantedAt: grant.grantedAt,
          ...(grant.expiresAt === undefined ? {} : { expiresAt: grant.expiresAt }),
        }))
        .sort((a, b) => a.capability.localeCompare(b.capability));
    },

    has(actor, capability) {
      return liveGrants(actor).has(capability);
    },
  };
}
