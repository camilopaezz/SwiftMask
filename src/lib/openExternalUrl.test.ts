import { afterEach, describe, expect, it, vi } from "vitest";
import { openExternalUrl } from "./openExternalUrl";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
}));

vi.mock("./showAppErrorNotice", () => ({
  showAppNotice: vi.fn(),
}));

import { openUrl } from "@tauri-apps/plugin-opener";
import { showAppNotice } from "./showAppErrorNotice";

const openUrlMock = vi.mocked(openUrl);
const showAppNoticeMock = vi.mocked(showAppNotice);

describe("openExternalUrl", () => {
  afterEach(() => {
    openUrlMock.mockReset();
    showAppNoticeMock.mockReset();
    vi.restoreAllMocks();
  });

  it("calls openUrl with the given URL", async () => {
    openUrlMock.mockResolvedValue(undefined);
    await openExternalUrl("https://example.com");
    expect(openUrlMock).toHaveBeenCalledWith("https://example.com");
    expect(showAppNoticeMock).not.toHaveBeenCalled();
  });

  it("logs and shows a notice on failure", async () => {
    const err = new Error("denied");
    openUrlMock.mockRejectedValue(err);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    await expect(
      openExternalUrl("https://example.com/fail"),
    ).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith(
      "openExternalUrl failed",
      "https://example.com/fail",
      err,
    );
    expect(showAppNoticeMock).toHaveBeenCalledWith(
      {
        title: "Couldn’t open link",
        body: "Open it manually in your browser, or check system permissions.",
      },
      "warning",
      "open_url",
    );
  });
});
