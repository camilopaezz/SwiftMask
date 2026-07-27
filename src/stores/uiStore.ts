import { useStore } from "zustand/react";
import { createStore } from "zustand/vanilla";

export type NoticeSeverity = "error" | "warning" | "info";

export type AppNotice = {
  /** Replace identity for React keys / a11y. */
  id: string;
  severity: NoticeSeverity;
  title: string;
  body?: string;
  code?: string;
};

type UiState = {
  /** True while NC license or model download modal is open. */
  modalBlocksShortcuts: boolean;
  setModalBlocksShortcuts: (blocked: boolean) => void;

  /** Single shared notice slot (newest replaces). */
  notice: AppNotice | null;
  showNotice: (notice: Omit<AppNotice, "id"> & { id?: string }) => void;
  dismissNotice: () => void;
};

let noticeSeq = 0;

export const uiStore = createStore<UiState>((set) => ({
  modalBlocksShortcuts: false,
  setModalBlocksShortcuts: (blocked) => set({ modalBlocksShortcuts: blocked }),

  notice: null,
  showNotice: (notice) =>
    set({
      notice: {
        id: notice.id ?? `notice-${++noticeSeq}`,
        severity: notice.severity,
        title: notice.title,
        body: notice.body,
        code: notice.code,
      },
    }),
  dismissNotice: () => set({ notice: null }),
}));

export function useUiStore(): UiState;
export function useUiStore<T>(selector: (state: UiState) => T): T;
export function useUiStore<T>(selector?: (state: UiState) => T): UiState | T {
  return useStore(uiStore, selector ?? ((state) => state as unknown as T));
}
