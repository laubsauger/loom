/**
 * Identity minting. IDs are opaque, globally unique strings — never an array index,
 * never positional (§I.file, §V40). Collaboration later depends on two actors never
 * minting the same id, so every id carries a random suffix as well as a counter.
 */

export interface IdFactory {
  node(): string;
  edge(): string;
  group(): string;
  undoGroup(): string;
  /** Escape hatch for other kinds of entity; `prefix` is namespaced into the id. */
  next(prefix: string): string;
}

function randomSuffix(): string {
  const cryptoApi: Crypto | undefined = globalThis.crypto;
  if (cryptoApi !== undefined && typeof cryptoApi.getRandomValues === "function") {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(6));
    let out = "";
    for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
    return out;
  }
  // No entropy source (exotic embedder): fall back to the clock. Still unique within a
  // process because the counter is mixed in by the caller.
  return Date.now().toString(36);
}

export function createIdFactory(prefixSeed = randomSuffix()): IdFactory {
  let counter = 0;
  const next = (prefix: string): string => {
    counter += 1;
    return `${prefix}_${prefixSeed}${counter.toString(36)}`;
  };
  return {
    next,
    node: () => next("nd"),
    edge: () => next("ed"),
    group: () => next("gp"),
    undoGroup: () => next("ug"),
  };
}

/**
 * Deterministic factory for tests and for reproducible fixtures. Never use in the app:
 * two sessions would mint identical ids and collide on merge.
 */
export function createSequentialIdFactory(prefixSeed = "t"): IdFactory {
  let counter = 0;
  const next = (prefix: string): string => {
    counter += 1;
    return `${prefix}_${prefixSeed}${counter}`;
  };
  return {
    next,
    node: () => next("nd"),
    edge: () => next("ed"),
    group: () => next("gp"),
    undoGroup: () => next("ug"),
  };
}
