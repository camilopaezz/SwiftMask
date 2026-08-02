import { ask } from "@tauri-apps/plugin-dialog";
import { imageStore } from "../stores/imageStore";
import {
  type QueueItem,
  type QueueSource,
  queueStore,
} from "../stores/queueStore";
import { uiStore } from "../stores/uiStore";
import { isProcessBusy, type ProcessSettings } from "./currentImage";
import {
  baseName,
  deriveFolderOutputDir,
  deriveOutputPath,
  normalizePathKey,
} from "./path";
import {
  cancelQueueProcess,
  isQueueRunActive,
  waitForQueueIdle,
} from "./queueRunner";
import {
  invokeListFolderImages,
  invokePathIsDir,
  invokePickFolder,
} from "./tauri";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "bmp"]);

export const QUEUE_ENQUEUE_CONFIRM_THRESHOLD = 200;

function getExtension(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot >= 0 ? path.slice(dot + 1).toLowerCase() : "";
}

export function isImageFile(path: string): boolean {
  return IMAGE_EXTENSIONS.has(getExtension(path));
}

function existingPathSet(): Set<string> {
  return new Set(
    queueStore.getState().items.map((i) => normalizePathKey(i.inputPath)),
  );
}

/** Effective output dir: folder sibling for folder source, else settings.outputDir. */
export function queueOutputDir(
  settings: ProcessSettings,
  source: QueueSource | null = queueStore.getState().source,
): string | null {
  if (source?.kind === "folder") return source.outputDir;
  return settings.outputDir;
}

function makeItems(
  paths: string[],
  settings: ProcessSettings,
  source: QueueSource | null,
  opts?: { fromWatch?: boolean },
): QueueItem[] {
  const outDir = queueOutputDir(settings, source);
  const fromWatch = opts?.fromWatch === true;
  return paths.map((inputPath) => ({
    id: crypto.randomUUID(),
    inputPath,
    outputPath: deriveOutputPath(inputPath, outDir, settings.mode),
    status: "pending" as const,
    progress: 0,
    stage: null,
    error: null,
    jobId: null,
    ...(fromWatch ? { fromWatch: true } : {}),
  }));
}

function showInfo(title: string, body?: string): void {
  uiStore.getState().showNotice({
    severity: "info",
    title,
    body,
    code: "queue",
  });
}

export type EnqueueDropResult =
  | "enqueued"
  | "appended"
  | "rejected"
  | "busy"
  | "cancelled";

/**
 * Cancel active run (if any), stop folder watch, clear queue → classic idle.
 * Shared by clear all, replace folder, leave queue for single-image.
 */
async function endQueueSession(): Promise<void> {
  if (isQueueRunActive()) {
    await cancelQueueProcess();
    try {
      await waitForQueueIdle(10_000);
    } catch {
      // Timeout / orphaned running flag: force idle so leave/clear can proceed.
      queueStore.getState().setRunning(false);
      queueStore.getState().setCancelRequested(false);
    }
  }
  const { stopFolderWatch } = await import("./folderWatch");
  await stopFolderWatch();
  queueStore.getState().clearAll();
}

async function confirmReplaceIfNeeded(
  askConfirm: (message: string) => Promise<boolean>,
): Promise<boolean> {
  const q = queueStore.getState();
  if (!q.active || q.items.length === 0) return true;
  const live =
    q.running ||
    isQueueRunActive() ||
    q.items.some((i) => i.status === "processing");
  const ok = await askConfirm(
    live
      ? "Replace the current queue? Pending work will be cancelled."
      : "Replace the current queue with this folder?",
  );
  if (!ok) return false;
  await endQueueSession();
  return true;
}

/**
 * Open a folder as batch source: top-level images → queue, outputs to `{folder}-nobg/`.
 */
export async function openFolderAsQueue(
  folderPath: string,
  settings: ProcessSettings,
  deps: {
    askConfirm: (message: string) => Promise<boolean>;
    listImages?: (path: string) => Promise<string[]>;
  } = {
    askConfirm: (msg) => ask(msg),
  },
): Promise<"enqueued" | "empty" | "cancelled" | "busy" | "failed"> {
  if (isProcessBusy() && !isQueueRunActive()) return "busy";

  const listImages = deps.listImages ?? invokeListFolderImages;

  if (!(await confirmReplaceIfNeeded(deps.askConfirm))) {
    return "cancelled";
  }

  let images: string[];
  try {
    images = await listImages(folderPath);
  } catch (err) {
    console.error("list_folder_images failed", err);
    showInfo("Could not read folder", String(err));
    return "failed";
  }

  if (images.length === 0) {
    showInfo(
      "No images in this folder",
      "Only top-level PNG, JPG, WEBP, BMP are scanned (subfolders are ignored).",
    );
    return "empty";
  }

  if (images.length > QUEUE_ENQUEUE_CONFIRM_THRESHOLD) {
    const ok = await deps.askConfirm(`Enqueue ${images.length} images?`);
    if (!ok) return "cancelled";
  }

  // Path only — create `{folder}-nobg/` when Process actually starts (queueRunner).
  const outputDir = deriveFolderOutputDir(folderPath);

  imageStore.getState().clear();
  const source: QueueSource = {
    kind: "folder",
    path: folderPath,
    outputDir,
    watch: false,
  };
  const items = makeItems(images, settings, source);
  queueStore.getState().activateWithItems(items, source);
  return "enqueued";
}

