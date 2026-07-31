import { queueStore } from "../stores/queueStore";
import { settingsStore } from "../stores/settingsStore";
import { enqueueFromDrop } from "./queue";
import { isQueueRunActive, startQueueProcess } from "./queueRunner";
import {
  invokeWatchFolderStart,
  invokeWatchFolderStop,
  listenFolderReady,
} from "./tauri";

let unsubReady: (() => void) | null = null;

export async function setFolderWatch(enabled: boolean): Promise<void> {
  const source = queueStore.getState().source;
  if (source?.kind !== "folder") return;

  if (!enabled) {
    await stopFolderWatch();
    queueStore.getState().setWatch(false);
    return;
  }

  await invokeWatchFolderStart(source.path);
  if (!unsubReady) {
    unsubReady = await listenFolderReady((payload) => {
      void onFolderReady(payload.path);
    });
  }
  queueStore.getState().setWatch(true);
}

export async function stopFolderWatch(): Promise<void> {
  try {
    await invokeWatchFolderStop();
  } catch {
    // ignore
  }
  if (unsubReady) {
    unsubReady();
    unsubReady = null;
  }
  const source = queueStore.getState().source;
  if (source?.kind === "folder" && source.watch) {
    queueStore.getState().setWatch(false);
  }
}

async function onFolderReady(path: string): Promise<void> {
  const source = queueStore.getState().source;
  if (source?.kind !== "folder" || !source.watch) return;

  const { mode, outputDir } = settingsStore.getState();
  const result = await enqueueFromDrop(
    [path],
    { mode, outputDir },
    {
      askConfirm: async () => true,
    },
  );
  if (result !== "enqueued" && result !== "appended") return;

  // Auto-run when idle (always overwrite — skip batch overwrite dialog by
  // starting process only when not running; resolveBatchOverwrite still asks
  // if outputs exist — for watch we need overwrite_all without dialog).
  if (!isQueueRunActive() && !queueStore.getState().running) {
    // Force overwrite path: pre-mark no skip by ensuring exists ask always true.
    await startQueueProcess({
      exists: async () => false, // treat as no collision → overwrite_all without ask
      ask: async () => true,
      removeBackground: (await import("./currentImage")).prodStartProcessDeps()
        .removeBackground,
      cancelInference: (await import("./currentImage")).prodCancelDeps()
        .cancelInference,
      getSettings: () => {
        const s = settingsStore.getState();
        return { mode: s.mode, outputDir: s.outputDir };
      },
    });
  }
}
