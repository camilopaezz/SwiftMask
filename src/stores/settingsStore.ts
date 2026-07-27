import { useStore } from "zustand/react";
import { createStore } from "zustand/vanilla";
import {
  FALLBACK_DEFAULT_MODE,
  type ModelMeta,
  type ModelMode,
  resolveMode,
} from "../lib/models";
import type { GpuInfo, JobTimings, RuntimeInfo } from "../lib/tauri";
import type { Theme } from "../lib/theme";

export type { Theme } from "../lib/theme";

export type SettingsState = {
  mode: ModelMode;
  /** Runtime catalog from `list_models` (empty until App bootstrap). */
  models: ModelMeta[];
  outputDir: string | null;
  ep: string | null;
  theme: Theme;
  gpuInfo: GpuInfo | null;
  runtimeInfo: RuntimeInfo | null;
  lastJobTimings: JobTimings | null;
};

export type SettingsActions = {
  setMode: (mode: ModelMode) => void;
  /** Replace catalog and reconcile `mode` against ready models. */
  applyModels: (models: ModelMeta[]) => void;
  /** Optimistic download-complete flag before list_models refresh. */
  markModelDownloaded: (modelId: string) => void;
  setOutputDir: (outputDir: string | null) => void;
  setEp: (ep: string | null) => void;
  setTheme: (theme: Theme) => void;
  setGpuInfo: (gpuInfo: GpuInfo | null) => void;
  setRuntimeInfo: (runtimeInfo: RuntimeInfo | null) => void;
  setLastJobTimings: (lastJobTimings: JobTimings | null) => void;
};

export const settingsStore = createStore<SettingsState & SettingsActions>(
  (set) => ({
    // Bundled Turbo until App reconciles against list_models.
    mode: FALLBACK_DEFAULT_MODE,
    models: [],
    outputDir: null,
    ep: null,
    theme: "system",
    gpuInfo: null,
    runtimeInfo: null,
    lastJobTimings: null,
    setMode: (mode) => set({ mode }),
    applyModels: (models) =>
      set((state) => ({
        models,
        mode: resolveMode(state.mode, models),
      })),
    markModelDownloaded: (modelId) =>
      set((state) => ({
        models: state.models.map((m) =>
          m.id === modelId ? { ...m, downloaded: true } : m,
        ),
      })),
    setOutputDir: (outputDir) => set({ outputDir }),
    setEp: (ep) => set({ ep }),
    setTheme: (theme) => set({ theme }),
    setGpuInfo: (gpuInfo) => set({ gpuInfo }),
    setRuntimeInfo: (runtimeInfo) => set({ runtimeInfo }),
    setLastJobTimings: (lastJobTimings) => set({ lastJobTimings }),
  }),
);

export function useSettingsStore(): SettingsState & SettingsActions;
export function useSettingsStore<T>(
  selector: (state: SettingsState & SettingsActions) => T,
): T;
export function useSettingsStore<T>(
  selector?: (state: SettingsState & SettingsActions) => T,
): (SettingsState & SettingsActions) | T {
  return useStore(
    settingsStore,
    selector ?? ((state) => state as unknown as T),
  );
}
