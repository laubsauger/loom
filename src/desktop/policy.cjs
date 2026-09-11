/* global module, URL */
const webPreferences = Object.freeze({ sandbox: true, contextIsolation: true,
  nodeIntegration: false, nodeIntegrationInWorker: false, webSecurity: true,
  webviewTag: false, allowRunningInsecureContent: false });

function validateOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Desktop development requires an explicit http://127.0.0.1:port/ origin');
  }
  return url.origin;
}

function allowNavigation(value, origin) {
  return URL.canParse(value) && new URL(value).origin === origin;
}

function allowPopup({ url, frameName }) {
  return url === 'about:blank' && /^loom-[a-z0-9-]+$/i.test(frameName);
}

module.exports = { webPreferences, validateOrigin, allowNavigation, allowPopup };
