import { useEffect } from "react";
import { useImageStore } from "../stores/imageStore";
import { queueStore } from "../stores/queueStore";
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
import { pickAndOpenFolder, removeQueueItem, selectQueueItem } from "./queue";
import {
  cancelQueueProcess,
  isQueueRunActive,
  startQueueProcess,
} from "./queueRunner";

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

      const queue = queueStore.getState();
      const queueActive = queue.active;

      // Queue-specific keys when drawer expanded / items present.
      if (
        queueActive &&
        options.ready &&
        !options.firstRun &&
        !options.settingsOpen &&
        !options.modalBlocksShortcuts
      ) {
        if (event.key === "Delete" || event.key === "Backspace") {
          const id = queue.selectedId;
          const item = queue.items.find((i) => i.id === id);
          if (item && item.status !== "processing") {
            event.preventDefault();
            removeQueueItem(item.id);
            return;
          }
        }
        if (
          queue.drawerOpen &&
          (event.key === "ArrowDown" || event.key === "ArrowUp")
        ) {
          event.preventDefault();
          const items = queue.items;
          if (items.length === 0) return;
          const idx = Math.max(
            0,
            items.findIndex((i) => i.id === queue.selectedId),
          );
          const next =
            event.key === "ArrowDown"
              ? items[Math.min(items.length - 1, idx + 1)]
              : items[Math.max(0, idx - 1)];
          if (next) selectQueueItem(next.id);
          return;
        }
      }

      const key = matchShortcutKey(event);
      if (!key) return;

      const ctx = {
        enabled: shortcutContextEnabled({
          ready: options.ready,
          firstRun: options.firstRun,
          settingsOpen: options.settingsOpen,
          modalBlocksShortcuts: options.modalBlocksShortcuts,
        }),
        isProcessing:
          currentStatus === "processing" || queue.running || isQueueRunActive(),
        hasImage: hasImage || (queueActive && queue.items.length > 0),
        isBusy: isProcessBusy() || isQueueRunActive(),
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
        case "openFolder": {
          const { mode, outputDir } = settingsStore.getState();
          void pickAndOpenFolder({ mode, outputDir });
          break;
        }
        case "process":
          if (queueActive) {
            void startQueueProcess();
          } else {
            void startProcess(prodStartProcessDeps());
          }
          break;
        case "cancel":
          if (queueActive && (queue.running || isQueueRunActive())) {
            void cancelQueueProcess();
          } else {
            void cancelProcess(prodCancelDeps());
          }
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
