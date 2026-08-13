import { describe, expect, it } from "vitest";
import { resolveAppLanguage } from "./i18n";

describe("resolveAppLanguage", () => {
  it("maps Spanish tags to es", () => {
    expect(resolveAppLanguage("es")).toBe("es");
    expect(resolveAppLanguage("es-ES")).toBe("es");
    expect(resolveAppLanguage("es-MX")).toBe("es");
    expect(resolveAppLanguage("es-419")).toBe("es");
  });

  it("maps non-Spanish to en", () => {
    expect(resolveAppLanguage("en")).toBe("en");
    expect(resolveAppLanguage("en-US")).toBe("en");
    expect(resolveAppLanguage("fr-FR")).toBe("en");
    expect(resolveAppLanguage(null)).toBe("en");
    expect(resolveAppLanguage(undefined)).toBe("en");
  });
});
