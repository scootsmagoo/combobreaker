// Minimal in-memory chrome.storage for unit tests.
function area() {
  let data = {};
  return {
    async get(keys) {
      if (keys == null) return structuredClone(data);
      const list = typeof keys === "string" ? [keys] : keys;
      const out = {};
      for (const k of list) if (k in data) out[k] = structuredClone(data[k]);
      return out;
    },
    async set(items) {
      Object.assign(data, structuredClone(items));
    },
    async remove(keys) {
      for (const k of typeof keys === "string" ? [keys] : keys) delete data[k];
    },
    _reset(next = {}) {
      data = structuredClone(next);
    },
    _dump() {
      return structuredClone(data);
    },
  };
}

export function installFakeChrome() {
  const chrome = {
    storage: { sync: area(), local: area(), session: area() },
    runtime: { getManifest: () => ({ version: "0.0.0-test" }) },
  };
  globalThis.chrome = chrome;
  return chrome;
}
