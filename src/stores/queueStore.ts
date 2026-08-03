import { useStore } from "zustand/react";
import { createStore } from "zustand/vanilla";

export type QueueItemStatus = "pending" | "processing" | "done" | "failed";

export type QueueItemError = {
  code: string;
  message: string;
};

export type QueueItem = {
  id: string;
  inputPath: string;
  outputPath: string;
  status: QueueItemStatus;
  progress: number;
  stage: string | null;
  error: QueueItemError | null;
  /** Active inference job id while processing. */
  jobId: string | null;
  /**
   * FIFO order for pending processing and stable display within a status group.
   * Assigned on activate/append when missing (external factories may omit it).
   */
  seq?: number;
  /**
   * Enqueued by folder-watch settle. Watch auto-run only drains these until the
   * user hits Process (which drains all pending).
   */
  fromWatch?: boolean;
};

export type QueueSource =
  | { kind: "drop" }
  | { kind: "folder"; path: string; outputDir: string; watch: boolean };

export type QueueState = {
  active: boolean;
  items: QueueItem[];
  selectedId: string | null;
  /** User pinned a row for preview; null = auto-follow running/selected. */
  pinnedId: string | null;
  source: QueueSource | null;
  drawerOpen: boolean;
  drawerTouched: boolean;
  /** Serial run in progress. */
  running: boolean;
  /** User requested cancel of the current job only. */
  cancelRequested: boolean;
};

export type QueueActions = {
  activateWithItems: (items: QueueItem[], source: QueueSource) => void;
  appendItems: (items: QueueItem[]) => void;
  select: (id: string | null) => void;
  pin: (id: string | null) => void;
  remove: (id: string) => void;
  clearAll: () => void;
  clearByStatus: (status: QueueItemStatus) => void;
  toggleDrawer: () => void;
  setRunning: (running: boolean) => void;
  setCancelRequested: (cancel: boolean) => void;
  patchItem: (id: string, patch: Partial<QueueItem>) => void;
  markDone: (id: string, outputPath: string) => void;
  markFailed: (id: string, error: QueueItemError) => void;
  resetToPending: (id: string) => void;
  retryAllFailed: () => void;
  setWatch: (watch: boolean) => void;
};

function itemSeq(item: QueueItem): number {
  return item.seq ?? 0;
}

/** Display order: processing → pending (seq) → failed → done (seq). Not path alpha. */
function sortItems(items: QueueItem[]): QueueItem[] {
  const rank: Record<QueueItemStatus, number> = {
    processing: 0,
    pending: 1,
    failed: 2,
    done: 3,
  };
  return [...items].sort((a, b) => {
    const d = rank[a.status] - rank[b.status];
    if (d !== 0) return d;
    const seqDiff = itemSeq(a) - itemSeq(b);
    if (seqDiff !== 0) return seqDiff;
    // Stable tie-break only (not process order).
    return a.id.localeCompare(b.id);
  });
}

function maxSeq(items: QueueItem[]): number {
  let max = 0;
  for (const item of items) {
    const s = item.seq;
    if (typeof s === "number" && s > max) max = s;
  }
  return max;
}

/** Assign ascending seq for items missing one; preserve existing seq values. */
function assignSeqs(items: QueueItem[], existing: QueueItem[]): QueueItem[] {
  let next = maxSeq(existing) + 1;
  return items.map((item) => {
    if (item.seq != null) {
      if (item.seq >= next) next = item.seq + 1;
      return item;
    }
    const seq = next;
    next += 1;
    return { ...item, seq };
  });
}

function makeEmpty(): QueueState {
  return {
    active: false,
    items: [],
    selectedId: null,
    pinnedId: null,
    source: null,
    drawerOpen: true,
    drawerTouched: false,
    running: false,
    cancelRequested: false,
  };
}

const initial = makeEmpty();

