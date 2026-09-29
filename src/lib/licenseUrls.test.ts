import { describe, expect, it } from "vitest";
import { licenseUrlFor } from "./licenseUrls";
import { MODEL_REGISTRY } from "./models.generated";

describe("licenseUrlFor", () => {
  it("maps known SPDX licenses", () => {
    const cases = [
      ["Apache-2.0", "https://www.apache.org/licenses/LICENSE-2.0"],
      ["CC BY-NC 4.0", "https://creativecommons.org/licenses/by-nc/4.0/"],
      ["MIT", "https://opensource.org/licenses/MIT"],
    ] as const;
    for (const [license, url] of cases) {
      expect(licenseUrlFor(license)).toBe(url);
    }
  });

  it("returns null for unknown licenses", () => {
    expect(licenseUrlFor("BSD-3-Clause")).toBeNull();
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
