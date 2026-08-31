/**
 * T592 — the four permanent "unhandled errors" were jsdom gaps, not product bugs, and
 * they made every suite report lie by omission: `0 failed | 4 errors` exits 1, so
 * anyone reading the failure count called it green and anyone reading the exit code
 * called it broken (§V469's exact case, in our own tooling). The gaps are filled here,
 * at the environment boundary, so product code stays written for real browsers.
 */

// jsdom 30 implements URL.createObjectURL but not revokeObjectURL; project-io.ts
// revokes on a timer after a download click, which is correct in every real browser.
if (typeof URL.revokeObjectURL !== "function") {
  URL.revokeObjectURL = () => {};
}

// CodeMirror's measure pass creates a Range and asks for its client rects; jsdom's
// Range never grew the CSSOM-view methods. Empty geometry is the honest jsdom answer
// (nothing is painted), and CodeMirror treats it as a zero-size viewport.
if (typeof Range.prototype.getClientRects !== "function") {
  Range.prototype.getClientRects = function getClientRects(): DOMRectList {
    return Object.assign([], { item: () => null }) as unknown as DOMRectList;
  };
}
if (typeof Range.prototype.getBoundingClientRect !== "function") {
  Range.prototype.getBoundingClientRect = function getBoundingClientRect(): DOMRect {
    return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) } as DOMRect;
  };
}
