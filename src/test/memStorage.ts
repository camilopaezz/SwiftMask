import { afterEach, beforeEach, vi } from "vitest";

export class MemStorage implements Storage {
  private store = new Map<string, string>();
  get length() {
    return this.store.size;
  }
  clear() {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.store.set(key, String(value));
  }
  removeItem(key: string) {
    this.store.delete(key);
  }
  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null;
  }
}

export function useMemStorage() {
  beforeEach(() => {
    vi.stubGlobal("localStorage", new MemStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
}
