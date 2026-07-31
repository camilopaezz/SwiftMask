import { queueStore } from "../stores/queueStore";
import { settingsStore } from "../stores/settingsStore";
import { uiStore } from "../stores/uiStore";
import {
  isProcessBusy,
  type ProcessSettings,
  prodCancelDeps,
  prodStartProcessDeps,
} from "./currentImage";
import { ERROR_CODES, parseAppError } from "./parseAppError";
import { deriveOutputPath } from "./path";
import {
  type BatchOverwriteChoice,
  type BatchOverwriteChooser,
  prodBatchOverwriteChooser,
  resolveBatchOverwrite,
} from "./queueOverwrite";
import {
  invokeCancelInference,
  invokePathExists,
  invokeRemoveImageBackground,
  listenInferenceDone,
  listenInferenceError,
  listenInferenceProgress,
} from "./tauri";

export type QueueRunnerDeps = {
  exists: (path: string) => Promise<boolean>;
  /** One-shot overwrite / skip / cancel chooser for existing outputs. */
  chooseOverwrite: BatchOverwriteChooser;
  removeBackground: (job: {
    id: string;
    inputPath: string;
    outputPath: string;
    modelId: string;
  }) => Promise<void>;
  cancelInference: (jobId: string) => Promise<void>;
  getSettings: () => ProcessSettings;
  /**
   * When true, skip the batch overwrite dialog and always overwrite.
   * Used by folder-watch auto-run (spec §2.5).
   */
  forceOverwriteAll?: boolean;
  /** Optional: tests inject no-op listeners; prod uses tauri events. */
  listenProgress?: (
    handler: (payload: { id: string; stage: string; pct: number }) => void,
  ) => Promise<() => void>;
  listenDone?: (
    handler: (payload: { id: string; output_path: string }) => void,
  ) => Promise<() => void>;
  listenError?: (
    handler: (payload: { id: string; code?: string; message: string }) => void,
  ) => Promise<() => void>;
};

let runLoopActive = false;
/** Bumped when a run truly starts processing and when force-aborted before the loop. */
let runGeneration = 0;

export function isQueueRunActive(): boolean {
  return runLoopActive || queueStore.getState().running;
}

export function getQueueRunGeneration(): number {
  return runGeneration;
}

/**
 * Poll until the queue run loop is idle.
 * Callers that mutate the queue after cancel must await this after cancelQueueProcess.
 */
