/* global require, module */
/* eslint-disable @typescript-eslint/no-require-imports */
const host = require('../main.cjs');
// Playwright's explicit-executable path omits its own loader. Coordinate window
// creation without that loader's Chromium switches or patched Electron APIs.
globalThis.__playwright_run = () => host.startDesktop();
module.exports = host;
