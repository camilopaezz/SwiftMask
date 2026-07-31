import { queueStore } from "../stores/queueStore";
import { settingsStore } from "../stores/settingsStore";
import { enqueueFromDrop } from "./queue";
import {
  isQueueRunActive,
  prodQueueRunnerDeps,
  startQueueProcess,
} from "./queueRunner";
import {
  invokePathExists,
  invokeWatchFolderStart,
  invokeWatchFolderStop,
  listenFolderReady,
} from "./tauri";

let unsubReady: (() => void) | null = null;

/**
 * After the user cancels a queue run, keep enqueueing watch arrivals but do not
 * auto-start Process until they hit Process (or re-enable watch).
 */
let autoRunPaused = false;

export function resumeWatchAutoRun(): void {
  autoRunPaused = false;
}

export function pauseWatchAutoRun(): void {
  autoRunPaused = true;
}

export async function setFolderWatch(enabled: boolean): Promise<void> {
  const source = queueStore.getState().source;
  if (source?.kind !== "folder") return;

  if (!enabled) {
    await stopFolderWatch();
    return;
  }

  autoRunPaused = false;
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

  // Spec §2.5: watch auto-run always overwrites (no dialog).
  // Spec §2.2: auto-process when worker idle — unless user cancelled (paused).
  if (autoRunPaused) return;
  if (isQueueRunActive() || queueStore.getState().running) return;

  const base = prodQueueRunnerDeps();
  await startQueueProcess({
    ...base,
    exists: invokePathExists,
    forceOverwriteAll: true,
  });
}