export async function pickAndOpenFolder(
  settings: ProcessSettings,
): Promise<boolean> {
  try {
    const path = await invokePickFolder();
    if (!path) return false;
    const result = await openFolderAsQueue(path, settings);
    return result === "enqueued";
  } catch (err) {
    console.error("pick folder failed", err);
    showInfo("Could not open folder", String(err));
    return false;
  }
}

export async function enqueueFromDrop(
  paths: string[],
  settings: ProcessSettings,
  deps: {
    askConfirm: (message: string) => Promise<boolean>;
    pathIsDir?: (path: string) => Promise<boolean>;
    /** Mark new rows as watch arrivals (auto-run scope). */
    fromWatch?: boolean;
  } = { askConfirm: (msg) => ask(msg) },
): Promise<EnqueueDropResult> {
  if (isProcessBusy() && !isQueueRunActive()) return "busy";

  const pathIsDir = deps.pathIsDir ?? invokePathIsDir;

  // Classify directories vs files (Tauri may drop a folder path alone).
  const dirFlags = await Promise.all(paths.map((p) => pathIsDir(p)));
  const dirs = paths.filter((_, i) => dirFlags[i]);
  const files = paths.filter((_, i) => !dirFlags[i]);
  const imagePaths = files.filter(isImageFile);
  const nonImageFiles = files.filter((p) => !isImageFile(p));

  if (
    dirs.length > 0 &&
    (imagePaths.length > 0 || nonImageFiles.length > 0 || dirs.length > 1)
  ) {
    showInfo(
      "Drop either images or one folder",
      "Mixed drops and multi-folder drops are not supported.",
    );
    return "rejected";
  }

  const singleDir = dirs.length === 1 ? dirs[0] : undefined;
  if (singleDir !== undefined) {
    const result = await openFolderAsQueue(singleDir, settings, {
      askConfirm: deps.askConfirm,
    });
    if (result === "enqueued") return "enqueued";
    if (result === "cancelled") return "cancelled";
    if (result === "busy") return "busy";
    return "rejected";
  }

  if (imagePaths.length === 0) {
    showInfo(
      "No images dropped",
      nonImageFiles.length > 0
        ? "Drop PNG, JPG, WEBP, or BMP files, or one folder."
        : undefined,
    );
    return "rejected";
  }

  if (nonImageFiles.length > 0) {
    showInfo(
      "Drop either images or one folder",
      "Mixed drops are not supported.",
    );
    return "rejected";
  }

  const known = existingPathSet();
  const fresh = imagePaths.filter((p) => !known.has(normalizePathKey(p)));
  if (fresh.length === 0) {
    showInfo("Already in queue", "Those images are already listed.");
    return "rejected";
  }

  if (fresh.length > QUEUE_ENQUEUE_CONFIRM_THRESHOLD) {
    const ok = await deps.askConfirm(`Enqueue ${fresh.length} images?`);
    if (!ok) return "cancelled";
  }

  const wasActive = queueStore.getState().active;
  const source = wasActive
    ? queueStore.getState().source
    : ({ kind: "drop" } as QueueSource);
  // Dropping images onto a folder session: append with folder output rules.
  const items = makeItems(fresh, settings, source, {
    fromWatch: deps.fromWatch === true,
  });

  if (!wasActive) {
    imageStore.getState().clear();
  }

  if (wasActive) {
    queueStore.getState().appendItems(items);
    return "appended";
  }

  queueStore.getState().activateWithItems(items, { kind: "drop" });
  return "enqueued";
}

export async function loadSingleImage(
  path: string,
  settings: ProcessSettings,
  deps: {
    askConfirm: (message: string) => Promise<boolean>;
  } = { askConfirm: (msg) => ask(msg) },
): Promise<boolean> {
  // Classic single-image process busy gate only (queue run may still confirm leave).
  if (isProcessBusy() && !isQueueRunActive()) return false;
  if (!isImageFile(path)) return false;

  const q = queueStore.getState();
  if (q.active && q.items.length > 0) {
    const live =
      q.running ||
      isQueueRunActive() ||
      q.items.some((i) => i.status === "processing");
    const ok = await deps.askConfirm(
      live
        ? "Leave the queue? Pending work will be cancelled and the queue cleared."
        : "Leave the queue and open a single image? The queue will be cleared.",
    );
    if (!ok) return false;
    await endQueueSession();
  }

  const item = {
    id: crypto.randomUUID(),
    inputPath: path,
    outputPath: deriveOutputPath(path, settings.outputDir, settings.mode),
    status: "ready" as const,
    progress: 0,
    stage: null,
    error: null,
  };
  imageStore.getState().set(item);
  return true;
}

export function removeQueueItem(id: string): void {
  queueStore.getState().remove(id);
}

export async function clearQueue(): Promise<void> {
  const q = queueStore.getState();
  if (
    q.running ||
    isQueueRunActive() ||
    q.items.some((i) => i.status === "processing")
  ) {
    const ok = await ask("Stop processing and clear the queue?");
    if (!ok) return;
  }
  await endQueueSession();
}

export function selectQueueItem(id: string): void {
  queueStore.getState().select(id);
}

export function folderDisplayName(path: string): string {
  return baseName(path.replace(/[\\/]+$/, ""));
}
