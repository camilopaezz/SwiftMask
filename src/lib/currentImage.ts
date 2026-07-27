import { ask } from "@tauri-apps/plugin-dialog";
import { type ImageItem, imageStore } from "../stores/imageStore";
import { settingsStore } from "../stores/settingsStore";
import { uiStore } from "../stores/uiStore";
import { formatFallbackNotice } from "./errorCopy";
import { shouldProceedWithOverwrite } from "./overwrite";
import { ERROR_CODES, parseAppError } from "./parseAppError";
import { deriveOutputPath } from "./path";
import {
  type InferenceDonePayload,
  type InferenceErrorPayload,
  type InferenceFallbackPayload,
  type InferenceProgressPayload,
  invokeCancelInference,
  invokePathExists,
  invokeRemoveImageBackground,
  listenInferenceDone,
  listenInferenceError,
  listenInferenceFallback,
  listenInferenceProgress,
} from "./tauri";

export type ProcessSettings = { mode: string; outputDir: string | null };

export type StartProcessDeps = {
  exists: (path: string) => Promise<boolean>;
  ask: (message: string) => Promise<boolean>;
  removeBackground: (job: {
    id: string;
    inputPath: string;
    outputPath: string;
    modelId: string;
  }) => Promise<void>;
  getSettings: () => ProcessSettings;
};

export type CancelDeps = {
  cancelInference: (jobId: string) => Promise<void>;
};

export type StartProcessResult =
  | "started"
  | "skipped"
  | "no-image"
  | "already-processing"
  | "failed";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "bmp"]);

/** True while overwrite confirm / start handoff is in flight (before status is processing). */
let processGate = false;

/**
 * True while cancel is waiting for the backend inference slot to free.
 * Keeps Process disabled even after optimistic "cancelled" status so a second
 * click cannot overlap the still-running worker (RAM spike).
 */
let cancelGate = false;

/**
 * Backend job id for the active run (UUID per Process click — not the image id).
 * Events are keyed on this so cancel → re-run cannot clobber the new job.
 */
let activeRunId: string | null = null;

/** Run ids the user cancelled; late done/error/progress for these are ignored. */
const discardedRunIds = new Set<string>();

/** Test-only: clear gate left open by aborted/timed-out startProcess. */
export function resetProcessGateForTests(): void {
  processGate = false;
  cancelGate = false;
  activeRunId = null;
  discardedRunIds.clear();
}

/** Test-only: bind event handlers to a run id without going through startProcess. */
export function setActiveRunIdForTests(runId: string | null): void {
  activeRunId = runId;
}

function getExtension(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot >= 0 ? path.slice(dot + 1).toLowerCase() : "";
}

function isImageFile(path: string): boolean {
  return IMAGE_EXTENSIONS.has(getExtension(path));
}

/**
 * Resolve whether a backend event should mutate image state.
 *
 * - Prefer `activeRunId` when set (prod Process path).
 * - Fall back to matching `current.id` for tests that skip startProcess.
 * - Terminal events (done/error/fallback) remove discarded run ids so the set
 *   does not grow; progress leaves them (cancel may still hold the slot).
 * - Progress only applies while status is `processing` (no late resurrection).
 * - Done/error/fallback ignore already-cancelled UI (optimistic cancel).
 */
function resolveRunEvent(
  runId: string,
  opts: { terminal: boolean; requireProcessing: boolean },
): ImageItem | null {
  if (discardedRunIds.has(runId)) {
    if (opts.terminal) discardedRunIds.delete(runId);
    return null;
  }
  const current = imageStore.getState().current;
  if (!current) return null;

  if (activeRunId !== null) {
    if (runId !== activeRunId) return null;
  } else if (current.id !== runId) {
    return null;
  }

  if (opts.requireProcessing) {
    if (current.status !== "processing") return null;
  } else if (current.status === "cancelled") {
    return null;
  }

  return current;
}

/** Domain busy: backend processing, cancel wait, or overwrite/start handoff. */
export function isProcessBusy(): boolean {
  return (
    processGate ||
    cancelGate ||
    imageStore.getState().current?.status === "processing"
  );
}

