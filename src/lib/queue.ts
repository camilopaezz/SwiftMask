import { ask } from "@tauri-apps/plugin-dialog";
import { imageStore } from "../stores/imageStore";
import { type QueueItem, queueStore } from "../stores/queueStore";
import { uiStore } from "../stores/uiStore";
import { isProcessBusy, type ProcessSettings } from "./currentImage";
import { deriveOutputPath } from "./path";
import { isQueueRunActive } from "./queueRunner";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "bmp"]);

export const QUEUE_ENQUEUE_CONFIRM_THRESHOLD = 200;

function getExtension(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot >= 0 ? path.slice(dot + 1).toLowerCase() : "";
}

export function isImageFile(path: string): boolean {
  return IMAGE_EXTENSIONS.has(getExtension(path));
}

function normalizePathKey(path: string): string {
  return path;
}

function existingPathSet(): Set<string> {
  return new Set(
    queueStore.getState().items.map((i) => normalizePathKey(i.inputPath)),
  );
}

function makeItems(paths: string[], settings: ProcessSettings): QueueItem[] {
  return paths.map((inputPath) => ({
    id: crypto.randomUUID(),
    inputPath,
    outputPath: deriveOutputPath(inputPath, settings.outputDir, settings.mode),
    status: "pending" as const,
    progress: 0,
    stage: null,
    error: null,
    jobId: null,
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

export async function enqueueFromDrop(
  paths: string[],
  settings: ProcessSettings,
  deps: {
    askConfirm: (message: string) => Promise<boolean>;
  } = { askConfirm: (msg) => ask(msg) },
): Promise<EnqueueDropResult> {
  // Allow append while queue is running; block only classic single-image busy.
  if (isProcessBusy() && !isQueueRunActive()) return "busy";

  const imagePaths = paths.filter(isImageFile);
  const nonImagePaths = paths.filter((p) => !isImageFile(p));

  if (imagePaths.length === 0) {
    showInfo(
      "Open folder comes in a later step",
      nonImagePaths.length > 0
        ? "Drop image files to build a queue. Folder open arrives in a later update."
        : undefined,
    );
    return "rejected";
  }

  if (nonImagePaths.length > 0) {
    showInfo(
      "Drop either images or one folder",
      "Mixed drops are not supported. Folder open arrives in a later update.",
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

  const items = makeItems(fresh, settings);
  const wasActive = queueStore.getState().active;

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
  if (isProcessBusy() || isQueueRunActive()) return false;
  if (!isImageFile(path)) return false;

  const q = queueStore.getState();
  if (q.active && q.items.length > 0) {
    const live = q.running || q.items.some((i) => i.status === "processing");
    const ok = await deps.askConfirm(
      live
        ? "Leave the queue? Pending work will be cancelled and the queue cleared."
        : "Leave the queue and open a single image? The queue will be cleared.",
    );
    if (!ok) return false;
    if (isProcessBusy() || isQueueRunActive()) return false;
    queueStore.getState().clearAll();
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
  if (q.running || q.items.some((i) => i.status === "processing")) {
    const ok = await ask("Stop processing and clear the queue?");
    if (!ok) return;
    const { cancelQueueProcess } = await import("./queueRunner");
    await cancelQueueProcess();
  }
  queueStore.getState().clearAll();
}

export function selectQueueItem(id: string): void {
  queueStore.getState().select(id);
}

export function getSelectedQueueItem(): QueueItem | null {
  const { items, selectedId } = queueStore.getState();
  if (!selectedId) return null;
  return items.find((i) => i.id === selectedId) ?? null;
}
