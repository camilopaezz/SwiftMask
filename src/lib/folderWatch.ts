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
 * Watch auto-run gate for the current folder session:
 * - idle: no full Process yet (or session reset) — enqueue only
 * - armed: auto-process watch arrivals when worker idle
 * - paused: user cancelled a run — enqueue only until Process again
 */
type AutoRunGate = "idle" | "armed" | "paused";
let autoRunGate: AutoRunGate = "idle";

/** User cancelled a queue run — keep enqueueing, stop auto-start until Process. */
export function pauseWatchAutoRun(): void {
  if (autoRunGate === "armed") autoRunGate = "paused";
}

/** Manual Process that actually starts arms auto-run for subsequent watch arrivals. */
export function armWatchAutoRun(): void {
  autoRunGate = "armed";
}

export function disarmWatchAutoRun(): void {
  autoRunGate = "idle";
}

export async function setFolderWatch(enabled: boolean): Promise<void> {
  const source = queueStore.getState().source;
  if (source?.kind !== "folder") return;

  if (!enabled) {
    await stopFolderWatch();
    return;
  }

  // Enabling watch does not arm auto-run — first Process still required.
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
  // Closing/clearing the watch session resets the Process gate.
  disarmWatchAutoRun();
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
      fromWatch: true,
    },
  );
  if (result !== "enqueued" && result !== "appended") return;

  // Spec §2.5: watch auto-run always overwrites (no dialog).
  // Auto-process only when armed (after first manual Process), and only
  // watch arrivals (not leftover open-folder pending).
  if (autoRunGate !== "armed") return;
  if (isQueueRunActive() || queueStore.getState().running) return;

  const base = prodQueueRunnerDeps();
  await startQueueProcess({
    ...base,
    exists: invokePathExists,
    forceOverwriteAll: true,
    pendingScope: "watch-only",
  });
}
