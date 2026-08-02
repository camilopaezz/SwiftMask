import { describe, expect, it } from "vitest";
import {
  INTERNAL_BENCHMARK_MODE,
  isModelReady,
  isProcessableMode,
  isUserFacingModel,
  type ModelMeta,
  PREFERRED_DEFAULT_MODE,
  resolveMode,
} from "./models";
import { MODEL_REGISTRY } from "./models.generated";

function withDownloadState(downloadedIds: readonly string[] = []): ModelMeta[] {
  return MODEL_REGISTRY.map((m) => ({
    ...m,
    downloaded: m.bundled || downloadedIds.includes(m.id),
  }));
}

describe("isModelReady", () => {
  it("treats bundled models as ready", () => {
    expect(isModelReady({ bundled: true, downloaded: false })).toBe(true);
  });

  it("treats downloaded models as ready", () => {
    expect(isModelReady({ bundled: false, downloaded: true })).toBe(true);
  });

  it("treats missing weights as not ready", () => {
    expect(isModelReady({ bundled: false, downloaded: false })).toBe(false);
  });
});

describe("isUserFacingModel", () => {
  it("hides the internal benchmark model", () => {
    expect(isUserFacingModel({ id: INTERNAL_BENCHMARK_MODE })).toBe(false);
    expect(isUserFacingModel({ id: PREFERRED_DEFAULT_MODE })).toBe(true);
    expect(isUserFacingModel({ id: "birefnet-general-lite" })).toBe(true);
  });
});

describe("isProcessableMode", () => {
  it("requires a ready user-facing catalog entry", () => {
    const models = withDownloadState(["isnet-general-use"]);
    expect(isProcessableMode("isnet-general-use", models)).toBe(true);
    expect(isProcessableMode(INTERNAL_BENCHMARK_MODE, models)).toBe(false);
    expect(isProcessableMode("rmbg-2.0", models)).toBe(false);
    expect(isProcessableMode("isnet-general-use", [])).toBe(false);
  });
});

describe("resolveMode", () => {
  it("keeps the current mode when it is ready", () => {
    const models = withDownloadState(["isnet-general-use"]);
    expect(resolveMode("isnet-general-use", models)).toBe("isnet-general-use");
  });

  it("prefers Balanced when current is not ready and preferred is downloaded", () => {
    const models = withDownloadState(["isnet-general-use"]);
    expect(resolveMode("rmbg-2.0", models)).toBe(PREFERRED_DEFAULT_MODE);
  });

  it("stays on preferred when nothing user-facing is ready (no Turbo)", () => {
    const models = withDownloadState();
    expect(resolveMode(PREFERRED_DEFAULT_MODE, models)).toBe(
      PREFERRED_DEFAULT_MODE,
    );
    expect(resolveMode(INTERNAL_BENCHMARK_MODE, models)).toBe(
      PREFERRED_DEFAULT_MODE,
    );
  });

  it("remaps legacy Turbo selection to preferred when Balanced is ready", () => {
    const models = withDownloadState(["isnet-general-use"]);
    expect(resolveMode(INTERNAL_BENCHMARK_MODE, models)).toBe(
      PREFERRED_DEFAULT_MODE,
    );
  });

  it("returns preferred when the catalog is empty", () => {
    expect(resolveMode(PREFERRED_DEFAULT_MODE, [])).toBe(
      PREFERRED_DEFAULT_MODE,
    );
    expect(resolveMode(INTERNAL_BENCHMARK_MODE, [])).toBe(
      PREFERRED_DEFAULT_MODE,
    );
  });

  it("selects preferred from an unresolved default when weights are ready", () => {
    const models = withDownloadState(["isnet-general-use"]);
    expect(resolveMode(PREFERRED_DEFAULT_MODE, models)).toBe(
      PREFERRED_DEFAULT_MODE,
    );
  });

  it("uses first ready user-facing model when preferred is unavailable", () => {
    const models = withDownloadState(["rmbg-1.4"]).map((m) =>
      m.id === PREFERRED_DEFAULT_MODE
        ? { ...m, bundled: false, downloaded: false }
        : m,
    );
    expect(resolveMode("rmbg-2.0", models)).toBe("rmbg-1.4");
  });

  it("keeps a not-ready user-facing selection as the download target", () => {
    const models = withDownloadState();
    expect(resolveMode("rmbg-2.0", models)).toBe("rmbg-2.0");
  });
});
