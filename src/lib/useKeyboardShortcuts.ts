import { useEffect } from "react";
import { useImageStore } from "../stores/imageStore";
import { settingsStore } from "../stores/settingsStore";
import {
  cancelProcess,
  isProcessBusy,
  prodCancelDeps,
  prodStartProcessDeps,
  startProcess,
} from "./currentImage";
import {
  matchShortcutKey,
  resolveShortcutAction,
  shortcutContextEnabled,
} from "./keyboardShortcuts";
import { openImageFile } from "./openImage";

export type UseKeyboardShortcutsOptions = {
  ready: boolean;
  firstRun: boolean;
  settingsOpen: boolean;
  modalBlocksShortcuts: boolean;
};

export function useKeyboardShortcuts(options: UseKeyboardShortcutsOptions) {
  const currentStatus = useImageStore((state) => state.current?.status);
  const hasImage = useImageStore((state) => Boolean(state.current));

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;

      const key = matchShortcutKey(event);
      if (!key) return;

      const ctx = {
        enabled: shortcutContextEnabled({
          ready: options.ready,
          firstRun: options.firstRun,
          settingsOpen: options.settingsOpen,
          modalBlocksShortcuts: options.modalBlocksShortcuts,
        }),
        isProcessing: currentStatus === "processing",
        hasImage,
        isBusy: isProcessBusy(),
      };

      const action = resolveShortcutAction(key, ctx);
      if (!action) return;

      event.preventDefault();

      switch (action) {
        case "open": {
          const { mode, outputDir } = settingsStore.getState();
          void openImageFile({ mode, outputDir });
          break;
        }
        case "process":
          void startProcess(prodStartProcessDeps());
          break;
        case "cancel":
          cancelProcess(prodCancelDeps());
          break;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    options.ready,
    options.firstRun,
    options.settingsOpen,
    options.modalBlocksShortcuts,
    currentStatus,
    hasImage,
  ]);
}
