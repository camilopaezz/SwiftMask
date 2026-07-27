import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { licenseUrlFor } from "./licenseUrls";
import type { ModelMeta } from "./models";
import { MODEL_REGISTRY } from "./models.generated";
import {
  hasNcLicenseAck,
  isNonCommercialModel,
  NC_LICENSE_ACK_KEY,
  NC_LICENSE_MODAL_COPY,
  needsNcLicenseAck,
  setNcLicenseAck,
  shouldShowNcBadge,
} from "./ncLicense";

class MemStorage implements Storage {
  private store = new Map<string, string>();
  get length() {
    return this.store.size;
  }
  clear() {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
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

function useMemStorage() {
  beforeEach(() => {
    vi.stubGlobal("localStorage", new MemStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
}

function meta(id: string, overrides: Partial<ModelMeta> = {}): ModelMeta {
  const base = MODEL_REGISTRY.find((m) => m.id === id);
  if (!base) {
    throw new Error(`unknown model id: ${id}`);
  }
  return { ...base, downloaded: false, ...overrides };
}

describe("isNonCommercialModel", () => {
  it("detects NC from the license field", () => {
    expect(isNonCommercialModel(meta("rmbg-1.4"))).toBe(true);
    expect(isNonCommercialModel(meta("rmbg-2.0"))).toBe(true);
  });

  it("returns false for commercial licenses", () => {
    expect(isNonCommercialModel(meta("u2netp"))).toBe(false);
    expect(isNonCommercialModel(meta("isnet-general-use"))).toBe(false);
  });
});

describe("NC license acknowledgment", () => {
  useMemStorage();

  it("starts unacknowledged", () => {
    expect(hasNcLicenseAck()).toBe(false);
    expect(localStorage.getItem(NC_LICENSE_ACK_KEY)).toBeNull();
  });

  it("persists a global acknowledgment", () => {
    setNcLicenseAck();
    expect(hasNcLicenseAck()).toBe(true);
    expect(localStorage.getItem(NC_LICENSE_ACK_KEY)).toBe("1");
  });
});

describe("shouldShowNcBadge", () => {
  it("shows only for ready NC models", () => {
    expect(shouldShowNcBadge(meta("rmbg-1.4", { downloaded: true }))).toBe(
      true,
    );
    expect(shouldShowNcBadge(meta("rmbg-2.0", { downloaded: true }))).toBe(
      true,
    );
  });

  it("hides before download and for commercial models", () => {
    expect(shouldShowNcBadge(meta("rmbg-1.4"))).toBe(false);
    expect(shouldShowNcBadge(meta("u2netp", { bundled: true }))).toBe(false);
    expect(
      shouldShowNcBadge(meta("isnet-general-use", { downloaded: true })),
    ).toBe(false);
  });
});

describe("needsNcLicenseAck", () => {
  useMemStorage();

  it("requires acknowledgment on first NC download only", () => {
    expect(needsNcLicenseAck(meta("rmbg-1.4"))).toBe(true);
    setNcLicenseAck();
    expect(needsNcLicenseAck(meta("rmbg-2.0"))).toBe(false);
  });

  it("skips when the model is already on disk", () => {
    expect(needsNcLicenseAck(meta("rmbg-1.4", { downloaded: true }))).toBe(
      false,
    );
  });

  it("skips for commercial models", () => {
    expect(needsNcLicenseAck(meta("isnet-general-use"))).toBe(false);
  });
});

describe("NC_LICENSE_MODAL_COPY", () => {
  it("uses the shared CC BY-NC 4.0 license URL", () => {
    expect(NC_LICENSE_MODAL_COPY.licenseLabel).toBe("CC BY-NC 4.0");
    expect(NC_LICENSE_MODAL_COPY.licenseUrl).toBe(
      licenseUrlFor("CC BY-NC 4.0"),
    );
    expect(NC_LICENSE_MODAL_COPY.licenseUrl).toBe(
      "https://creativecommons.org/licenses/by-nc/4.0/",
    );
  });
});
