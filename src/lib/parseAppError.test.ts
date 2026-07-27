import { describe, expect, it } from "vitest";
import { ERROR_CODES, isCancelledError, parseAppError } from "./parseAppError";

describe("parseAppError", () => {
  it("accepts structured objects", () => {
    expect(
      parseAppError({ code: "network", message: "request failed" }),
    ).toEqual({ code: "network", message: "request failed" });
  });

  it("accepts nested error objects", () => {
    expect(
      parseAppError({
        error: { code: "disk_full", message: "ENOSPC" },
      }),
    ).toEqual({ code: "disk_full", message: "ENOSPC" });
  });

  it("parses JSON Error messages", () => {
    expect(
      parseAppError(
        new Error(JSON.stringify({ code: "oom", message: "CUDA OOM" })),
      ),
    ).toEqual({ code: "oom", message: "CUDA OOM" });
  });

  it("classifies legacy cancelled strings", () => {
    expect(parseAppError("cancelled")).toEqual({
      code: ERROR_CODES.cancelled,
      message: "cancelled",
    });
    expect(parseAppError(new Error("cancelled"))).toEqual({
      code: ERROR_CODES.cancelled,
      message: "cancelled",
    });
  });

  it("classifies legacy busy / corrupt / oom strings", () => {
    expect(parseAppError("already processing").code).toBe(ERROR_CODES.busy);
    expect(parseAppError("download already in progress").code).toBe(
      ERROR_CODES.download_busy,
    );
    expect(parseAppError("SHA-256 mismatch for x").code).toBe(
      ERROR_CODES.model_corrupt,
    );
    expect(parseAppError("CUDA out of memory").code).toBe(ERROR_CODES.oom);
  });

  it("falls back to unknown", () => {
    expect(parseAppError(null)).toEqual({
      code: ERROR_CODES.unknown,
      message: "unknown error",
    });
    expect(parseAppError("weird boom")).toEqual({
      code: ERROR_CODES.unknown,
      message: "weird boom",
    });
  });
});

describe("isCancelledError", () => {
  it("detects cancelled via code", () => {
    expect(isCancelledError({ code: "cancelled", message: "cancelled" })).toBe(
      true,
    );
    expect(isCancelledError({ code: "network", message: "x" })).toBe(false);
  });
});
