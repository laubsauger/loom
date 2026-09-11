/* global module */

// Keep the document/IPC receiver alive until all native input GPU references drain.
// A rejected drain never authorizes navigation or force-releases a lease.
function installUnloadGate({ window, inputs, onError }) {
  const contents = window.webContents;
  // This fixed-document shell has reload and close, not a browser navigation UI.
  // Reload asks beforeunload BEFORE did-start-navigation, so that event cannot
  // identify it. BrowserWindow's close event identifies the other operation.
  let closing = false;
  let draining = false;
  window.on('close', () => { closing = true; });
  contents.on('did-navigate', () => { closing = false; draining = false; });
  contents.on('will-prevent-unload', () => {
    if (draining) return;
    draining = true;
    void (async () => {
      await contents.executeJavaScript('window.loomDesktop.input.prepareForUnload()');
      await inputs.retireOwner(contents);
      await contents.executeJavaScript('window.loomDesktop.input.commitUnload()');
      if (closing) window.close();
      else contents.reload();
    })().catch(error => { draining = false; onError(error); });
  });
}
module.exports = { installUnloadGate };
