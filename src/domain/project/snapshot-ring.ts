/**
 * Autosave retention policy (T101), pure and headless: a bounded ring of the most
 * recent snapshots, plus periodic "pinned" snapshots that survive the ring so a long
 * session keeps coarse history without unbounded storage.
 *
 * Locked defaults: keep the last 20, pin one per 10 minutes. Pinned snapshots are
 * additionally capped (oldest evicted first) so an installation running for days
 * cannot fill the origin's quota.
 */

export interface SnapshotMeta {
  key: string;
  revision: number;
  savedAt: number; // epoch ms
  pinned: boolean;
}

export interface RetentionOptions {
  keepRecent?: number;
  pinIntervalMs?: number;
  maxPinned?: number;
}

export interface RetentionPlan {
  /** Whether the incoming snapshot should be stored pinned. */
  pinIncoming: boolean;
  /** Keys to delete after the incoming snapshot is stored. */
  evictKeys: string[];
}

export function planRetention(
  existing: readonly SnapshotMeta[],
  incoming: { key: string; revision: number; savedAt: number },
  options: RetentionOptions = {},
): RetentionPlan {
  const keepRecent = options.keepRecent ?? 20;
  const pinIntervalMs = options.pinIntervalMs ?? 10 * 60_000;
  const maxPinned = options.maxPinned ?? 48;

  const newestPinnedAt = existing
    .filter((meta) => meta.pinned)
    .reduce((newest, meta) => Math.max(newest, meta.savedAt), Number.NEGATIVE_INFINITY);
  const pinIncoming = incoming.savedAt - newestPinnedAt >= pinIntervalMs;

  const all: SnapshotMeta[] = [
    ...existing.filter((meta) => meta.key !== incoming.key),
    { ...incoming, pinned: pinIncoming },
  ].sort((a, b) => b.savedAt - a.savedAt || b.revision - a.revision);

  const evictKeys: string[] = [];
  let recentKept = 0;
  let pinnedKept = 0;
  for (const meta of all) {
    if (meta.pinned) {
      pinnedKept += 1;
      if (pinnedKept > maxPinned) evictKeys.push(meta.key);
      continue;
    }
    recentKept += 1;
    if (recentKept > keepRecent) evictKeys.push(meta.key);
  }

  return { pinIncoming, evictKeys: evictKeys.filter((key) => key !== incoming.key) };
}
