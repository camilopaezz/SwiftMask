import { describe, expect, it } from "vitest";
import { APP_LINKS, licenseUrlFor } from "./licenseUrls";
import { MODEL_REGISTRY } from "./models.generated";

describe("licenseUrlFor", () => {
  it("maps Apache-2.0", () => {
    expect(licenseUrlFor("Apache-2.0")).toBe(
      "https://www.apache.org/licenses/LICENSE-2.0",
    );
  });

  it("maps CC BY-NC 4.0", () => {
    expect(licenseUrlFor("CC BY-NC 4.0")).toBe(
      "https://creativecommons.org/licenses/by-nc/4.0/",
    );
  });

  it("returns null for unknown licenses", () => {
    expect(licenseUrlFor("MIT")).toBeNull();
    expect(licenseUrlFor("")).toBeNull();
    expect(licenseUrlFor("Proprietary")).toBeNull();
  });

  it("is exact-match only (no fuzzy casing)", () => {
    expect(licenseUrlFor("apache-2.0")).toBeNull();
    expect(licenseUrlFor("CC BY-NC 4.0 ")).toBeNull();
  });

  it("covers every MODEL_REGISTRY license string", () => {
    for (const model of MODEL_REGISTRY) {
      expect(
        licenseUrlFor(model.license),
        `missing URL for ${model.id} license ${model.license}`,
      ).toMatch(/^https:\/\//);
    }
  });
});

describe("APP_LINKS", () => {
  it("defines repo, issues, and MIT license URLs", () => {
    expect(APP_LINKS.repo).toBe("https://github.com/camilopaezz/SwiftMask");
    expect(APP_LINKS.issues).toBe(
      "https://github.com/camilopaezz/SwiftMask/issues",
    );
    expect(APP_LINKS.mit).toBe(
      "https://github.com/camilopaezz/SwiftMask/blob/main/LICENSE",
    );
  });
});
