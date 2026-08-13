import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import { shouldProceedWithOverwrite } from "./overwrite";

describe("shouldProceedWithOverwrite", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("proceeds when output does not exist", async () => {
    const exists = vi.fn().mockResolvedValue(false);
    const ask = vi.fn();
    const result = await shouldProceedWithOverwrite(
      "/tmp/out.png",
      exists,
      ask,
    );
    expect(result).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it("proceeds when output exists and user confirms", async () => {
    const exists = vi.fn().mockResolvedValue(true);
    const ask = vi.fn().mockResolvedValue(true);
    const result = await shouldProceedWithOverwrite(
      "/tmp/out.png",
      exists,
      ask,
    );
    expect(result).toBe(true);
    expect(ask).toHaveBeenCalledWith(
      i18n.t("overwrite.singleAsk", { path: "/tmp/out.png" }),
    );
  });

  it("skips when output exists and user declines", async () => {
    const exists = vi.fn().mockResolvedValue(true);
    const ask = vi.fn().mockResolvedValue(false);
    const result = await shouldProceedWithOverwrite(
      "/tmp/out.png",
      exists,
      ask,
    );
    expect(result).toBe(false);
  });
});
