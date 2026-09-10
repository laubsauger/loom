/* global require, process, console */
/* eslint-disable @typescript-eslint/no-require-imports */
const native = require(process.env.SHADERLOOM_TEXTURE_ADDON);
native.prepare(0, 0);
console.log('NATIVE_TEXTURE_EXPECTED_CONSUMER_EXIT: outstanding frame deliberately not acknowledged');
process.exit(17);
