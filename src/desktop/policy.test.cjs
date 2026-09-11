/* global require */
/* eslint-disable @typescript-eslint/no-require-imports */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateOrigin, allowNavigation, allowPopup, webPreferences } = require('./policy.cjs');
test('only the owned loopback origin can host the development app', () => {
  assert.equal(validateOrigin('http://127.0.0.1:5187/'), 'http://127.0.0.1:5187');
  for (const value of ['https://example.com/', 'file:///app.html', 'http://127.0.0.1/',
    'http://127.0.0.1:5187/other', 'http://user@127.0.0.1:5187/', 'http://127.0.0.1.evil:5187/']) {
    assert.throws(() => validateOrigin(value));
  }
  assert.equal(allowNavigation('http://127.0.0.1:5187/', 'http://127.0.0.1:5187'), true);
  for (const value of ['javascript:alert(1)', 'file:///etc/passwd', 'https://example.com', 'http://127.0.0.1:5188/']) {
    assert.equal(allowNavigation(value, 'http://127.0.0.1:5187'), false);
  }
});
test('only named blank pane windows are allowed, with renderer privileges disabled', () => {
  assert.equal(allowPopup({ url: 'about:blank', frameName: 'loom-viewer' }), true);
  assert.equal(allowPopup({ url: 'https://example.com', frameName: 'loom-viewer' }), false);
  assert.equal(allowPopup({ url: 'about:blank', frameName: 'external' }), false);
  assert.equal(webPreferences.sandbox, true);
  assert.equal(webPreferences.contextIsolation, true);
  assert.equal(webPreferences.webSecurity, true);
  assert.equal(webPreferences.nodeIntegration, false);
  assert.equal(webPreferences.nodeIntegrationInWorker, false);
  assert.equal(webPreferences.webviewTag, false);
});
