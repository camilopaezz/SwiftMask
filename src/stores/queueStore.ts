import { useStore } from "zustand/react";
import { createStore } from "zustand/vanilla";

/** Queue row status — CP1 only uses pending; later CPs add processing/done/failed. */
export type QueueItemStatus = "pending" | "processing" | "done" | "failed";

export type QueueItem = {
  id: string;
  inputPath: string;
  /** Derived for later process; unused in CP1 run loop. */
  outputPath: string;
  status: QueueItemStatus;
};

export type QueueSource = {
  kind: "drop";
};

export type QueueState = {
  /** When true, shell shows queue UI instead of single-image current. */
  active: boolean;
  items: QueueItem[];
  selectedId: string | null;
  source: QueueSource | null;
  drawerOpen: boolean;
  /** After first enter this session, remember user toggle. */
  drawerTouched: boolean;
};

export type QueueActions = {
  activateWithItems: (items: QueueItem[], source: QueueSource) => void;
  appendItems: (items: QueueItem[]) => void;
  select: (id: string | null) => void;
  remove: (id: string) => void;
  clearAll: () => void;
  setDrawerOpen: (open: boolean) => void;
  toggleDrawer: () => void;
};

const initial: QueueState = {
  active: false,
  items: [],
  selectedId: null,
  source: null,
  drawerOpen: true,
  drawerTouched: false,
};

export const queueStore = createStore<QueueState & QueueActions>(
  (set, get) => ({
    ...initial,

    activateWithItems: (items, source) => {
      if (items.length === 0) return;
      const state = get();
      set({
        active: true,
        items,
        selectedId: items[0]?.id ?? null,
        source,
        // First enter this session → expanded; later activations keep preference.
        drawerOpen: state.drawerTouched ? state.drawerOpen : true,
      });
    },

    appendItems: (items) => {
      if (items.length === 0) return;
      set((state) => {
        const next = [...state.items, ...items];
        return {
          active: true,
          items: next,
          selectedId: state.selectedId ?? items[0]?.id ?? null,
          source: state.source ?? { kind: "drop" },
          drawerOpen: state.drawerTouched ? state.drawerOpen : true,
        };
      });
    },

    select: (id) => set({ selectedId: id }),

    remove: (id) =>
      set((state) => {
        const items = state.items.filter((i) => i.id !== id);
        if (items.length === 0) {
          return { ...initial };
        }
        const selectedId =
          state.selectedId === id ? (items[0]?.id ?? null) : state.selectedId;
        return { items, selectedId, active: true };
      }),

    clearAll: () => set({ ...initial }),

    setDrawerOpen: (open) => set({ drawerOpen: open, drawerTouched: true }),

    toggleDrawer: () =>
      set((state) => ({
        drawerOpen: !state.drawerOpen,
        drawerTouched: true,
      })),
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
