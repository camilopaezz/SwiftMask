import { useStore } from "zustand/react";
import { createStore } from "zustand/vanilla";

export type ImageStatus =
  | "ready"
  | "processing"
  | "done"
  | "error"
  | "cancelled";

/** Structured process error (wire `{ code, message }`). */
export type ImageError = {
  code: string;
  message: string;
};

export type ImageItem = {
  id: string;
  inputPath: string;
  outputPath: string | null;
  status: ImageStatus;
  progress: number;
  stage: string | null;
  error: ImageError | null;
};

export type ImageState = {
  current: ImageItem | null;
};

export type ImageActions = {
  set: (item: ImageItem) => void;
  patch: (patch: Partial<ImageItem>) => void;
  clear: () => void;
};

export const imageStore = createStore<ImageState & ImageActions>((set) => ({
  current: null,
  set: (item) => set({ current: item }),
  patch: (patch) =>
    set((state) =>
      state.current ? { current: { ...state.current, ...patch } } : state,
    ),
  clear: () => set({ current: null }),
}));

export function useImageStore(): ImageState & ImageActions;
export function useImageStore<T>(
  selector: (state: ImageState & ImageActions) => T,
): T;
export function useImageStore<T>(
  selector?: (state: ImageState & ImageActions) => T,
): (ImageState & ImageActions) | T {
  return useStore(imageStore, selector ?? ((state) => state as unknown as T));
}
