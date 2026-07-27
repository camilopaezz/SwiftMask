import { beforeEach, describe, expect, it } from "vitest";
import { uiStore } from "../stores/uiStore";
import { showAppErrorNotice, showAppNotice } from "./showAppErrorNotice";

describe("showAppErrorNotice", () => {
  beforeEach(() => {
    uiStore.getState().dismissNotice();
  });

  it("maps structured errors into the shared notice", () => {
    showAppErrorNotice({ code: "network", message: "request failed" });
    const notice = uiStore.getState().notice;
    expect(notice?.severity).toBe("error");
    expect(notice?.title).toBe("Network error");
    expect(notice?.code).toBe("network");
  });

  it("accepts copy overrides for soft-degrade", () => {
    showAppErrorNotice(new Error("boom"), {
      severity: "warning",
      copy: { title: "Custom", body: "body" },
      code: "first_run_gpu",
    });
    const notice = uiStore.getState().notice;
    expect(notice?.severity).toBe("warning");
    expect(notice?.title).toBe("Custom");
    expect(notice?.code).toBe("first_run_gpu");
  });
});

describe("showAppNotice", () => {
  beforeEach(() => {
    uiStore.getState().dismissNotice();
  });

  it("pushes a warning without an error object", () => {
    showAppNotice({ title: "Heads up", body: "detail" }, "warning", "x");
    expect(uiStore.getState().notice).toMatchObject({
      title: "Heads up",
      body: "detail",
      severity: "warning",
      code: "x",
    });
  });
});