export function acceptDrop(
  paths: string[],
  settings: ProcessSettings,
): boolean {
  const imagePaths = paths.filter(isImageFile);
  if (imagePaths.length === 0) return false;
  if (isProcessBusy()) return false;

  const inputPath = imagePaths[0];
  const item: ImageItem = {
    id: crypto.randomUUID(),
    inputPath,
    outputPath: deriveOutputPath(inputPath, settings.outputDir, settings.mode),
    status: "ready",
    progress: 0,
    stage: null,
    error: null,
  };
  imageStore.getState().set(item);
  return true;
}

export function syncOutputPath(settings: ProcessSettings): void {
  const current = imageStore.getState().current;
  if (!current || isProcessBusy()) return;
  const outputPath = deriveOutputPath(
    current.inputPath,
    settings.outputDir,
    settings.mode,
  );
  if (outputPath === current.outputPath) return;

  // If mode/output dir change after a successful run, the derived path is not
  // the last result file — drop "done" so compare / Show in folder do not lie.
  if (current.status === "done") {
    imageStore.getState().patch({
      outputPath,
      status: "ready",
      progress: 0,
      stage: null,
      error: null,
    });
    return;
  }

  imageStore.getState().patch({ outputPath });
}

export async function startProcess(
  deps: StartProcessDeps,
): Promise<StartProcessResult> {
  const current = imageStore.getState().current;
  if (!current) return "no-image";
  if (isProcessBusy()) return "already-processing";

  processGate = true;
  const startedId = current.id;
  const inputPath = current.inputPath;

  try {
    const settings = deps.getSettings();
    const outputPath = deriveOutputPath(
      inputPath,
      settings.outputDir,
      settings.mode,
    );

    const proceed = await shouldProceedWithOverwrite(
      outputPath,
      deps.exists,
      deps.ask,
    );
    if (!proceed) return "skipped";

    // Re-validate after await: drop/clear/second start must not drive a stale job.
    const latest = imageStore.getState().current;
    if (!latest || latest.id !== startedId) return "skipped";
    if (latest.status === "processing") return "already-processing";

    const finalOutputPath = deriveOutputPath(
      latest.inputPath,
      settings.outputDir,
      settings.mode,
    );

    // Per-run id so late events from a cancelled attempt cannot match a re-run.
    const runId = crypto.randomUUID();
    activeRunId = runId;
    imageStore.getState().patch({
      status: "processing",
      progress: 0,
      stage: "starting",
      error: null,
      outputPath: finalOutputPath,
    });

    try {
      await deps.removeBackground({
        id: runId,
        inputPath: latest.inputPath,
        outputPath: finalOutputPath,
        modelId: settings.mode,
      });
      return "started";
    } catch (err: unknown) {
      // e.g. backend "already processing" — do not leave status stuck on processing.
      if (activeRunId === runId) {
        activeRunId = null;
      }
      const still = imageStore.getState().current;
      if (still?.id === startedId && still.status === "processing") {
        const parsed = parseAppError(err);
        if (parsed.code === ERROR_CODES.cancelled) {
          imageStore.getState().patch({
            status: "cancelled",
            stage: null,
            error: null,
          });
        } else {
          imageStore.getState().patch({
            status: "error",
            stage: null,
            error: { code: parsed.code, message: parsed.message },
          });
        }
      }
      return "failed";
    }
  } finally {
    processGate = false;
    // Done/error events often land before this invoke returns. FileBlock (and
    // anything else) that ORs isProcessBusy() into disabled state will still
    // see processGate=true on that render and never re-read the gate unless we
    // nudge store subscribers after clearing it (same pattern as cancelProcess).
    const still = imageStore.getState().current;
    if (still?.id === startedId) {
      imageStore.getState().patch({ status: still.status });
    }
  }
}

/**
 * Optimistically marks the UI cancelled, then waits for backend cancel to free
 * the inference slot before allowing another Process.
 */
