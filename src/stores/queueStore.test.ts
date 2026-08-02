import { beforeEach, describe, expect, it } from "vitest";
import {
  type QueueItem,
  queueStore,
  resolveQueuePreviewId,
} from "./queueStore";

function makeItem(overrides: Partial<QueueItem> & { id: string }): QueueItem {
  return {
    inputPath: `/tmp/${overrides.id}.png`,
    outputPath: `/tmp/out/${overrides.id}.png`,
    status: "pending",
    progress: 0,
    stage: null,
    error: null,
    jobId: null,
    ...overrides,
  };
}

describe("queueStore FIFO seq", () => {
  beforeEach(() => {
    queueStore.getState().clearAll();
  });

  it("assigns ascending seq on activate and preserves pending order (not path alpha)", () => {
    // Paths would sort z before a alphabetically — seq must win.
    queueStore
      .getState()
      .activateWithItems(
        [
          makeItem({ id: "z", inputPath: "/tmp/z.png" }),
          makeItem({ id: "a", inputPath: "/tmp/a.png" }),
          makeItem({ id: "m", inputPath: "/tmp/m.png" }),
        ],
        { kind: "drop" },
      );

    const pending = queueStore
      .getState()
      .items.filter((i) => i.status === "pending");
    expect(pending.map((i) => i.id)).toEqual(["z", "a", "m"]);
    expect(pending.map((i) => i.seq)).toEqual([1, 2, 3]);
  });

  it("appends with seq after max existing so process order stays FIFO", () => {
    queueStore
      .getState()
      .activateWithItems(
        [
          makeItem({ id: "first", inputPath: "/tmp/zzz-first.png" }),
          makeItem({ id: "second", inputPath: "/tmp/aaa-second.png" }),
        ],
        { kind: "drop" },
      );

    queueStore
      .getState()
      .appendItems([
        makeItem({ id: "third", inputPath: "/tmp/mmm-third.png" }),
      ]);

    const pending = queueStore
      .getState()
      .items.filter((i) => i.status === "pending");
    expect(pending.map((i) => i.id)).toEqual(["first", "second", "third"]);
    expect(pending.map((i) => i.seq)).toEqual([1, 2, 3]);
  });

  it("keeps processing first then pending by seq in display sort", () => {
    queueStore
      .getState()
      .activateWithItems(
        [
          makeItem({ id: "p1", inputPath: "/tmp/z.png" }),
          makeItem({ id: "p2", inputPath: "/tmp/a.png" }),
        ],
        { kind: "drop" },
      );
    queueStore.getState().patchItem("p2", { status: "processing" });

    const ids = queueStore.getState().items.map((i) => i.id);
    expect(ids[0]).toBe("p2");
    expect(ids.slice(1)).toEqual(["p1"]);
  });

  it("resolveQueuePreviewId prefers processing over selection", () => {
    queueStore
      .getState()
      .activateWithItems(
        [makeItem({ id: "a" }), makeItem({ id: "b", status: "processing" })],
        { kind: "drop" },
      );
    queueStore.getState().select("a");
    // select pins — pin to a; processing still wins when pin cleared
    queueStore.getState().pin(null);
    expect(resolveQueuePreviewId(queueStore.getState())).toBe("b");
  });
});
