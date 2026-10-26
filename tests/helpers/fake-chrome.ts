import { vi } from 'vitest';

type Listener<A extends unknown[]> = (...args: A) => void;

export class FakeEvent<A extends unknown[]> {
  listeners = new Set<Listener<A>>();
  addListener = (l: Listener<A>) => void this.listeners.add(l);
  removeListener = (l: Listener<A>) => void this.listeners.delete(l);
  hasListener = (l: Listener<A>) => this.listeners.has(l);
  emit(...args: A) {
    for (const l of [...this.listeners]) l(...args);
  }
}

export class FakeStorageArea {
  data: Record<string, unknown> = {};
  onChanged: FakeEvent<[Record<string, chrome.storage.StorageChange>]> | undefined;
  constructor(
    private readonly changed?: FakeEvent<[Record<string, chrome.storage.StorageChange>, string]>,
    private readonly area = 'local',
  ) {}
  async get(keys?: string | string[] | Record<string, unknown> | null) {
    if (keys == null) return structuredClone(this.data);
    const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
    const out: Record<string, unknown> = {};
    for (const k of list) if (k in this.data) out[k] = structuredClone(this.data[k]);
    return out;
  }
  async set(items: Record<string, unknown>) {
    const changes: Record<string, chrome.storage.StorageChange> = {};
    for (const [k, v] of Object.entries(items)) {
      changes[k] = { oldValue: this.data[k], newValue: structuredClone(v) };
      this.data[k] = structuredClone(v);
    }
    this.changed?.emit(changes, this.area);
  }
  async remove(keys: string | string[]) {
    for (const k of typeof keys === 'string' ? [keys] : keys) delete this.data[k];
  }
  async clear() {
    this.data = {};
  }
}

/** Installs a minimal in-memory chrome API on globalThis. Extend per test as needed. */
export function installFakeChrome() {
  const storageChanged = new FakeEvent<[Record<string, chrome.storage.StorageChange>, string]>();
  const fake = {
    runtime: {
      id: 'test-extension-id',
      sendMessage: vi.fn(async () => undefined),
      onMessage: new FakeEvent<[unknown, chrome.runtime.MessageSender, (r: unknown) => void]>(),
      getURL: (p: string) => `chrome-extension://test-extension-id/${p}`,
    },
    storage: {
      local: new FakeStorageArea(storageChanged, 'local'),
      session: new FakeStorageArea(storageChanged, 'session'),
      onChanged: storageChanged,
    },
    i18n: { getMessage: vi.fn(() => '') },
  };
  (globalThis as unknown as { chrome: unknown }).chrome = fake;
  return fake;
}

export type FakeChrome = ReturnType<typeof installFakeChrome>;
