import { beforeEach, describe, expect, it, vi } from "vitest";
import { queueStore } from "../stores/queueStore";
import { uiStore } from "../stores/uiStore";
import { type QueueRunnerDeps, startQueueProcess } from "./queueRunner";

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

describe("startQueueProcess", () => {
  beforeEach(() => {
    queueStore.getState().clearAll();
    uiStore.getState().dismissNotice();
  });

  it("processes pending items serially and marks done", async () => {
    seedPending(["/tmp/a.png", "/tmp/b.png"]);
    const order: string[] = [];
    const noopListen = async () => () => {};
    const deps: QueueRunnerDeps = {
      exists: async () => false,
      ask: async () => true,
      removeBackground: async (job) => {
        order.push(job.inputPath);
      },
      cancelInference: async () => {},
      getSettings: () => ({ mode: "u2netp", outputDir: null }),
      listenProgress: noopListen,
      listenDone: noopListen,
      listenError: noopListen,
    };

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
    const noopListen = async () => () => {};
    const deps: QueueRunnerDeps = {
      exists: async () => false,
      ask: async () => true,
      removeBackground: async (job) => {
        if (job.inputPath.includes("bad")) {
          throw { code: "decode", message: "nope" };
        }
      },
      cancelInference: async () => {},
      getSettings: () => ({ mode: "u2netp", outputDir: null }),
      listenProgress: noopListen,
      listenDone: noopListen,
      listenError: noopListen,
    };

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
    const result = await startQueueProcess({
      exists: async () => false,
      ask: async () => true,
      removeBackground: async () => {},
      cancelInference: async () => {},
      getSettings: () => ({ mode: "u2netp", outputDir: null }),
    });
    expect(result).toBe("empty");
  });
});
