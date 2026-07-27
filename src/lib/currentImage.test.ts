import { beforeEach, describe, expect, it, vi } from "vitest";
import { imageStore } from "../stores/imageStore";
import { settingsStore } from "../stores/settingsStore";
import { uiStore } from "../stores/uiStore";
import {
  acceptDrop,
  applyDone,
  applyError,
  applyFallback,
  applyProgress,
  cancelProcess,
  clearCurrent,
  initCurrentImageListeners,
  isProcessBusy,
  resetProcessGateForTests,
  type StartProcessDeps,
  setActiveRunIdForTests,
  startProcess,
  syncOutputPath,
} from "./currentImage";

const handlers: Record<string, (event: { payload: unknown }) => void> = {};

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    async (
      eventName: string,
      handler: (event: { payload: unknown }) => void,
    ) => {
      handlers[eventName] = handler;
      return () => {
        delete handlers[eventName];
      };
    },
  ),
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn(),
}));

function makeReadyItem(
  overrides: Partial<{
    id: string;
    inputPath: string;
    outputPath: string | null;
  }> = {},
) {
  return {
    id: overrides.id ?? "img-1",
    inputPath: overrides.inputPath ?? "/tmp/in.png",
    outputPath: overrides.outputPath ?? "/tmp/in-nobg-u2netp.png",
    status: "ready" as const,
    progress: 0,
    stage: null,
    error: null,
  };
}

function makeDeps(overrides: Partial<StartProcessDeps> = {}): StartProcessDeps {
  return {
    exists: vi.fn().mockResolvedValue(false),
    ask: vi.fn().mockResolvedValue(true),
    removeBackground: vi.fn().mockResolvedValue(undefined),
    getSettings: () => ({ mode: "u2netp", outputDir: null }),
    ...overrides,
  };
}

