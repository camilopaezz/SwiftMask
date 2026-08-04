import { beforeEach, describe, expect, it, vi } from "vitest";
import { uiStore } from "../stores/uiStore";

vi.mock("./desktopNotify", () => ({
  maybeDesktopNotifyQueueFinished: vi.fn().mockResolvedValue(undefined),
}));

import { maybeDesktopNotifyQueueFinished } from "./desktopNotify";
import { showFinishNotice } from "./finishNotice";

const desktopNotifyMock = vi.mocked(maybeDesktopNotifyQueueFinished);

describe("showFinishNotice", () => {
  beforeEach(() => {
    uiStore.getState().dismissNotice();
    desktopNotifyMock.mockClear();
  });

  it("shows info finish summary and notifies with terminalCount", () => {
    showFinishNotice(2, 0, null);
    const notice = uiStore.getState().notice;
    expect(notice?.severity).toBe("info");
    expect(notice?.title).toBe("Finished: 2 succeeded, 0 failed");
    expect(notice?.code).toBe("queue_finished");
    expect(desktopNotifyMock).toHaveBeenCalledWith(
      { title: "Finished: 2 succeeded, 0 failed", body: undefined },
      { terminalCount: 2 },
    );
  });

  it("uses warning severity when any failed", () => {
    showFinishNotice(1, 1, null);
    expect(uiStore.getState().notice?.severity).toBe("warning");
    expect(uiStore.getState().notice?.title).toBe(
      "Finished: 1 succeeded, 1 failed",
    );
    expect(desktopNotifyMock).toHaveBeenCalledWith(
      { title: "Finished: 1 succeeded, 1 failed", body: undefined },
      { terminalCount: 2 },
    );
  });

  it("prefers fallback wording without Queue: prefix", () => {
    showFinishNotice(1, 0, { from_ep: "cuda", to_ep: "cpu" });
    const notice = uiStore.getState().notice;
    expect(notice?.severity).toBe("warning");
    expect(notice?.title).toMatch(/CPU/i);
    expect(notice?.body).toMatch(/1 succeeded, 0 failed/);
    expect(notice?.body).not.toMatch(/Queue:/);
    expect(notice?.code).toBe("inference_fallback");
    expect(desktopNotifyMock).toHaveBeenCalledWith(
      {
        title: notice!.title,
        body: notice!.body,
      },
      { terminalCount: 1 },
    );
  });

  it("still notifies with terminalCount 0 skipped by desktop helper", () => {
    showFinishNotice(0, 0, null);
    expect(uiStore.getState().notice?.title).toBe(
      "Finished: 0 succeeded, 0 failed",
    );
    expect(desktopNotifyMock).toHaveBeenCalledWith(
      { title: "Finished: 0 succeeded, 0 failed", body: undefined },
      { terminalCount: 0 },
    );
  });
});
