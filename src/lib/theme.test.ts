import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMemStorage } from "../test/memStorage";
import {
  applyTheme,
  persistTheme,
  readStoredTheme,
  THEME_STORAGE_KEY,
} from "./theme";

describe("readStoredTheme", () => {
  useMemStorage();

  it("returns null when nothing is stored", () => {
    expect(readStoredTheme()).toBeNull();
  });

  it("returns a valid stored theme", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    expect(readStoredTheme()).toBe("dark");
  });

  it("rejects an invalid value", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "hot-pink");
    expect(readStoredTheme()).toBeNull();
  });
});

describe("applyTheme", () => {
  beforeEach(() => document.documentElement.removeAttribute("data-theme"));

  it("removes data-theme for system so the media query drives it", () => {
    document.documentElement.setAttribute("data-theme", "dark");
    applyTheme("system");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });
});

describe("storage resilience", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("readStoredTheme tolerates a throwing localStorage", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
    } as unknown as Storage);
    expect(readStoredTheme()).toBeNull();
  });

  it("persistTheme tolerates a throwing localStorage", () => {
    vi.stubGlobal("localStorage", {
      setItem: () => {
        throw new Error("denied");
      },
    } as unknown as Storage);
    expect(() => persistTheme("dark")).not.toThrow();
  });
});