describe("currentImage", () => {
  beforeEach(() => {
    resetProcessGateForTests();
    imageStore.setState({ current: null });
    settingsStore.getState().setLastJobTimings(null);
    for (const key of Object.keys(handlers)) {
      delete handlers[key];
    }
  });

  describe("acceptDrop", () => {
    it("filters non-images and returns false when none", () => {
      const ok = acceptDrop(["/tmp/notes.txt", "/tmp/readme.md"], {
        mode: "u2netp",
        outputDir: null,
      });
      expect(ok).toBe(false);
      expect(imageStore.getState().current).toBeNull();
    });

    it("ignores drop while processing", () => {
      imageStore.getState().set({
        ...makeReadyItem(),
        status: "processing",
      });
      const ok = acceptDrop(["/tmp/new.jpg"], {
        mode: "u2netp",
        outputDir: null,
      });
      expect(ok).toBe(false);
      expect(imageStore.getState().current?.inputPath).toBe("/tmp/in.png");
    });

    it("creates a ready item from the first image path", () => {
      const ok = acceptDrop(
        ["/tmp/notes.txt", "/tmp/photo.jpg", "/tmp/other.png"],
        {
          mode: "u2netp",
          outputDir: "/out",
        },
      );
      expect(ok).toBe(true);
      const current = imageStore.getState().current;
      expect(current?.inputPath).toBe("/tmp/photo.jpg");
      expect(current?.status).toBe("ready");
      expect(current?.progress).toBe(0);
      expect(current?.stage).toBeNull();
      expect(current?.error).toBeNull();
      expect(current?.outputPath).toBe("/out/photo-nobg-u2netp.png");
      expect(current?.id).toBeTruthy();
    });
  });

  describe("syncOutputPath", () => {
    it("updates outputPath when mode or outputDir change", () => {
      imageStore
        .getState()
        .set(makeReadyItem({ outputPath: "/tmp/in-nobg-u2netp.png" }));
      syncOutputPath({ mode: "rmbg-2.0", outputDir: "/exports" });
      expect(imageStore.getState().current?.outputPath).toBe(
        "/exports/in-nobg-rmbg-2.0.png",
      );
    });

    it("skips when processing", () => {
      imageStore.getState().set({
        ...makeReadyItem({ outputPath: "/tmp/old.png" }),
        status: "processing",
      });
      syncOutputPath({ mode: "rmbg-2.0", outputDir: "/exports" });
      expect(imageStore.getState().current?.outputPath).toBe("/tmp/old.png");
    });

    it("resets done → ready when derived output path changes", () => {
      imageStore.getState().set({
        ...makeReadyItem({ outputPath: "/tmp/in-nobg-u2netp.png" }),
        status: "done",
        progress: 100,
        stage: "done",
      });
      syncOutputPath({ mode: "rmbg-2.0", outputDir: "/exports" });
      const current = imageStore.getState().current;
      expect(current?.outputPath).toBe("/exports/in-nobg-rmbg-2.0.png");
      expect(current?.status).toBe("ready");
      expect(current?.progress).toBe(0);
      expect(current?.stage).toBeNull();
    });

    it("no-ops when no current image", () => {
      syncOutputPath({ mode: "u2netp", outputDir: null });
      expect(imageStore.getState().current).toBeNull();
    });
  });

  describe("startProcess", () => {
    it("returns no-image when empty", async () => {
      const deps = makeDeps();
      const result = await startProcess(deps);
      expect(result).toBe("no-image");
      expect(deps.removeBackground).not.toHaveBeenCalled();
    });

    it("returns already-processing when busy", async () => {
      imageStore.getState().set({ ...makeReadyItem(), status: "processing" });
      const deps = makeDeps();
      const result = await startProcess(deps);
      expect(result).toBe("already-processing");
      expect(deps.removeBackground).not.toHaveBeenCalled();
    });

    it("skips when overwrite declined without setting processing", async () => {
      imageStore.getState().set(makeReadyItem());
      const deps = makeDeps({
        exists: vi.fn().mockResolvedValue(true),
        ask: vi.fn().mockResolvedValue(false),
      });
      const result = await startProcess(deps);
      expect(result).toBe("skipped");
      expect(deps.removeBackground).not.toHaveBeenCalled();
      expect(imageStore.getState().current?.status).toBe("ready");
    });

    it("skips overwrite decline while leaving done status", async () => {
      imageStore.getState().set({ ...makeReadyItem(), status: "done" });
      const deps = makeDeps({
        exists: vi.fn().mockResolvedValue(true),
        ask: vi.fn().mockResolvedValue(false),
      });
      const result = await startProcess(deps);
      expect(result).toBe("skipped");
      expect(imageStore.getState().current?.status).toBe("done");
      expect(deps.removeBackground).not.toHaveBeenCalled();
    });

    it("invokes removeBackground with correct job when overwrite ok", async () => {
      imageStore.getState().set(
        makeReadyItem({
          id: "job-9",
          inputPath: "/home/user/pic.jpg",
          outputPath: null,
        }),
      );
      const removeBackground = vi.fn().mockResolvedValue(undefined);
      const deps = makeDeps({
        removeBackground,
        getSettings: () => ({ mode: "rmbg-2.0", outputDir: "/exports" }),
      });
      const result = await startProcess(deps);
      expect(result).toBe("started");
      expect(removeBackground).toHaveBeenCalledTimes(1);
      const job = removeBackground.mock.calls[0]?.[0] as {
        id: string;
        inputPath: string;
        outputPath: string;
        modelId: string;
      };
      // Per-run UUID — distinct from the image item id.
      expect(job.id).not.toBe("job-9");
      expect(job.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      expect(job.inputPath).toBe("/home/user/pic.jpg");
      expect(job.outputPath).toBe("/exports/pic-nobg-rmbg-2.0.png");
      expect(job.modelId).toBe("rmbg-2.0");
      expect(imageStore.getState().current?.status).toBe("processing");
      expect(imageStore.getState().current?.stage).toBe("starting");
      expect(imageStore.getState().current?.outputPath).toBe(
        "/exports/pic-nobg-rmbg-2.0.png",
      );
    });

    it("returns failed and patches command failed when invoke throws", async () => {
      imageStore.getState().set(makeReadyItem({ id: "fail-1" }));
      const deps = makeDeps({
        removeBackground: vi.fn().mockRejectedValue(new Error("boom")),
      });
      const result = await startProcess(deps);
      expect(result).toBe("failed");
      const current = imageStore.getState().current;
      expect(current?.status).toBe("error");
      expect(current?.error).toEqual({ code: "unknown", message: "boom" });
      expect(current?.stage).toBeNull();
    });

    it("aborts after overwrite if image was replaced during dialog", async () => {
      imageStore.getState().set(makeReadyItem({ id: "orig" }));
      let resolveAsk!: (v: boolean) => void;
      const ask = vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            resolveAsk = resolve;
          }),
      );
      const removeBackground = vi.fn().mockResolvedValue(undefined);
      const deps = makeDeps({
        exists: vi.fn().mockResolvedValue(true),
        ask,
        removeBackground,
      });

      const pending = startProcess(deps);
      await vi.waitFor(() => expect(ask).toHaveBeenCalled());
      expect(isProcessBusy()).toBe(true);

      // Gate blocks drop while confirming.
      expect(
        acceptDrop(["/tmp/other.png"], { mode: "u2netp", outputDir: null }),
      ).toBe(false);

      // Hostile race: store replaced while dialog open (bypassing acceptDrop gate).
      imageStore
        .getState()
        .set(makeReadyItem({ id: "replaced", inputPath: "/tmp/other.png" }));
      resolveAsk(true);

      const result = await pending;
      expect(result).toBe("skipped");
      expect(removeBackground).not.toHaveBeenCalled();
      expect(imageStore.getState().current?.id).toBe("replaced");
      expect(imageStore.getState().current?.status).toBe("ready");
      expect(isProcessBusy()).toBe(false);
    });

    it("second startProcess during overwrite returns already-processing", async () => {
      imageStore.getState().set(makeReadyItem({ id: "solo" }));
      let resolveAsk!: (v: boolean) => void;
      const ask = vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            resolveAsk = resolve;
          }),
      );
      const removeBackground = vi.fn().mockResolvedValue(undefined);
      const deps = makeDeps({
        exists: vi.fn().mockResolvedValue(true),
        ask,
        removeBackground,
      });

      const first = startProcess(deps);
      await vi.waitFor(() => expect(ask).toHaveBeenCalled());
      const second = await startProcess(makeDeps());
      expect(second).toBe("already-processing");

      resolveAsk(true);
      expect(await first).toBe("started");
      expect(removeBackground).toHaveBeenCalledTimes(1);
    });

    it("nudges store after processGate clears so FileBlock re-enables", async () => {
      // Production: done event often arrives before remove_image_background
      // returns, while processGate is still true. FileBlock ORs isProcessBusy()
      // into disabled — without a post-gate store update it stays disabled forever.
      imageStore.getState().set(makeReadyItem({ id: "img-nudge" }));
      const removeBackground = vi.fn(async (job: { id: string }) => {
        applyDone({
          id: job.id,
          output_path: "/tmp/out.png",
          timings: { stages: [], total_seconds: 0.1 },
        });
        expect(isProcessBusy()).toBe(true);
        expect(imageStore.getState().current?.status).toBe("done");
      });
      const deps = makeDeps({ removeBackground });

      let subscriberCalls = 0;
      const unsub = imageStore.subscribe(() => {
        subscriberCalls += 1;
      });
      const before = subscriberCalls;
      expect(await startProcess(deps)).toBe("started");
      unsub();

      expect(imageStore.getState().current?.status).toBe("done");
      expect(isProcessBusy()).toBe(false);
      // At least one notify after processGate=false (the finally nudge).
      expect(subscriberCalls).toBeGreaterThan(before);
    });
  });

  describe("cancelProcess / clearCurrent", () => {
    it("awaits cancelInference for the active run id", async () => {
      imageStore.getState().set({
        ...makeReadyItem({ id: "img-cancel-fire" }),
        status: "processing",
      });
      setActiveRunIdForTests("run-fire");
      const cancelInference = vi.fn().mockResolvedValue(undefined);
      await cancelProcess({ cancelInference });
      expect(cancelInference).toHaveBeenCalledWith("run-fire");
    });

    it("optimistically sets cancelled while processing", async () => {
      imageStore.getState().set({
        ...makeReadyItem({ id: "img-cancel" }),
        status: "processing",
        progress: 40,
        stage: "inferring",
      });
      const cancelInference = vi.fn().mockResolvedValue(undefined);
      await cancelProcess({ cancelInference });
      expect(cancelInference).toHaveBeenCalled();
      const current = imageStore.getState().current;
      expect(current?.status).toBe("cancelled");
      expect(current?.progress).toBe(0);
      expect(current?.stage).toBeNull();
      expect(current?.error).toBeNull();
    });

    it("keeps isProcessBusy until cancelInference resolves", async () => {
      imageStore.getState().set({
        ...makeReadyItem({ id: "img-cancel-busy" }),
        status: "processing",
      });
      setActiveRunIdForTests("run-busy");
      let resolveCancel!: () => void;
      const cancelInference = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveCancel = resolve;
          }),
      );

      const pending = cancelProcess({ cancelInference });
      await vi.waitFor(() => expect(cancelInference).toHaveBeenCalled());
      expect(imageStore.getState().current?.status).toBe("cancelled");
      expect(isProcessBusy()).toBe(true);
      expect(await startProcess(makeDeps())).toBe("already-processing");

      resolveCancel();
      await pending;
      expect(isProcessBusy()).toBe(false);
    });

    it("keeps cancelGate when cancelInference fails both attempts", async () => {
      imageStore.getState().set({
        ...makeReadyItem({ id: "img-cancel-fail" }),
        status: "processing",
      });
      setActiveRunIdForTests("run-fail");
      const cancelInference = vi
        .fn()
        .mockRejectedValue(new Error("ipc failed"));

      await cancelProcess({ cancelInference });
      expect(cancelInference).toHaveBeenCalledTimes(2);
      expect(imageStore.getState().current?.status).toBe("cancelled");
      expect(isProcessBusy()).toBe(true);
      expect(await startProcess(makeDeps())).toBe("already-processing");
    });

    it("does not patch when not processing", async () => {
      imageStore.getState().set({
        ...makeReadyItem({ id: "img-ready" }),
        status: "ready",
      });
      await cancelProcess({
        cancelInference: vi.fn().mockResolvedValue(undefined),
      });
      expect(imageStore.getState().current?.status).toBe("ready");
    });

    it("clears the current image when idle", () => {
      imageStore.getState().set(makeReadyItem());
      expect(clearCurrent()).toBe(true);
      expect(imageStore.getState().current).toBeNull();
    });

    it("refuses clear while processing", () => {
      imageStore.getState().set({ ...makeReadyItem(), status: "processing" });
      expect(clearCurrent()).toBe(false);
      expect(imageStore.getState().current?.status).toBe("processing");
    });

    it("refuses clear while cancel is freeing the backend slot", async () => {
      imageStore.getState().set({
        ...makeReadyItem(),
        status: "processing",
      });
      let resolveCancel!: () => void;
      const pending = cancelProcess({
        cancelInference: () =>
          new Promise<void>((resolve) => {
            resolveCancel = resolve;
          }),
      });
      await vi.waitFor(() =>
        expect(imageStore.getState().current?.status).toBe("cancelled"),
      );
      expect(clearCurrent()).toBe(false);
      resolveCancel();
      await pending;
      expect(clearCurrent()).toBe(true);
    });
  });

  describe("applyProgress / applyDone / applyError", () => {
    it("patches progress for matching id only when processing", () => {
      imageStore.getState().set({
        ...makeReadyItem({ id: "img-1" }),
        status: "processing",
      });
      applyProgress({ id: "img-1", stage: "inferring", pct: 55 });
      const current = imageStore.getState().current;
      expect(current?.status).toBe("processing");
      expect(current?.stage).toBe("inferring");
      expect(current?.progress).toBe(55);
    });

    it("does not resurrect ready via late progress", () => {
      imageStore.getState().set(makeReadyItem({ id: "img-1" }));
      applyProgress({ id: "img-1", stage: "inferring", pct: 55 });
      expect(imageStore.getState().current?.status).toBe("ready");
      expect(imageStore.getState().current?.progress).toBe(0);
    });

    it("ignores progress for different id", () => {
      imageStore.getState().set({
        ...makeReadyItem({ id: "img-1" }),
        status: "processing",
      });
      applyProgress({ id: "other", stage: "inferring", pct: 55 });
      expect(imageStore.getState().current?.progress).toBe(0);
    });

    it("sets done status and output path", () => {
      imageStore.getState().set({
        ...makeReadyItem({ id: "img-2" }),
        status: "processing",
        progress: 80,
        stage: "encoding",
      });
      applyDone({
        id: "img-2",
        output_path: "/tmp/out.png",
        timings: {
          stages: [
            { stage: "decoding", seconds: 0.01 },
            { stage: "inferring", seconds: 0.5 },
          ],
          total_seconds: 0.6,
        },
      });
      const current = imageStore.getState().current;
      expect(current?.status).toBe("done");
      expect(current?.outputPath).toBe("/tmp/out.png");
      expect(current?.progress).toBe(100);
      expect(current?.stage).toBeNull();
      // applyDone only updates image state; timings are set by the event listener.
      expect(settingsStore.getState().lastJobTimings).toBeNull();
    });

    it("ignores done for different id", () => {
      imageStore.getState().set({
        ...makeReadyItem({ id: "img-2" }),
        status: "processing",
      });
      applyDone({
        id: "other",
        output_path: "/tmp/out.png",
        timings: { stages: [], total_seconds: 0 },
      });
      expect(imageStore.getState().current?.status).toBe("processing");
    });

    it("sets error status and message", () => {
      imageStore.getState().set({
        ...makeReadyItem({ id: "img-3" }),
        status: "processing",
      });
      applyError({ id: "img-3", code: "oom", message: "CUDA out of memory" });
      const current = imageStore.getState().current;
      expect(current?.status).toBe("error");
      expect(current?.error).toEqual({
        code: "oom",
        message: "CUDA out of memory",
      });
      expect(current?.stage).toBeNull();
    });

    it("ignores error for different id", () => {
      imageStore.getState().set({
        ...makeReadyItem({ id: "img-3" }),
        status: "processing",
      });
      applyError({ id: "other", message: "out of memory" });
      expect(imageStore.getState().current?.status).toBe("processing");
    });

    it("sets cancelled when error message is cancelled", () => {
      imageStore.getState().set({
        ...makeReadyItem({ id: "img-4" }),
        status: "processing",
      });
      applyError({ id: "img-4", code: "cancelled", message: "cancelled" });
      const current = imageStore.getState().current;
      expect(current?.status).toBe("cancelled");
      expect(current?.error).toBeNull();
      expect(current?.stage).toBeNull();
    });

    it("ignores late done after optimistic cancel for that job id", async () => {
      imageStore.getState().set({
        ...makeReadyItem({ id: "img-late" }),
        status: "processing",
        progress: 90,
        stage: "encoding",
      });
      setActiveRunIdForTests("run-late");
      await cancelProcess({
        cancelInference: vi.fn().mockResolvedValue(undefined),
      });
      expect(imageStore.getState().current?.status).toBe("cancelled");

      applyDone({
        id: "run-late",
        output_path: "/tmp/should-not-apply.png",
        timings: { stages: [], total_seconds: 1 },
      });
      const current = imageStore.getState().current;
      expect(current?.status).toBe("cancelled");
      expect(current?.outputPath).not.toBe("/tmp/should-not-apply.png");
      expect(current?.progress).toBe(0);
    });

    it("ignores late error after optimistic cancel for that job id", async () => {
      imageStore.getState().set({
        ...makeReadyItem({ id: "img-late-err" }),
        status: "processing",
      });
      setActiveRunIdForTests("run-late-err");
      await cancelProcess({
        cancelInference: vi.fn().mockResolvedValue(undefined),
      });
      applyError({ id: "run-late-err", message: "cancelled" });
      applyError({ id: "run-late-err", message: "out of memory" });
      const current = imageStore.getState().current;
      expect(current?.status).toBe("cancelled");
      expect(current?.error).toBeNull();
    });

    it("does not let a cancelled run clobber a new run of the same image", async () => {
      const item = makeReadyItem({ id: "img-rerun" });
      imageStore.getState().set(item);

      let resolveFirst: (() => void) | undefined;
      const firstDone = new Promise<void>((r) => {
        resolveFirst = r;
      });
      let call = 0;
      const removeBackground = vi.fn(async (job: { id: string }) => {
        call += 1;
        if (call === 1) {
          await firstDone;
          return;
        }
        // Second run stays open; we only care that late first events are ignored.
        void job;
      });
      const deps: StartProcessDeps = {
        exists: vi.fn().mockResolvedValue(false),
        ask: vi.fn(),
        removeBackground,
        getSettings: () => ({ mode: "u2netp", outputDir: null }),
      };

      const first = startProcess(deps);
      // Let startProcess set processing + activeRunId
      await Promise.resolve();
      await Promise.resolve();
      expect(imageStore.getState().current?.status).toBe("processing");
      const firstRunId = removeBackground.mock.calls[0]?.[0]?.id as string;
      expect(firstRunId).toBeTruthy();

      // Mirror backend: cancel resolves only after the first job finishes.
      const cancelPending = cancelProcess({
        cancelInference: async () => {
          await firstDone;
        },
      });
      expect(imageStore.getState().current?.status).toBe("cancelled");
      expect(isProcessBusy()).toBe(true);
      resolveFirst?.();
      await first;
      await cancelPending;
      expect(isProcessBusy()).toBe(false);

      // New run on same image
      const second = startProcess({
        ...deps,
        removeBackground: vi
          .fn()
          .mockImplementation(async (job: { id: string }) => {
            // Late events from the first run must not cancel this job.
            applyDone({
              id: firstRunId,
              output_path: "/tmp/stale.png",
              timings: { stages: [], total_seconds: 0 },
            });
            applyError({ id: firstRunId, message: "cancelled" });
            expect(imageStore.getState().current?.status).toBe("processing");
            expect(job.id).not.toBe(firstRunId);
          }),
      });
      await second;
      expect(imageStore.getState().current?.status).toBe("processing");
    });
  });

  describe("initCurrentImageListeners", () => {
    it("patches progress on inference:progress for the current image", async () => {
      imageStore.getState().set({
        ...makeReadyItem({ id: "img-1" }),
        status: "processing",
      });
      await initCurrentImageListeners();
      handlers["inference:progress"]({
        payload: { id: "img-1", stage: "inferring", pct: 55 },
      });
      const current = imageStore.getState().current;
      expect(current?.status).toBe("processing");
      expect(current?.stage).toBe("inferring");
      expect(current?.progress).toBe(55);
    });

    it("ignores progress events for a different id", async () => {
      imageStore.getState().set({
        ...makeReadyItem({ id: "img-1" }),
        status: "processing",
      });
      await initCurrentImageListeners();
      handlers["inference:progress"]({
        payload: { id: "other", stage: "inferring", pct: 55 },
      });
      expect(imageStore.getState().current?.progress).toBe(0);
    });

    it("sets done status and output path on inference:done", async () => {
      imageStore.getState().set({
        ...makeReadyItem({ id: "img-2" }),
        status: "processing",
        progress: 80,
        stage: "encoding",
      });
      await initCurrentImageListeners();
      handlers["inference:done"]({
        payload: {
          id: "img-2",
          output_path: "/tmp/out.png",
          timings: {
            stages: [{ stage: "inferring", seconds: 0.4 }],
            total_seconds: 0.5,
          },
        },
      });
      const current = imageStore.getState().current;
      expect(current?.status).toBe("done");
      expect(current?.outputPath).toBe("/tmp/out.png");
      expect(current?.progress).toBe(100);
      expect(current?.stage).toBeNull();
      expect(settingsStore.getState().lastJobTimings).toEqual({
        stages: [{ stage: "inferring", seconds: 0.4 }],
        total_seconds: 0.5,
      });
    });

    it("sets error status and message on inference:error", async () => {
      imageStore.getState().set({
        ...makeReadyItem({ id: "img-3" }),
        status: "processing",
        progress: 20,
        stage: "decoding",
      });
      await initCurrentImageListeners();
      handlers["inference:error"]({
        payload: {
          id: "img-3",
          code: "oom",
          message: "CUDA out of memory",
        },
      });
      const current = imageStore.getState().current;
      expect(current?.status).toBe("error");
      expect(current?.error).toEqual({
        code: "oom",
        message: "CUDA out of memory",
      });
      expect(current?.stage).toBeNull();
    });

    it("sets cancelled status when error message is cancelled", async () => {
      imageStore.getState().set({
        ...makeReadyItem({ id: "img-4" }),
        status: "processing",
        progress: 20,
        stage: "decoding",
      });
      await initCurrentImageListeners();
      handlers["inference:error"]({
        payload: { id: "img-4", code: "cancelled", message: "cancelled" },
      });
      const current = imageStore.getState().current;
      expect(current?.status).toBe("cancelled");
      expect(current?.error).toBeNull();
      expect(current?.stage).toBeNull();
    });

    it("shows sticky fallback notice on inference:fallback", async () => {
      uiStore.getState().dismissNotice();
      imageStore.getState().set({
        ...makeReadyItem({ id: "img-fb" }),
        status: "processing",
        progress: 50,
        stage: "inferring",
      });
      setActiveRunIdForTests("run-fb");
      await initCurrentImageListeners();
      handlers["inference:fallback"]({
        payload: {
          id: "run-fb",
          reason: "oom",
          from_ep: "cuda",
          to_ep: "cpu",
        },
      });
      const notice = uiStore.getState().notice;
      expect(notice?.severity).toBe("warning");
      expect(notice?.title).toMatch(/CPU/i);
      expect(notice?.body).toMatch(/Settings/i);
      // Fallback must not flip the image into error.
      expect(imageStore.getState().current?.status).toBe("processing");
    });
  });

  describe("applyFallback", () => {
    it("ignores fallback for other run ids", () => {
      uiStore.getState().dismissNotice();
      imageStore.getState().set({
        ...makeReadyItem({ id: "img-1" }),
        status: "processing",
      });
      setActiveRunIdForTests("run-a");
      applyFallback({
        id: "run-b",
        reason: "oom",
        from_ep: "directml",
        to_ep: "cpu",
      });
      expect(uiStore.getState().notice).toBeNull();
    });
  });
});
