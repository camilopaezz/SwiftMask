import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyDownloadEvent,
  canCheckForUpdates,
  checkForUpdate,
  classifyUpdaterError,
  installUpdateAndRelaunch,
  updateInfoFromUpdate,
} from "./updater";

const checkMock = vi.fn();
const relaunchMock = vi.fn();
const isTauriMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => isTauriMock(),
}));

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: (...args: unknown[]) => checkMock(...args),
}));

vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: (...args: unknown[]) => relaunchMock(...args),
}));

function makeUpdate(
  overrides: Partial<{
    version: string;
    currentVersion: string;
    body?: string;
    date?: string;
    downloadAndInstall: ReturnType<typeof vi.fn>;
  }> = {},
) {
  return {
    version: overrides.version ?? "1.2.3",
    currentVersion: overrides.currentVersion ?? "1.0.0",
    body: overrides.body,
    date: overrides.date,
    downloadAndInstall:
      overrides.downloadAndInstall ?? vi.fn().mockResolvedValue(undefined),
  };
}

describe("applyDownloadEvent", () => {
  it("tracks started, progress, and finished", () => {
    const started = applyDownloadEvent(
      { downloaded: 0 },
      { event: "Started", data: { contentLength: 200 } },
    );
    expect(started.progress.phase).toBe("started");
    expect(started.progress.percent).toBe(0);

    const mid = applyDownloadEvent(started.next, {
      event: "Progress",
      data: { chunkLength: 50 },
    });
    expect(mid.progress.downloaded).toBe(50);
    expect(mid.progress.percent).toBe(25);

    const more = applyDownloadEvent(mid.next, {
      event: "Progress",
      data: { chunkLength: 150 },
    });
    expect(more.progress.percent).toBe(100);

    const done = applyDownloadEvent(more.next, { event: "Finished" });
    expect(done.progress.phase).toBe("finished");
    expect(done.progress.percent).toBe(100);
  });

  it("omits percent when content length is unknown", () => {
    const started = applyDownloadEvent(
      { downloaded: 0 },
      { event: "Started", data: {} },
    );
    expect(started.progress.percent).toBeUndefined();
    const mid = applyDownloadEvent(started.next, {
      event: "Progress",
      data: { chunkLength: 10 },
    });
    expect(mid.progress.percent).toBeUndefined();
  });
});

describe("canCheckForUpdates", () => {
  it("blocks while checking, downloading, or restarting", () => {
    expect(canCheckForUpdates("checking")).toBe(false);
    expect(canCheckForUpdates("downloading")).toBe(false);
    expect(canCheckForUpdates("restarting")).toBe(false);
    expect(canCheckForUpdates("idle")).toBe(true);
    expect(canCheckForUpdates("available")).toBe(true);
    expect(canCheckForUpdates("error")).toBe(true);
    expect(canCheckForUpdates("up-to-date")).toBe(true);
  });
});

describe("updateInfoFromUpdate", () => {
  it("maps plugin fields", () => {
    const update = makeUpdate({
      version: "2.0.0",
      currentVersion: "1.9.0",
      body: "notes",
      date: "2026-01-01T00:00:00Z",
    }) as never;
    expect(updateInfoFromUpdate(update)).toEqual({
      version: "2.0.0",
      currentVersion: "1.9.0",
      notes: "notes",
      date: "2026-01-01T00:00:00Z",
    });
  });
});

describe("checkForUpdate", () => {
  beforeEach(() => {
    checkMock.mockReset();
    isTauriMock.mockReset();
  });

  it("returns unavailable outside Tauri", async () => {
    isTauriMock.mockReturnValue(false);
    await expect(checkForUpdate()).resolves.toEqual({ status: "unavailable" });
    expect(checkMock).not.toHaveBeenCalled();
  });

  it("returns up-to-date when check is null", async () => {
    isTauriMock.mockReturnValue(true);
    checkMock.mockResolvedValue(null);
    await expect(checkForUpdate()).resolves.toEqual({ status: "up-to-date" });
  });

  it("returns available with info", async () => {
    isTauriMock.mockReturnValue(true);
    const update = makeUpdate({ version: "9.9.9" });
    checkMock.mockResolvedValue(update);
    const result = await checkForUpdate();
    expect(result.status).toBe("available");
    if (result.status === "available") {
      expect(result.info.version).toBe("9.9.9");
      expect(result.update).toBe(update);
    }
  });
});

describe("installUpdateAndRelaunch", () => {
  beforeEach(() => {
    relaunchMock.mockReset();
    relaunchMock.mockResolvedValue(undefined);
  });

  it("downloads then relaunches and reports progress", async () => {
    const downloadAndInstall = vi.fn(
      async (onEvent?: (event: unknown) => void) => {
        onEvent?.({ event: "Started", data: { contentLength: 100 } });
        onEvent?.({ event: "Progress", data: { chunkLength: 40 } });
        onEvent?.({ event: "Finished" });
      },
    );
    const update = makeUpdate({ downloadAndInstall }) as never;
    const progress: number[] = [];
    await installUpdateAndRelaunch(update, (p) => {
      if (p.percent != null) progress.push(p.percent);
    });
    expect(downloadAndInstall).toHaveBeenCalledOnce();
    expect(relaunchMock).toHaveBeenCalledOnce();
    expect(progress).toEqual([0, 40, 100]);
  });

  it("does not throw when relaunch fails after a successful install", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    relaunchMock.mockRejectedValue(new Error("process exiting"));
    const downloadAndInstall = vi.fn().mockResolvedValue(undefined);
    const update = makeUpdate({ downloadAndInstall }) as never;
    await expect(installUpdateAndRelaunch(update)).resolves.toBeUndefined();
    expect(downloadAndInstall).toHaveBeenCalledOnce();
    expect(relaunchMock).toHaveBeenCalledOnce();
    errSpy.mockRestore();
  });
});

describe("classifyUpdaterError", () => {
  it("uses the call-site phase for the code", () => {
    expect(classifyUpdaterError(new Error("network offline"), "check")).toEqual(
      {
        code: "update_check_failed",
        message: "network offline",
      },
    );
    expect(
      classifyUpdaterError("signature verification failed", "install"),
    ).toEqual({
      code: "update_install_failed",
      message: "signature verification failed",
    });
  });

  it("stringifies unknown throwables", () => {
    expect(classifyUpdaterError(42, "check").message).toBe(
      "unknown updater error",
    );
  });
});
