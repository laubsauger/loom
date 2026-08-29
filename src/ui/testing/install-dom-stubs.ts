/**
 * jsdom gaps that Radix and react-resizable-panels rely on.
 * Test-only helper; nothing in the app imports it.
 */

type Mutable = Record<string, unknown>;

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function domRect(x: number, y: number, width: number, height: number): DOMRect {
  return {
    x,
    y,
    width,
    height,
    top: y,
    left: x,
    right: x + width,
    bottom: y + height,
    toJSON: () => ({}),
  };
}

export function installDomStubs(): void {
  const globals = globalThis as unknown as Mutable;

  if (typeof globals["ResizeObserver"] === "undefined") {
    globals["ResizeObserver"] = ResizeObserverStub;
  }

  if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
    (window as unknown as Mutable)["matchMedia"] = (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    });
  }

  if (typeof Element !== "undefined") {
    const proto = Element.prototype as unknown as Mutable;
    proto["scrollIntoView"] ??= () => {};
    proto["hasPointerCapture"] ??= () => false;
    proto["setPointerCapture"] ??= () => {};
    proto["releasePointerCapture"] ??= () => {};

    // jsdom gives every element a 0x0 rect at the origin. react-resizable-panels
    // watches pointer events at the document and swallows any that land inside a
    // divider's hit area — with everything stacked at (0, 0) that is every click
    // in the app. Park the dividers off-screen so pointer interaction behaves.
    proto["getBoundingClientRect"] = function getBoundingClientRect(this: Element): DOMRect {
      return this.hasAttribute("data-resize-handle")
        ? domRect(-1000, -1000, 1, 1)
        : domRect(0, 0, 1024, 768);
    };
  }
}

/** In-memory `LayoutStorage` / `Storage`-shaped double for persistence tests. */
export function createMemoryStorage(seed: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    getItem: (key: string): string | null => map.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      map.set(key, value);
    },
    removeItem: (key: string): void => {
      map.delete(key);
    },
    get size(): number {
      return map.size;
    },
    keys: (): string[] => [...map.keys()],
  };
}
