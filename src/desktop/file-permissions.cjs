/* global require, module */
/* eslint-disable @typescript-eslint/no-require-imports */
const { isAbsolute } = require('node:path');
const { allowNavigation } = require('./policy.cjs');
const { createMediaPermissions } = require('./media-permissions.cjs');

function installFilePermissions({ session, origin, confirm, report, requestSystemAccess, notify }) {
  const pending = new WeakSet();
  const media = createMediaPermissions({ origin, confirm, report, requestSystemAccess, notify });
  // No broad grant cache. Chromium owns its document/path-scoped grants; checks
  // without one must reach the explicit request below, never auto-approve.
  session.setPermissionCheckHandler((...args) => media.check(...args));
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (media.handles(permission)) { media.request(contents, permission, callback, details); return; }
    if (permission !== 'fileSystem' || !contents || contents.isDestroyed() ||
        !allowNavigation(contents.getURL(), origin) ||
        !allowNavigation(details?.requestingUrl, origin) ||
        typeof details.filePath !== 'string' || !isAbsolute(details.filePath) ||
        details.isDirectory !== false ||
        !['readable', 'writable'].includes(details.fileAccessType) || pending.has(contents)) {
      report(`Denied desktop permission: ${permission}`);
      callback(false);
      return;
    }
    // Electron reports isMainFrame=false for fileSystem even for the main frame.
    // Validate both URLs instead. Any navigation revokes this outstanding prompt.
    let settled = false;
    const settle = granted => {
      if (settled) return;
      settled = true;
      pending.delete(contents);
      contents.removeListener('did-start-navigation', revoke);
      contents.removeListener('destroyed', revoke);
      callback(granted);
    };
    const revoke = () => settle(false);
    pending.add(contents);
    contents.on('did-start-navigation', revoke);
    contents.once('destroyed', revoke);
    void Promise.resolve().then(() => {
      if (settled) return false;
      return confirm(contents, {
        title: 'Loom file access',
        message: details.fileAccessType === 'writable' ? 'Allow Loom to modify this file?' : 'Allow Loom to read this file?',
        detail: details.filePath,
        buttons: ['Deny', 'Allow'], defaultId: 0, cancelId: 0, noLink: true,
      });
    }).then(allowed => settle(allowed === true && !contents.isDestroyed() &&
      allowNavigation(contents.getURL(), origin)), error => {
      report(`File permission dialog failed: ${String(error)}`);
      settle(false);
    });
  });
  // Never turn a protected OS path into an ordinary file grant.
  session.on('file-system-access-restricted', (_event, _details, callback) => {
    report('Denied restricted filesystem path');
    callback('deny');
  });
  return media;
}

module.exports = { installFilePermissions };