export async function cancelProcess(deps: CancelDeps): Promise<void> {
  const current = imageStore.getState().current;
  if (current?.status !== "processing") return;
  if (cancelGate) return;

  const runId = activeRunId ?? current.id;
  discardedRunIds.add(runId);
  activeRunId = null;
  cancelGate = true;
  imageStore.getState().patch({
    status: "cancelled",
    progress: 0,
    stage: null,
    error: null,
  });
  try {
    await deps.cancelInference(runId);
  } catch {
    // Slot may still be held — keep cancelGate so Process stays blocked.
    // Best-effort retry once; if that fails, leave the gate set so we do not
    // re-enable start while the backend may still be busy (backend single-flight
    // still rejects overlap). User can retry cancel; tests use resetProcessGateForTests.
    try {
      await deps.cancelInference(runId);
    } catch {
      // Nudge subscribers so UI reflects cancelled + still-busy gate.
      const still = imageStore.getState().current;
      if (still) {
        imageStore.getState().patch({ status: still.status });
      }
      return;
    }
  }
  cancelGate = false;
  // Nudge store subscribers (FileBlock, etc.) so they re-read isProcessBusy().
  const still = imageStore.getState().current;
  if (still) {
    imageStore.getState().patch({ status: still.status });
  }
}

/** Returns false if clear was rejected because a process is busy. */
export function clearCurrent(): boolean {
  if (isProcessBusy()) return false;
  imageStore.getState().clear();
  return true;
}

export function applyProgress(payload: {
  id: string;
  stage: string;
  pct: number;
}): void {
  if (
    !resolveRunEvent(payload.id, {
      terminal: false,
      requireProcessing: true,
    })
  ) {
    return;
  }
  imageStore.getState().patch({
    status: "processing",
    progress: payload.pct,
    stage: payload.stage,
  });
}

/** @returns true if the done event was applied to image state. */
export function applyDone(payload: InferenceDonePayload): boolean {
  if (
    !resolveRunEvent(payload.id, {
      terminal: true,
      requireProcessing: false,
    })
  ) {
    return false;
  }
  imageStore.getState().patch({
    status: "done",
    progress: 100,
    stage: null,
    outputPath: payload.output_path,
  });
  return true;
}

export function applyError(payload: {
  id: string;
  code?: string;
  message: string;
}): void {
  if (
    !resolveRunEvent(payload.id, {
      terminal: true,
      requireProcessing: false,
    })
  ) {
    return;
  }
  const parsed =
    typeof payload.code === "string" && payload.code.length > 0
      ? { code: payload.code, message: payload.message }
      : parseAppError(payload.message);
  const code = parsed.code;
  const message = parsed.message || payload.message;
  if (code === ERROR_CODES.cancelled || message === "cancelled") {
    imageStore.getState().patch({
      status: "cancelled",
      stage: null,
      error: null,
    });
    return;
  }
  imageStore.getState().patch({
    status: "error",
    stage: null,
    error: { code, message },
  });
}

/** Apply GPU→CPU fallback notice for the active run (process stays non-error). */
export function applyFallback(payload: InferenceFallbackPayload): void {
  if (
    !resolveRunEvent(payload.id, {
      terminal: true,
      requireProcessing: false,
    })
  ) {
    return;
  }

  const copy = formatFallbackNotice(payload.from_ep, payload.to_ep);
  uiStore.getState().showNotice({
    severity: "warning",
    title: copy.title,
    body: copy.body,
    code: "inference_fallback",
  });
}

export async function initCurrentImageListeners(): Promise<() => void> {
  const unsubscribeProgress = await listenInferenceProgress(
    (payload: InferenceProgressPayload) => {
      applyProgress(payload);
    },
  );

  const unsubscribeDone = await listenInferenceDone(
    (payload: InferenceDonePayload) => {
      // Only record timings when the UI actually accepted the done event.
      if (applyDone(payload)) {
        settingsStore.getState().setLastJobTimings(payload.timings);
      }
    },
  );

  const unsubscribeError = await listenInferenceError(
    (payload: InferenceErrorPayload) => {
      applyError(payload);
    },
  );

  const unsubscribeFallback = await listenInferenceFallback(
    (payload: InferenceFallbackPayload) => {
      applyFallback(payload);
    },
  );

  return () => {
    unsubscribeProgress();
    unsubscribeDone();
    unsubscribeError();
    unsubscribeFallback();
  };
}

export function prodStartProcessDeps(): StartProcessDeps {
  return {
    // Native command — not plugin-fs — so arbitrary user paths work on Windows.
    exists: (p) => invokePathExists(p),
    ask: (msg) => ask(msg),
    removeBackground: invokeRemoveImageBackground,
    getSettings: () => {
      const s = settingsStore.getState();
      return { mode: s.mode, outputDir: s.outputDir };
    },
  };
}

export function prodCancelDeps(): CancelDeps {
  return {
    cancelInference: invokeCancelInference,
  };
}
