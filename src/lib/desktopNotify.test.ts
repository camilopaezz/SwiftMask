import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DesktopNotifyDeps,
  maybeDesktopNotifyQueueFinished,
} from "./desktopNotify";

function mockDeps(
  overrides: Partial<DesktopNotifyDeps> = {},
): DesktopNotifyDeps {
  return {
    isPermissionGranted: vi.fn().mockResolvedValue(true),
    requestPermission: vi.fn().mockResolvedValue("granted"),
    sendNotification: vi.fn(),
    isBackground: vi.fn().mockResolvedValue(true),
    focusMainWindow: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function expectSent(
  deps: DesktopNotifyDeps,
  payload: { title: string; body?: string },
) {
  expect(deps.sendNotification).toHaveBeenCalledWith(
    payload,
    deps.focusMainWindow,
  );
}

describe("maybeDesktopNotifyQueueFinished", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("skips when terminalCount is 0 (pure cancel)", async () => {
    const deps = mockDeps();
    await maybeDesktopNotifyQueueFinished(
      { title: "Finished: 0 succeeded, 0 failed" },
      { terminalCount: 0, deps },
    );
    expect(deps.isBackground).not.toHaveBeenCalled();
    expect(deps.sendNotification).not.toHaveBeenCalled();
  });

  it("skips when window is focused and not minimized", async () => {
    const deps = mockDeps({
      isBackground: vi.fn().mockResolvedValue(false),
    });
    await maybeDesktopNotifyQueueFinished(
      { title: "Finished: 1 succeeded, 0 failed" },
      { terminalCount: 1, deps },
    );
    expect(deps.isPermissionGranted).not.toHaveBeenCalled();
    expect(deps.sendNotification).not.toHaveBeenCalled();
  });

  it("sends when background and permission already granted", async () => {
    const deps = mockDeps();
    await maybeDesktopNotifyQueueFinished(
      {
        title: "Finished: 2 succeeded, 1 failed",
        body: "optional",
      },
      { terminalCount: 3, deps },
    );
    expect(deps.requestPermission).not.toHaveBeenCalled();
    expectSent(deps, {
      title: "Finished: 2 succeeded, 1 failed",
      body: "optional",
    });
  });

  it("requests permission when not yet granted", async () => {
    const deps = mockDeps({
      isPermissionGranted: vi.fn().mockResolvedValue(false),
      requestPermission: vi.fn().mockResolvedValue("granted"),
    });
    await maybeDesktopNotifyQueueFinished(
      { title: "Done" },
      { terminalCount: 1, deps },
    );
    expect(deps.requestPermission).toHaveBeenCalledTimes(1);
    expectSent(deps, {
      title: "Done",
      body: undefined,
    });
  });

  it("skips send when permission denied", async () => {
    const deps = mockDeps({
      isPermissionGranted: vi.fn().mockResolvedValue(false),
      requestPermission: vi.fn().mockResolvedValue("denied"),
    });
    await maybeDesktopNotifyQueueFinished(
      { title: "Done" },
      { terminalCount: 1, deps },
    );
    expect(deps.sendNotification).not.toHaveBeenCalled();
  });

  it("swallows plugin errors silently", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = mockDeps({
      isBackground: vi.fn().mockRejectedValue(new Error("boom")),
    });
    await expect(
      maybeDesktopNotifyQueueFinished(
        { title: "Done" },
        { terminalCount: 1, deps },
      ),
    ).resolves.toBeUndefined();
    expect(deps.sendNotification).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalled();
  });
});