export const queueStore = createStore<QueueState & QueueActions>(
  (set, get) => ({
    ...initial,

    activateWithItems: (items, source) => {
      if (items.length === 0) return;
      const state = get();
      // Fresh activation: assign seq in array order starting at 1.
      const withSeq = assignSeqs(items, []);
      set({
        active: true,
        items: sortItems(withSeq),
        selectedId: withSeq[0]?.id ?? null,
        pinnedId: null,
        source,
        drawerOpen: state.drawerTouched ? state.drawerOpen : true,
        running: false,
        cancelRequested: false,
      });
    },

    appendItems: (items) => {
      if (items.length === 0) return;
      set((state) => {
        const withSeq = assignSeqs(items, state.items);
        const next = sortItems([...state.items, ...withSeq]);
        return {
          active: true,
          items: next,
          selectedId: state.selectedId ?? withSeq[0]?.id ?? null,
          source: state.source ?? { kind: "drop" },
          drawerOpen: state.drawerTouched ? state.drawerOpen : true,
        };
      });
    },

    select: (id) => set({ selectedId: id, pinnedId: id }),

    pin: (id) => set({ pinnedId: id }),

    remove: (id) =>
      set((state) => {
        const target = state.items.find((i) => i.id === id);
        if (target?.status === "processing") return state;
        const items = state.items.filter((i) => i.id !== id);
        if (items.length === 0) {
          return { ...makeEmpty() };
        }
        const selectedId =
          state.selectedId === id ? (items[0]?.id ?? null) : state.selectedId;
        const pinnedId = state.pinnedId === id ? null : state.pinnedId;
        return { items: sortItems(items), selectedId, pinnedId, active: true };
      }),

    clearAll: () => set({ ...makeEmpty() }),

    clearByStatus: (status) =>
      set((state) => {
        if (status === "processing") return state;
        const items = state.items.filter((i) => i.status !== status);
        if (items.length === 0) {
          return state.running
            ? {
                ...state,
                items: [],
                selectedId: null,
                pinnedId: null,
              }
            : { ...makeEmpty() };
        }
        const selectedStill = items.some((i) => i.id === state.selectedId);
        return {
          ...state,
          items: sortItems(items),
          selectedId: selectedStill ? state.selectedId : (items[0]?.id ?? null),
          pinnedId: items.some((i) => i.id === state.pinnedId)
            ? state.pinnedId
            : null,
          active: true,
        };
      }),

    toggleDrawer: () =>
      set((state) => ({
        drawerOpen: !state.drawerOpen,
        drawerTouched: true,
      })),

    setRunning: (running) => set({ running, cancelRequested: false }),

    setCancelRequested: (cancel) => set({ cancelRequested: cancel }),

    patchItem: (id, patch) =>
      set((state) => ({
        items: sortItems(
          state.items.map((i) => (i.id === id ? { ...i, ...patch } : i)),
        ),
      })),

    markDone: (id, outputPath) =>
      set((state) => ({
        items: sortItems(
          state.items.map((i) =>
            i.id === id
              ? {
                  ...i,
                  status: "done" as const,
                  progress: 100,
                  stage: null,
                  error: null,
                  jobId: null,
                  outputPath,
                }
              : i,
          ),
        ),
      })),

    markFailed: (id, error) =>
      set((state) => ({
        items: sortItems(
          state.items.map((i) =>
            i.id === id
              ? {
                  ...i,
                  status: "failed" as const,
                  progress: 0,
                  stage: null,
                  error,
                  jobId: null,
                }
              : i,
          ),
        ),
        drawerOpen: true,
        drawerTouched: true,
      })),

    resetToPending: (id) =>
      set((state) => ({
        items: sortItems(
          state.items.map((i) =>
            i.id === id
              ? {
                  ...i,
                  status: "pending" as const,
                  progress: 0,
                  stage: null,
                  error: null,
                  jobId: null,
                }
              : i,
          ),
        ),
      })),

    retryAllFailed: () =>
      set((state) => ({
        items: sortItems(
          state.items.map((i) =>
            i.status === "failed"
              ? {
                  ...i,
                  status: "pending" as const,
                  progress: 0,
                  stage: null,
                  error: null,
                  jobId: null,
                }
              : i,
          ),
        ),
      })),

    setWatch: (watch) =>
      set((state) => {
        if (state.source?.kind !== "folder") return state;
        return {
          source: { ...state.source, watch },
        };
      }),
  }),
);

export function useQueueStore(): QueueState & QueueActions;
export function useQueueStore<T>(
  selector: (state: QueueState & QueueActions) => T,
): T;
export function useQueueStore<T>(
  selector?: (state: QueueState & QueueActions) => T,
): (QueueState & QueueActions) | T {
  return useStore(queueStore, selector ?? ((state) => state as unknown as T));
}

export function fileNameFromPath(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** Preview target: pinned, else processing, else selected, else first. */
export function resolveQueuePreviewId(state: QueueState): string | null {
  if (state.pinnedId && state.items.some((i) => i.id === state.pinnedId)) {
    return state.pinnedId;
  }
  const processing = state.items.find((i) => i.status === "processing");
  if (processing) return processing.id;
  if (state.selectedId && state.items.some((i) => i.id === state.selectedId)) {
    return state.selectedId;
  }
  return state.items[0]?.id ?? null;
}
