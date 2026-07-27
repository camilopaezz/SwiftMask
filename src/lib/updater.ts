import { isTauri } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import {
  check,
  type DownloadEvent,
  type Update,
} from "@tauri-apps/plugin-updater";

/** Delay after cold start before the silent network check. */
export const STARTUP_UPDATE_CHECK_DELAY_MS = 3000;

export type UpdateInfo = {
  version: string;
  currentVersion: string;
  notes?: string;
  date?: string;
};

export type CheckUpdateResult =
  | { status: "unavailable" }
  | { status: "up-to-date" }
  | { status: "available"; update: Update; info: UpdateInfo };

export type DownloadProgress = {
  downloaded: number;
  contentLength?: number;
  /** 0–100 when content length is known. */
  percent?: number;
  phase: "started" | "progress" | "finished";
};

export type ProgressAccumulator = {
  downloaded: number;
  contentLength?: number;
};

/** Pure progress state machine for download events (unit-testable). */
export function applyDownloadEvent(
  state: ProgressAccumulator,
  event: DownloadEvent,
): { next: ProgressAccumulator; progress: DownloadProgress } {
  if (event.event === "Started") {
    const next: ProgressAccumulator = {
      downloaded: 0,
      contentLength: event.data.contentLength,
    };
    return {
      next,
      progress: {
        downloaded: 0,
        contentLength: next.contentLength,
        percent: next.contentLength ? 0 : undefined,
        phase: "started",
      },
    };
  }

  if (event.event === "Progress") {
    const downloaded = state.downloaded + event.data.chunkLength;
    const next: ProgressAccumulator = {
      downloaded,
      contentLength: state.contentLength,
    };
    const percent =
      next.contentLength && next.contentLength > 0
        ? Math.min(100, Math.round((downloaded / next.contentLength) * 100))
        : undefined;
    return {
      next,
      progress: {
        downloaded,
        contentLength: next.contentLength,
        percent,
        phase: "progress",
      },
    };
  }

  // Finished
  const percent =
    state.contentLength && state.contentLength > 0 ? 100 : undefined;
  return {
    next: state,
    progress: {
      downloaded: state.downloaded,
      contentLength: state.contentLength,
      percent,
      phase: "finished",
    },
  };
}

export function updateInfoFromUpdate(update: Update): UpdateInfo {
  return {
    version: update.version,
    currentVersion: update.currentVersion,
    notes: update.body,
    date: update.date,
  };
}

/**
 * Check GitHub Releases (`latest.json`) for a newer signed build.
 * Returns `unavailable` outside the Tauri runtime (browser / mocked e2e).
 */
export async function checkForUpdate(): Promise<CheckUpdateResult> {
  if (!isTauri()) {
    return { status: "unavailable" };
  }

  const update = await check();
  if (!update) {
    return { status: "up-to-date" };
  }

  return {
    status: "available",
    update,
    info: updateInfoFromUpdate(update),
  };
}

/**
 * Download + install the update package, then relaunch.
 *
 * On Windows the process may exit during install before `relaunch` runs.
 * After a successful `downloadAndInstall`, relaunch failures are ignored so
 * callers do not surface a false "install failed" notice.
 */
export async function installUpdateAndRelaunch(
  update: Update,
  onProgress?: (progress: DownloadProgress) => void,
): Promise<void> {
  let acc: ProgressAccumulator = { downloaded: 0 };

  await update.downloadAndInstall((event) => {
    const { next, progress } = applyDownloadEvent(acc, event);
    acc = next;
    onProgress?.(progress);
  });

  try {
    await relaunch();
  } catch (err) {
    // Install already applied; process may be exiting (common on Windows NSIS).
    console.error(
      "relaunch after update failed (install may still have applied)",
      err,
    );
  }
}

/** Map a thrown updater failure to a stable code + message for notices. */
export function classifyUpdaterError(
  err: unknown,
  phase: "check" | "install",
): {
  code: "update_check_failed" | "update_install_failed";
  message: string;
} {
  const message =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : "unknown updater error";

  return {
    code: phase === "install" ? "update_install_failed" : "update_check_failed",
    message,
  };
}

/** True when Settings should enable the primary Check action. */
export function canCheckForUpdates(
  status:
    | "idle"
    | "checking"
    | "up-to-date"
    | "available"
    | "downloading"
    | "error"
    | "restarting",
): boolean {
  return (
    status === "idle" ||
    status === "up-to-date" ||
    status === "error" ||
    status === "available"
  );
}
