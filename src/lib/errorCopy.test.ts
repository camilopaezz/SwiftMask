import { describe, expect, it } from "vitest";
import {
  formatError,
  formatFallbackNotice,
  sanitizeTechnicalMessage,
} from "./errorCopy";

describe("formatError", () => {
  it("maps known codes to titles", () => {
    expect(formatError("network", "request failed: timeout").title).toBe(
      "Network error",
    );
    expect(formatError("model_corrupt", "SHA-256 mismatch").body).toMatch(
      /download/i,
    );
    expect(formatError("oom", "CUDA out of memory").title).toBe(
      "Out of memory",
    );
  });

  it("falls back to sanitized technical message", () => {
    expect(formatError("custom_code", "model error: weird boom").title).toBe(
      "weird boom",
    );
  });

  it("keeps unknown title and attaches sanitized body", () => {
    const copy = formatError("unknown", "permission denied");
    expect(copy.title).toBe("Something went wrong");
    expect(copy.body).toBe("permission denied");
  });

  it("handles cancelled without treating as failure chrome", () => {
    expect(formatError("cancelled", "cancelled").title).toBe("Cancelled");
  });
});

describe("sanitizeTechnicalMessage", () => {
  it("strips known prefixes", () => {
    expect(sanitizeTechnicalMessage("inference error: boom")).toBe("boom");
    expect(sanitizeTechnicalMessage("  image io error: bad  ")).toBe("bad");
  });
});

describe("formatFallbackNotice", () => {
  it("mentions CPU finish and Settings EP", () => {
    const copy = formatFallbackNotice("directml", "cpu");
    expect(copy.title).toMatch(/CPU/i);
    expect(copy.body).toMatch(/Settings/i);
    expect(copy.body).toMatch(/DirectML/i);
  });
});

describe("inventory copy helpers", () => {
  it("covers first-run and reveal helpers", async () => {
    const {
      formatFirstRunGpuDegradeNotice,
      formatModelsUnavailableNotice,
      formatDownloadCancelUnconfirmedNotice,
      formatRevealFailedNotice,
    } = await import("./errorCopy");
    expect(formatFirstRunGpuDegradeNotice().title).toMatch(/GPU/i);
    expect(formatModelsUnavailableNotice().body).toMatch(/Turbo/i);
    expect(formatDownloadCancelUnconfirmedNotice().title).toMatch(/cancel/i);
    expect(formatRevealFailedNotice().title).toMatch(/folder/i);
  });

  it("covers signed updater copy helpers", async () => {
    const {
      formatUpdateAvailableNotice,
      formatUpToDateCopy,
      formatUpdateCheckFailedCopy,
      formatUpdateInstallFailedCopy,
    } = await import("./errorCopy");
    expect(formatUpdateAvailableNotice("1.2.3").title).toMatch(/1\.2\.3/);
    expect(formatUpdateAvailableNotice("1.2.3").body).toMatch(/Settings/i);
    expect(formatUpToDateCopy().title).toMatch(/up to date/i);
    expect(formatUpdateCheckFailedCopy().title).toMatch(/check/i);
    expect(formatUpdateInstallFailedCopy("sig boom").body).toMatch(/sig boom/);
  });
});