export async function waitForQueueIdle(timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (runLoopActive || queueStore.getState().running) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitForQueueIdle: timed out");
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Test-only: clear module latch left by aborted/parallel suite runs. */
export function resetQueueRunnerForTests(): void {
  runLoopActive = false;
  runGeneration += 1;
  queueStore.getState().setRunning(false);
  queueStore.getState().setCancelRequested(false);
}

function showFinishNotice(succeeded: number, failed: number): void {
  const severity = failed > 0 ? ("warning" as const) : ("info" as const);
  uiStore.getState().showNotice({
    severity,
    title: `Finished: ${succeeded} succeeded, ${failed} failed`,
    code: "queue_finished",
  });
}

function effectiveOutputDir(settings: ProcessSettings): string | null {
  const source = queueStore.getState().source;
  if (source?.kind === "folder") return source.outputDir;
  return settings.outputDir;
}

function refreshOutputPaths(settings: ProcessSettings): void {
  const { items, patchItem } = queueStore.getState();
  const outDir = effectiveOutputDir(settings);
  for (const item of items) {
    if (item.status !== "pending" && item.status !== "failed") continue;
    const outputPath = deriveOutputPath(item.inputPath, outDir, settings.mode);
    if (outputPath !== item.outputPath) {
      patchItem(item.id, { outputPath });
    }
  }
}

function clearRunLatch(): void {
  runLoopActive = false;
  queueStore.getState().setRunning(false);
  queueStore.getState().setCancelRequested(false);
}

/**
 * Drain pending queue items serially. Safe to call while already running (no-op).
 */
export async function startQueueProcess(
  deps: QueueRunnerDeps = prodQueueRunnerDeps(),
): Promise<"started" | "busy" | "empty" | "cancelled" | "blocked"> {
  // Manual Process (or any start) resumes watch auto-run after a user cancel.
  void import("./folderWatch").then((m) => {
    m.resumeWatchAutoRun();
  });

  if (runLoopActive || queueStore.getState().running) return "busy";
  if (isProcessBusy()) return "busy";

  const settings = deps.getSettings();
  refreshOutputPaths(settings);

  const pending = queueStore
    .getState()
    .items.filter((i) => i.status === "pending");
  if (pending.length === 0) return "empty";

  // Latch before overwrite dialog so a second Process returns busy immediately.
  runLoopActive = true;
  queueStore.getState().setRunning(true);
  queueStore.getState().setCancelRequested(false);
  const startGeneration = ++runGeneration;

  let choice: BatchOverwriteChoice;
  try {
    choice = deps.forceOverwriteAll
      ? "overwrite_all"
      : await resolveBatchOverwrite(
          pending.map((i) => i.outputPath),
          deps.exists,
          deps.chooseOverwrite,
        );
  } catch (err) {
    runGeneration += 1;
    clearRunLatch();
    throw err;
  }

  if (choice === "cancel") {
    runGeneration += 1;
    clearRunLatch();
    return "cancelled";
  }

  // Re-validate after dialog: queue may have been cleared or generation bumped.
  if (
    startGeneration !== runGeneration ||
    !queueStore.getState().active ||
    queueStore.getState().cancelRequested
  ) {
    runGeneration += 1;
    clearRunLatch();
    return "cancelled";
  }

  const stillPending = queueStore
    .getState()
    .items.filter((i) => i.status === "pending");
  if (stillPending.length === 0) {
    runGeneration += 1;
    clearRunLatch();
    return "empty";
  }

  const runOverwritePolicy: Exclude<BatchOverwriteChoice, "cancel"> = choice;

  let succeeded = 0;
  let failed = 0;
  let wasCancelled = false;

  // Pre-mark skip_existing targets so they never remain pending.
  if (runOverwritePolicy === "skip_existing") {
    for (const item of stillPending) {
      if (await deps.exists(item.outputPath)) {
        queueStore.getState().patchItem(item.id, {
          status: "done",
          progress: 100,
          stage: null,
        });
        succeeded += 1;
      }
    }
  }

  try {
    // Snapshot order by current store sort; re-read pending each iteration for appends.
    while (true) {
      if (queueStore.getState().cancelRequested) {
        wasCancelled = true;
        break;
      }
      if (startGeneration !== runGeneration) {
        wasCancelled = true;
        break;
      }

      const next = queueStore
        .getState()
        .items.find((i) => i.status === "pending");
      if (!next) break;

      const liveSettings = deps.getSettings();
      const outputPath = deriveOutputPath(
        next.inputPath,
        effectiveOutputDir(liveSettings),
        liveSettings.mode,
      );

      // Sticky overwrite policy for mid-run appends (and any remaining exists).
      if (runOverwritePolicy === "skip_existing") {
        if (await deps.exists(outputPath)) {
          queueStore.getState().patchItem(next.id, {
            status: "done",
            progress: 100,
            stage: null,
            outputPath,
          });
          succeeded += 1;
          continue;
        }
      }
      // overwrite_all: always write (no exists check)

      const jobId = crypto.randomUUID();

      queueStore.getState().patchItem(next.id, {
        status: "processing",
        progress: 0,
        stage: "starting",
        error: null,
        jobId,
        outputPath,
      });
      if (!queueStore.getState().pinnedId) {
        queueStore.getState().select(next.id);
        // select pins — clear pin so auto-follow continues
        queueStore.getState().pin(null);
      }

      const unsubs: Array<() => void> = [];
      const listenProgress = deps.listenProgress ?? listenInferenceProgress;
      const listenDone = deps.listenDone ?? listenInferenceDone;
      const listenError = deps.listenError ?? listenInferenceError;
      try {
        unsubs.push(
          await listenProgress((payload) => {
            if (payload.id !== jobId) return;
            const cur = queueStore
              .getState()
              .items.find((i) => i.id === next.id);
            if (cur?.status !== "processing") return;
            queueStore.getState().patchItem(next.id, {
              progress: payload.pct,
              stage: payload.stage,
            });
          }),
        );

        let terminal: "done" | "error" | "cancel" | null = null;
        let terminalOutput = outputPath;
        let terminalError = { code: "unknown", message: "failed" };

        unsubs.push(
          await listenDone((payload) => {
            if (payload.id !== jobId) return;
            terminal = "done";
            terminalOutput = payload.output_path;
          }),
        );
        unsubs.push(
          await listenError((payload) => {
            if (payload.id !== jobId) return;
            const parsed =
              typeof payload.code === "string" && payload.code.length > 0
                ? { code: payload.code, message: payload.message }
                : parseAppError(payload.message);
            if (
              parsed.code === ERROR_CODES.cancelled ||
              payload.message === "cancelled"
            ) {
              terminal = "cancel";
            } else {
              terminal = "error";
              terminalError = {
                code: parsed.code,
                message: parsed.message || payload.message,
              };
            }
          }),
        );

        try {
          await deps.removeBackground({
            id: jobId,
            inputPath: next.inputPath,
            outputPath,
            modelId: liveSettings.mode,
          });
          // Invoke resolves after job; prefer event if it won the race.
          if (terminal === null) terminal = "done";
        } catch (err: unknown) {
          const parsed = parseAppError(err);
          if (
            parsed.code === ERROR_CODES.cancelled ||
            queueStore.getState().cancelRequested
          ) {
            terminal = "cancel";
          } else {
            terminal = "error";
            terminalError = {
              code: parsed.code,
              message: parsed.message,
            };
          }
        }

        // Brief wait for late events if invoke returned first.
        if (terminal === "done" || terminal === null) {
          await new Promise((r) => setTimeout(r, 30));
        }

        if (queueStore.getState().cancelRequested || terminal === "cancel") {
          queueStore.getState().patchItem(next.id, {
            status: "pending",
            progress: 0,
            stage: null,
            jobId: null,
            error: null,
          });
          try {
            await deps.cancelInference(jobId);
          } catch {
            // slot may already be free
          }
          wasCancelled = true;
          break;
        }

        if (terminal === "error") {
          queueStore.getState().markFailed(next.id, terminalError);
          failed += 1;
          continue;
        }

        queueStore.getState().markDone(next.id, terminalOutput);
        succeeded += 1;
      } finally {
        for (const u of unsubs) u();
      }
    }
  } finally {
    runLoopActive = false;
    queueStore.getState().setRunning(false);
    queueStore.getState().setCancelRequested(false);
    if (!wasCancelled) {
      showFinishNotice(succeeded, failed);
    }
  }

  return "started";
}

/**
 * Request cancel of the current queue run and best-effort cancel of the active job.
 * Callers that mutate the queue afterward must await waitForQueueIdle() so the loop exits first.
 */
export async function cancelQueueProcess(
  deps: Pick<QueueRunnerDeps, "cancelInference"> = {
    cancelInference: invokeCancelInference,
  },
): Promise<void> {
  const state = queueStore.getState();
  if (!runLoopActive && !state.running) return;
  // After cancel, watch keeps enqueueing but does not auto-start until Process.
  void import("./folderWatch").then((m) => {
    m.pauseWatchAutoRun();
  });
  queueStore.getState().setCancelRequested(true);
  const current = state.items.find((i) => i.status === "processing");
  if (current?.jobId) {
    try {
      await deps.cancelInference(current.jobId);
    } catch {
      try {
        await deps.cancelInference(current.jobId);
      } catch {
        // keep cancelRequested; loop will still exit
      }
    }
  }
}

export function prodQueueRunnerDeps(): QueueRunnerDeps {
  const start = prodStartProcessDeps();
  const cancel = prodCancelDeps();
  return {
    exists: start.exists,
    chooseOverwrite: prodBatchOverwriteChooser,
    removeBackground: start.removeBackground,
    cancelInference: cancel.cancelInference,
    getSettings: start.getSettings,
  };
}

// Keep imports used when tree-shaken tests mock modules.
void invokePathExists;
void invokeRemoveImageBackground;
void settingsStore;
