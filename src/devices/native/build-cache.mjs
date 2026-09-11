import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

// Hash links themselves, not their targets; framework version links stay intact.
export function artifactDigest(directory) {
  const hash = createHash('sha256');
  function visit(relative) {
    for (const entry of readdirSync(join(directory, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(relative, entry.name);
      hash.update(JSON.stringify([path, entry.isDirectory(), entry.isSymbolicLink()]));
      if (entry.isDirectory()) visit(path);
      else if (entry.isSymbolicLink()) hash.update(JSON.stringify(readlinkSync(join(directory, path))));
      else hash.update(createHash('sha256').update(readFileSync(join(directory, path))).digest());
    }
  }
  visit('');
  return hash.digest('hex');
}

export function verifyArtifact(manifest) {
  if (artifactDigest(manifest.framework) !== manifest.artifactDigest) {
    throw new Error(`Cached Syphon framework changed: ${manifest.framework}`);
  }
  return manifest.framework;
}
