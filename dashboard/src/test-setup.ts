/**
 * Test-only Storage polyfill.
 *
 * In this Node/happy-dom combination `window.localStorage` is not provided
 * (Node's experimental global storage is unavailable without
 * `--localstorage-file`). The application and its i18n tests rely on the
 * standard Storage API, so provide an in-memory implementation for tests.
 */
class MemoryStorage implements Storage {
  private values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, String(value));
  }
}

if (typeof window !== "undefined" && !window.localStorage) {
  const storage = new MemoryStorage();
  Object.defineProperty(window, "localStorage", { value: storage, configurable: true });
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
}
