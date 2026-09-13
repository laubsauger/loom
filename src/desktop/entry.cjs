/* global require */
/* eslint-disable @typescript-eslint/no-require-imports */
// Electron's CJS loader need not identify require.main as this module. Keep
// normal application startup explicit, independent of Node entry heuristics.
require('./main.cjs').startDesktop();
