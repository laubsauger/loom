import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactDigest, verifyArtifact } from './build-cache.mjs';

test('cached framework is reusable unchanged, but file changes are explicit errors', () => {
  const framework = mkdtempSync(join(tmpdir(), 'loom-cache-test-'));
  try {
    mkdirSync(join(framework, 'Versions/A'), { recursive: true });
    writeFileSync(join(framework, 'Versions/A/Syphon'), 'binary');
    symlinkSync('Versions/A/Syphon', join(framework, 'Syphon'));
    const manifest = { framework, artifactDigest: artifactDigest(framework) };
    assert.equal(verifyArtifact(manifest), framework);
    assert.equal(verifyArtifact(manifest), framework);
    writeFileSync(join(framework, 'Versions/A/Syphon'), 'changed');
    assert.throws(() => verifyArtifact(manifest), /Cached Syphon framework changed/);
  } finally { rmSync(framework, { recursive: true }); }
});

test('framework link changes are detected without following the new target', () => {
  const framework = mkdtempSync(join(tmpdir(), 'loom-cache-test-'));
  try {
    symlinkSync('original', join(framework, 'Current'));
    const manifest = { framework, artifactDigest: artifactDigest(framework) };
    unlinkSync(join(framework, 'Current'));
    symlinkSync('different', join(framework, 'Current'));
    assert.throws(() => verifyArtifact(manifest), /Cached Syphon framework changed/);
  } finally { rmSync(framework, { recursive: true }); }
});
