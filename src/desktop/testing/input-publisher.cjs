/* global require */
/* eslint-disable @typescript-eslint/no-require-imports */
const { app } = require('electron');
const process = require('node:process');
const console = require('node:console');
const { setInterval, clearInterval } = require('node:timers');
const [addon, profile] = process.argv.slice(2);
app.setPath('userData', profile);
app.whenReady().then(() => {
  const fixture = require(addon);
  const uuid = fixture.start(); fixture.resize1080();
  const timer = setInterval(() => fixture.publish(73), 33);
  console.log('LOOM_INPUT_PUBLISHER', uuid);
  process.on('SIGTERM', () => { clearInterval(timer); fixture.stop(); app.quit(); });
});
