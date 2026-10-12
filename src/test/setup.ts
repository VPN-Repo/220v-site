import "@testing-library/jest-dom";

// Node 25+ defines its own global localStorage (undefined without --localstorage-file),
// which shadows jsdom's storage; install in-memory Web Storage for tests.
function createMemoryStorage(): Storage {
  let items = new Map<string, string>();
  return {
    get length() { return items.size; },
    clear: () => { items = new Map(); },
    getItem: (key) => items.get(String(key)) ?? null,
    key: (index) => Array.from(items.keys())[index] ?? null,
    removeItem: (key) => { items.delete(String(key)); },
    setItem: (key, value) => { items.set(String(key), String(value)); },
  };
}

for (const name of ["localStorage", "sessionStorage"] as const) {
  if (typeof globalThis[name]?.setItem !== "function") {
    const storage = createMemoryStorage();
    Object.defineProperty(globalThis, name, { configurable: true, value: storage });
    Object.defineProperty(window, name, { configurable: true, value: storage });
  }
}

if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
  }),
});
