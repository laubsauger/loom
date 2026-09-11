/* global require, __dirname */
/* eslint-disable @typescript-eslint/no-require-imports */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');

test('desktop startup and native build do not depend on experimental code', () => {
  const directories = [__dirname, join(__dirname, '../devices/native')];
  for (const directory of directories) {
    for (const name of readdirSync(directory)) {
      if (!/\.(cjs|mjs|ts)$/.test(name) || name.includes('.test.')) continue;
      const source = readFileSync(join(directory, name), 'utf8');
      assert.doesNotMatch(source, /['"`][^'"`\n]*experiments\//, name);
    }
  }
  const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8'));
  assert.equal(pkg.scripts['desktop:dev'], 'node src/desktop/run.mjs');
  assert.equal(pkg.scripts['desktop:test'], 'node src/desktop/run.mjs --smoke');
  assert.match(pkg.devDependencies.electron, /^\d+\.\d+\.\d+(?:-[\w.]+)?$/);
});

test('native pixel readback is compiled only for the explicit export oracle', () => {
  const source = readFileSync(join(__dirname, '../devices/native/syphon-output.mm'), 'utf8');
  const production = source.replace(/#ifdef LOOM_EXPORT_ORACLE\n[\s\S]*?(?:#else\n([\s\S]*?))?#endif/g, '$1');
  assert.doesNotMatch(production, /toBuffer:oracle|"inspect"/);
  assert.match(production, /"publish"/);
});
