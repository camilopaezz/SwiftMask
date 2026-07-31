import { beforeEach, describe, expect, it, vi } from "vitest";
import { imageStore } from "../stores/imageStore";
import { queueStore } from "../stores/queueStore";
import { uiStore } from "../stores/uiStore";
import { resetProcessGateForTests } from "./currentImage";
import {
  clearQueue,
  enqueueFromDrop,
  isImageFile,
  loadSingleImage,
  QUEUE_ENQUEUE_CONFIRM_THRESHOLD,
  removeQueueItem,
} from "./queue";
import { resolveBatchOverwrite } from "./queueOverwrite";

describe("queue domain", () => {
  beforeEach(() => {
    resetProcessGateForTests();
    imageStore.setState({ current: null });
    queueStore.getState().clearAll();
    uiStore.getState().dismissNotice();
  });

  describe("isImageFile", () => {
    it("accepts known extensions", () => {
      expect(isImageFile("/a/b.PNG")).toBe(true);
      expect(isImageFile("x.webp")).toBe(true);
    });
    it("rejects other files", () => {
      expect(isImageFile("/a/b.txt")).toBe(false);
      expect(isImageFile("/folder")).toBe(false);
    });
  });

  describe("enqueueFromDrop", () => {
    const settings = { mode: "u2netp", outputDir: null as string | null };

    it("rejects non-image only drops with notice", async () => {
      const result = await enqueueFromDrop(
        ["/tmp/notes.txt", "/tmp/dir"],
        settings,
        {
          askConfirm: vi.fn(),
        },
      );
      expect(result).toBe("rejected");
      expect(queueStore.getState().active).toBe(false);
      expect(uiStore.getState().notice?.title).toMatch(/folder/i);
    });

    it("rejects mixed image + non-image", async () => {
      const result = await enqueueFromDrop(
        ["/tmp/a.jpg", "/tmp/folder"],
        settings,
        { askConfirm: vi.fn() },
      );
      expect(result).toBe("rejected");
      expect(queueStore.getState().items).toHaveLength(0);
    });

    it("activates queue for multi-image drop even when N=1", async () => {
      const result = await enqueueFromDrop(["/tmp/one.png"], settings, {
        askConfirm: vi.fn(),
      });
      expect(result).toBe("enqueued");
      const q = queueStore.getState();
      expect(q.active).toBe(true);
      expect(q.items).toHaveLength(1);
      expect(q.items[0]?.status).toBe("pending");
      expect(q.selectedId).toBe(q.items[0]?.id);
      expect(q.drawerOpen).toBe(true);
      expect(imageStore.getState().current).toBeNull();
    });

    it("appends and dedups on second drop", async () => {
      await enqueueFromDrop(["/tmp/a.jpg", "/tmp/b.jpg"], settings, {
        askConfirm: vi.fn(),
      });
      const result = await enqueueFromDrop(
        ["/tmp/b.jpg", "/tmp/c.jpg"],
        settings,
        { askConfirm: vi.fn() },
      );
      expect(result).toBe("appended");
      const paths = queueStore.getState().items.map((i) => i.inputPath);
      expect(paths).toEqual(["/tmp/a.jpg", "/tmp/b.jpg", "/tmp/c.jpg"]);
    });

    it("confirms when new paths exceed threshold", async () => {
      const askConfirm = vi.fn().mockResolvedValue(false);
      const many = Array.from(
        { length: QUEUE_ENQUEUE_CONFIRM_THRESHOLD + 1 },
        (_, i) => `/tmp/img-${i}.png`,
      );
      const result = await enqueueFromDrop(many, settings, { askConfirm });
      expect(askConfirm).toHaveBeenCalled();
      expect(result).toBe("cancelled");
      expect(queueStore.getState().active).toBe(false);
    });
  });

  describe("loadSingleImage", () => {
    const settings = { mode: "u2netp", outputDir: "/out" as string | null };

    it("sets classic current and clears queue after confirm", async () => {
      await enqueueFromDrop(
        ["/tmp/a.jpg"],
        { mode: "u2netp", outputDir: null },
        {
          askConfirm: vi.fn(),
        },
      );
      const askConfirm = vi.fn().mockResolvedValue(true);
      const ok = await loadSingleImage("/tmp/solo.png", settings, {
        askConfirm,
      });
      expect(ok).toBe(true);
      expect(askConfirm).toHaveBeenCalled();
      expect(queueStore.getState().active).toBe(false);
      expect(imageStore.getState().current?.inputPath).toBe("/tmp/solo.png");
      expect(imageStore.getState().current?.status).toBe("ready");
    });

    it("aborts when user declines leaving queue", async () => {
      await enqueueFromDrop(
        ["/tmp/a.jpg"],
        { mode: "u2netp", outputDir: null },
        {
          askConfirm: vi.fn(),
        },
      );
      const ok = await loadSingleImage("/tmp/solo.png", settings, {
        askConfirm: vi.fn().mockResolvedValue(false),
      });
      expect(ok).toBe(false);
      expect(queueStore.getState().items).toHaveLength(1);
      expect(imageStore.getState().current).toBeNull();
    });
  });

  describe("remove and clear", () => {
    it("remove last item deactivates queue", async () => {
      await enqueueFromDrop(
        ["/tmp/a.jpg"],
        { mode: "u2netp", outputDir: null },
        {
          askConfirm: vi.fn(),
        },
      );
      const id = queueStore.getState().items[0]?.id;
      expect(id).toBeTruthy();
      removeQueueItem(id!);
      expect(queueStore.getState().active).toBe(false);
    });

    it("clearQueue resets state", async () => {
      await enqueueFromDrop(
        ["/tmp/a.jpg", "/tmp/b.jpg"],
        { mode: "u2netp", outputDir: null },
        { askConfirm: vi.fn() },
      );
      await clearQueue();
      expect(queueStore.getState().items).toHaveLength(0);
      expect(queueStore.getState().active).toBe(false);
    });
  });

  describe("status helpers", () => {
    it("marks done items to the bottom of the sort", async () => {
      await enqueueFromDrop(
        ["/tmp/a.jpg", "/tmp/b.jpg"],
        { mode: "u2netp", outputDir: null },
        { askConfirm: vi.fn() },
      );
      const a = queueStore
        .getState()
        .items.find((i) => i.inputPath.endsWith("a.jpg"));
      expect(a).toBeTruthy();
      queueStore.getState().markDone(a!.id, "/tmp/a-nobg.png");
      const statuses = queueStore.getState().items.map((i) => i.status);
      expect(statuses[statuses.length - 1]).toBe("done");
    });

    it("retryAllFailed resets failed to pending", async () => {
      await enqueueFromDrop(
        ["/tmp/a.jpg"],
        { mode: "u2netp", outputDir: null },
        { askConfirm: vi.fn() },
      );
      const id = queueStore.getState().items[0]!.id;
      queueStore.getState().markFailed(id, { code: "x", message: "boom" });
      queueStore.getState().retryAllFailed();
      expect(queueStore.getState().items[0]?.status).toBe("pending");
    });
  });
});

describe("resolveBatchOverwrite", () => {
  it("returns overwrite_all when nothing exists", async () => {
    const choice = await resolveBatchOverwrite(
      ["/a.png", "/b.png"],
      async () => false,
      async () => true,
    );
    expect(choice).toBe("overwrite_all");
  });

  it("maps Yes to overwrite_all", async () => {
    const choice = await resolveBatchOverwrite(
      ["/a.png"],
      async () => true,
      async () => true,
    );
    expect(choice).toBe("overwrite_all");
  });

  it("maps No then Yes to skip_existing", async () => {
    const ask = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const choice = await resolveBatchOverwrite(
      ["/a.png"],
      async () => true,
      ask,
    );
    expect(choice).toBe("skip_existing");
  });
});
