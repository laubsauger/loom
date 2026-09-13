/* global module, URL */
function createMediaPermissions({ origin, confirm, report, requestSystemAccess, notify }) {
  const documents = new WeakMap(), queues = new WeakMap();
  const editor = `${origin}/`;
  const handles = permission => permission === 'media' || permission === 'speaker-selection';
  const actualEditor = contents => !!contents && !contents.isDestroyed() && contents.getURL() === editor;
  const sameOrigin = value => typeof value === 'string' && URL.canParse(value) && new URL(value).origin === origin;
  const security = details => details?.securityOrigin === undefined || sameOrigin(details.securityOrigin);
  const live = (contents, document) => documents.get(contents) === document &&
    actualEditor(contents) && contents.mainFrame === document.frame;
  function documentFor(contents) {
    let document = documents.get(contents);
    if (document) return document;
    document = { frame: contents.mainFrame, generation: 0, decisions: new Map(), effective: new Map(), pending: new Map(), callbacks: new Set() };
    const cancel = () => {
      document.generation++;
      document.pending.clear();
      for (const settle of [...document.callbacks]) settle(false);
      if (actualEditor(contents)) notify(contents);
    };
    const retire = () => {
      documents.delete(contents);
      contents.removeListener('did-start-navigation', cancel);
      contents.removeListener('did-navigate', retire);
      contents.removeListener('destroyed', retire);
      contents.removeListener('render-process-gone', retire);
      document.decisions.clear();
      document.effective.clear();
      cancel();
    };
    documents.set(contents, document);
    // Provisional navigation can be cancelled while existing capture continues.
    // Cancel pending work immediately, but retain completed document consent
    // until main-document navigation commits or its renderer dies.
    contents.on('did-start-navigation', cancel);
    contents.on('did-navigate', retire);
    contents.once('destroyed', retire);
    contents.on('render-process-gone', retire);
    return document;
  }
  function consent(contents, document, type) {
    if (document.effective.has(type)) return Promise.resolve(document.effective.get(type));
    if (document.pending.has(type)) return document.pending.get(type);
    const generation = document.generation;
    const current = () => generation === document.generation && live(contents, document);
    const label = { video: 'camera', audio: 'microphone', speaker: 'audio output device', ndi: 'local network for NDI' }[type];
    const pending = (queues.get(contents) ?? Promise.resolve()).then(async () => {
      if (!current()) return false;
      let allowed = await confirm(contents, {
        title: 'Loom media access', message: `Allow Loom to use your ${label}?`,
        detail: type === 'ndi' ? 'NDI discovers sources and exchanges video on your local network. macOS may ask separately.'
          : 'A node in the current project requested this device.',
        buttons: ['Deny', 'Allow'], defaultId: 0, cancelId: 0, noLink: true,
      });
      if (!current()) return false;
      document.decisions.set(type, allowed === true);
      if (allowed === true && (type === 'audio' || type === 'video'))
        allowed = await requestSystemAccess(type === 'video' ? 'camera' : 'microphone');
      if (!current()) return false;
      document.effective.set(type, allowed === true);
      return allowed === true;
    }).catch(error => {
      report(`Media permission failed: ${String(error)}`);
      if (current()) document.effective.set(type, false);
      return false;
    }).finally(() => {
      if (document.pending.get(type) === pending) {
        document.pending.delete(type);
        if (actualEditor(contents)) notify(contents);
      }
    });
    document.pending.set(type, pending);
    queues.set(contents, pending);
    notify(contents);
    return pending;
  }
  function requestTypes(contents, types, callback) {
    const document = documentFor(contents);
    let settled = false;
    const settle = granted => {
      if (settled) return;
      settled = true; document.callbacks.delete(settle); callback(granted);
    };
    document.callbacks.add(settle);
    void Promise.all([...new Set(types)].map(type => consent(contents, document, type)))
      .then(grants => settle(live(contents, document) && grants.every(Boolean)));
  }
  return {
    handles,
    // Called only by authenticated native IPC, never by an arbitrary Chromium
    // permission string. The SDK cannot discover/open until this resolves true.
    requestNdi(contents) {
      if (!actualEditor(contents) || !contents.mainFrame) return Promise.resolve(false);
      return new Promise(resolve => requestTypes(contents, ['ndi'], resolve));
    },
    snapshot(contents) {
      if (!actualEditor(contents)) throw new Error('Permissions require the app main frame');
      const document = documents.get(contents);
      return ['video', 'audio', 'speaker', 'ndi'].map(type => ({
        id: { video: 'camera', audio: 'microphone', speaker: 'speaker', ndi: 'ndi' }[type],
        decision: document?.pending.has(type) ? 'pending'
          : !document?.decisions.has(type) ? 'not-requested'
            : document.decisions.get(type) ? 'allowed' : 'denied',
      }));
    },
    request(contents, permission, callback, details) {
      const types = permission === 'speaker-selection' ? ['speaker'] : details?.mediaTypes;
      if (!handles(permission) || !actualEditor(contents) || !contents.mainFrame ||
          details?.isMainFrame !== true || details.requestingUrl !== editor || !security(details) ||
          !Array.isArray(types) || !types.length || types.some(type => !['audio', 'video', 'speaker'].includes(type)) ||
          (permission === 'media' && types.includes('speaker'))) {
        report(`Denied desktop permission: ${permission} (${JSON.stringify({
          editor: actualEditor(contents), mainFrame: details?.isMainFrame,
          requestingEditor: details?.requestingUrl === editor, securityOrigin: security(details), mediaTypes: types,
        })})`); callback(false); return;
      }
      requestTypes(contents, types, callback);
    },
    check(contents, permission, requestingOrigin, details) {
      if (!handles(permission) || !actualEditor(contents) || !sameOrigin(requestingOrigin) ||
          details?.isMainFrame !== true || !security(details) ||
          (details.requestingUrl !== undefined && details.requestingUrl !== editor)) return false;
      const type = permission === 'speaker-selection' ? 'speaker' : details.mediaType;
      if (!['audio', 'video', 'speaker'].includes(type) || (permission === 'media' && type === 'speaker')) return false;
      const document = documents.get(contents);
      return !!document && live(contents, document) && document.effective.get(type) === true;
    },
  };
}
module.exports = { createMediaPermissions };
