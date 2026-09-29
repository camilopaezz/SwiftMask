import { beforeEach, describe, expect, it, vi } from "vitest";
import { imageStore } from "../stores/imageStore";
import { queueStore } from "../stores/queueStore";
import { uiStore } from "../stores/uiStore";
import { resetProcessGateForTests } from "./currentImage";
import {
  type PasteDeps,
  pasteImages,
  resetPasteInFlightForTests,
} from "./pasteImages";
import { resetQueueRunnerForTests } from "./queueRunner";

describe("pasteImages", () => {
  const settings = { mode: "u2netp", outputDir: null as string | null };
  let result: Awaited<ReturnType<PasteDeps["importImages"]>>;
  let deps: PasteDeps;

  beforeEach(() => {
    resetProcessGateForTests();
    resetQueueRunnerForTests();
    resetPasteInFlightForTests();
    imageStore.setState({ current: null });
    queueStore.getState().clearAll();
    uiStore.getState().dismissNotice();
    result = {
      paths: ["/tmp/clipboard.png"],
      kind: "files",
      default_output_dir: null,
    };
    deps = { importImages: async () => result, getSettings: () => settings };
  });

  it("opens one pasted image as a ready preview without processing", async () => {
    await pasteImages(deps);
    expect(imageStore.getState().current).toMatchObject({
      inputPath: "/tmp/clipboard.png",
      outputPath: "/tmp/clipboard-nobg-u2netp.png",
      status: "ready",
    });
    expect(queueStore.getState().active).toBe(false);
  });

  it("queues multiple pasted images without starting the queue", async () => {
    result.paths = ["/tmp/a.png", "/tmp/b.webp"];
    await pasteImages(deps);
    expect(queueStore.getState().items.map((item) => item.inputPath)).toEqual([
      "/tmp/a.png",
      "/tmp/b.webp",
    ]);
    expect(queueStore.getState().running).toBe(false);
  });

  it("appends pasted pixels to an active queue and retains its fallback dir", async () => {
    queueStore.getState().activateWithItems(
      [
        {
          id: "queued",
          inputPath: "/tmp/queued.png",
          outputPath: "/tmp/queued-nobg-u2netp.png",
          status: "pending",
          progress: 0,
          stage: null,
          error: null,
          jobId: null,
        },
      ],
      { kind: "drop" },
    );
    result = {
      paths: ["/tmp/pasted.png"],
      kind: "pixels",
      default_output_dir: "/Pictures/SwiftMask",
    };
    await pasteImages(deps);
    expect(
      queueStore
        .getState()
        .items.find((item) => item.inputPath === "/tmp/pasted.png"),
    ).toMatchObject({
      outputPath: "/Pictures/SwiftMask/pasted-nobg-u2netp.png",
      defaultOutputDir: "/Pictures/SwiftMask",
    });
  });

  it("shows a notice when a single image is processing", async () => {
    imageStore.getState().set({
      id: "active",
      inputPath: "/tmp/active.png",
      outputPath: null,
      status: "processing",
      progress: 0,
      stage: null,
      error: null,
    });
    const importImages = vi.fn(async () => result);
    await pasteImages({ ...deps, importImages });
    expect(importImages).not.toHaveBeenCalled();
    expect(uiStore.getState().notice?.code).toBe("paste_busy");
  });

  it("silently ignores unsupported clipboard paths", async () => {
    result.paths = ["/tmp/notes.txt"];
    await pasteImages(deps);
    expect(imageStore.getState().current).toBeNull();
    expect(queueStore.getState().active).toBe(false);
    expect(uiStore.getState().notice).toBeNull();
  });
});
