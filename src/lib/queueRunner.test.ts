import { beforeEach, describe, expect, it, vi } from "vitest";
import { queueStore } from "../stores/queueStore";
import { settingsStore } from "../stores/settingsStore";
import { uiStore } from "../stores/uiStore";
import { MODEL_REGISTRY, PREFERRED_DEFAULT_MODE } from "./models";
import {
  isQueueRunActive,
  type QueueRunnerDeps,
  resetQueueRunnerForTests,
  startQueueProcess,
} from "./queueRunner";

function seedPending(paths: string[]) {
  queueStore.getState().activateWithItems(
    paths.map((inputPath) => ({
      id: crypto.randomUUID(),
      inputPath,
      outputPath: `${inputPath}-out.png`,
      status: "pending" as const,
      progress: 0,
      stage: null,
      error: null,
      jobId: null,
    })),
    { kind: "drop" },
  );
}

/** Strict Process gate reads settingsStore — seed a ready user-facing mode. */
function seedProcessableSettings() {
  settingsStore.setState({
    mode: PREFERRED_DEFAULT_MODE,
    models: MODEL_REGISTRY.map((m) => ({
      ...m,
      downloaded: m.bundled || m.id === PREFERRED_DEFAULT_MODE,
    })),
  });
}

const noopListen = async () => () => {};

function baseDeps(overrides: Partial<QueueRunnerDeps> = {}): QueueRunnerDeps {
  return {
    exists: async () => false,
    chooseOverwrite: async () => "overwrite_all",
    removeBackground: async () => {},
    cancelInference: async () => {},
    getSettings: () => ({ mode: PREFERRED_DEFAULT_MODE, outputDir: null }),
    ensureDir: async () => {},
    listenProgress: noopListen,
    listenDone: noopListen,
    listenError: noopListen,
    ...overrides,
  };
}

describe("startQueueProcess", () => {
  beforeEach(() => {
    resetQueueRunnerForTests();
    queueStore.getState().clearAll();
    uiStore.getState().dismissNotice();
    seedProcessableSettings();
  });

  it("processes pending items serially and marks done", async () => {
    seedPending(["/tmp/a.png", "/tmp/b.png"]);
    const order: string[] = [];
    const deps = baseDeps({
      removeBackground: async (job) => {
        order.push(job.inputPath);
      },
    });

    const result = await startQueueProcess(deps);
    expect(result).toBe("started");
    expect(order).toEqual(["/tmp/a.png", "/tmp/b.png"]);
    const statuses = queueStore.getState().items.map((i) => i.status);
    expect(statuses.every((s) => s === "done")).toBe(true);
    expect(queueStore.getState().running).toBe(false);
    expect(uiStore.getState().notice?.title).toMatch(/2 succeeded/);
  });

  it("continues after a failure", async () => {
    seedPending(["/tmp/bad.png", "/tmp/good.png"]);
    const deps = baseDeps({
      removeBackground: async (job) => {
        if (job.inputPath.includes("bad")) {
          throw { code: "decode", message: "nope" };
        }
      },
    });

    await startQueueProcess(deps);
    const byPath = Object.fromEntries(
      queueStore.getState().items.map((i) => [i.inputPath, i.status]),
    );
    expect(byPath["/tmp/bad.png"]).toBe("failed");
    expect(byPath["/tmp/good.png"]).toBe("done");
  });

  it("returns empty when no pending", async () => {
    seedPending(["/tmp/a.png"]);
    const id = queueStore.getState().items[0]!.id;
    queueStore.getState().markDone(id, "/tmp/a-out.png");
    const result = await startQueueProcess(baseDeps());
    expect(result).toBe("empty");
  });

  it("skip_existing marks existing-output items done and processes the rest", async () => {
    seedPending(["/tmp/exists.png", "/tmp/new.png"]);
    const processed: string[] = [];
    const chooseOverwrite = vi.fn().mockResolvedValue("skip_existing");
    const deps = baseDeps({
      exists: async (path) => path.includes("exists"),
      chooseOverwrite,
      removeBackground: async (job) => {
        processed.push(job.inputPath);
      },
    });

    const result = await startQueueProcess(deps);
    expect(result).toBe("started");
    expect(chooseOverwrite).toHaveBeenCalledTimes(1);
    expect(processed).toEqual(["/tmp/new.png"]);

    const byPath = Object.fromEntries(
      queueStore.getState().items.map((i) => [i.inputPath, i]),
    );
    expect(byPath["/tmp/exists.png"]!.status).toBe("done");
    expect(byPath["/tmp/exists.png"]!.progress).toBe(100);
    expect(byPath["/tmp/new.png"]!.status).toBe("done");
    expect(queueStore.getState().running).toBe(false);
  });

  it("returns busy while start latch held during slow overwrite dialog", async () => {
    seedPending(["/tmp/a.png"]);
    let release!: (v: "overwrite_all") => void;
    const choosePromise = new Promise<"overwrite_all">((resolve) => {
      release = resolve;
    });
    const deps = baseDeps({
      exists: async () => true,
      chooseOverwrite: async () => choosePromise,
    });

    const first = startQueueProcess(deps);
    await vi.waitFor(() => {
      expect(isQueueRunActive()).toBe(true);
    });

    const second = await startQueueProcess(baseDeps());
    expect(second).toBe("busy");

    release("overwrite_all");
    await first;
    expect(queueStore.getState().running).toBe(false);
  });

  it("creates folder output dir when process starts, not earlier", async () => {
    queueStore.getState().activateWithItems(
      [
        {
          id: "a",
          inputPath: "/folder/a.png",
          outputPath: "/folder-nobg/a-out.png",
          status: "pending",
          progress: 0,
          stage: null,
          error: null,
          jobId: null,
        },
      ],
      {
        kind: "folder",
        path: "/folder",
        outputDir: "/folder-nobg",
        watch: false,
      },
    );

    const ensureDir = vi.fn().mockResolvedValue(undefined);
    await startQueueProcess(
      baseDeps({
        ensureDir,
        removeBackground: async () => {},
      }),
    );

    expect(ensureDir).toHaveBeenCalledTimes(1);
    expect(ensureDir).toHaveBeenCalledWith("/folder-nobg");
  });

  it("watch-only scope processes only fromWatch pending items", async () => {
    queueStore.getState().activateWithItems(
      [
        {
          id: "seed",
          inputPath: "/folder/existing.png",
          outputPath: "/folder-nobg/existing-out.png",
          status: "pending",
          progress: 0,
          stage: null,
          error: null,
          jobId: null,
        },
        {
          id: "watch",
          inputPath: "/folder/new.png",
          outputPath: "/folder-nobg/new-out.png",
          status: "pending",
          progress: 0,
          stage: null,
          error: null,
          jobId: null,
          fromWatch: true,
        },
      ],
      {
        kind: "folder",
        path: "/folder",
        outputDir: "/folder-nobg",
        watch: true,
      },
    );

    const processed: string[] = [];
    const result = await startQueueProcess(
      baseDeps({
        forceOverwriteAll: true,
        pendingScope: "watch-only",
        removeBackground: async (job) => {
          processed.push(job.inputPath);
        },
      }),
    );

    expect(result).toBe("started");
    expect(processed).toEqual(["/folder/new.png"]);
    const byId = Object.fromEntries(
      queueStore.getState().items.map((i) => [i.id, i.status]),
    );
    expect(byId.seed).toBe("pending");
    expect(byId.watch).toBe("done");
  });
});
