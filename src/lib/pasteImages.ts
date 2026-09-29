import i18n from "../i18n";
import { imageStore } from "../stores/imageStore";
import { queueStore } from "../stores/queueStore";
import { settingsStore } from "../stores/settingsStore";
import { uiStore } from "../stores/uiStore";
import { isProcessBusy, type ProcessSettings } from "./currentImage";
import { deriveOutputPath, resolveOutputDir } from "./path";
import { enqueueClipboardImages, isImageFile } from "./queue";
import { showAppErrorNotice } from "./showAppErrorNotice";
import { type ClipboardImages, invokeImportClipboardImages } from "./tauri";

export type PasteDeps = {
  importImages: () => Promise<ClipboardImages>;
  getSettings: () => ProcessSettings;
};

const productionDeps: PasteDeps = {
  importImages: invokeImportClipboardImages,
  getSettings: () => {
    const { mode, outputDir } = settingsStore.getState();
    return { mode, outputDir };
  },
};

let pasteInFlight = false;

/** Import clipboard image files or pixels into the current single/queue workflow. */
export async function pasteImages(
  deps: PasteDeps = productionDeps,
): Promise<void> {
  if (pasteInFlight) return;
  const queue = queueStore.getState();
  if (!queue.active && isProcessBusy()) {
    uiStore.getState().showNotice({
      severity: "info",
      title: i18n.t("paste.busy.title"),
      body: i18n.t("paste.busy.body"),
      code: "paste_busy",
    });
    return;
  }

  pasteInFlight = true;
  try {
    const result = await deps.importImages();
    if (!result.paths?.length) return;
    if (!queueStore.getState().active && isProcessBusy()) {
      uiStore.getState().showNotice({
        severity: "info",
        title: i18n.t("paste.busy.title"),
        body: i18n.t("paste.busy.body"),
        code: "paste_busy",
      });
      return;
    }
    const paths = result.paths.filter(isImageFile);
    // Unsupported clipboard content is a deliberate no-op.
    if (!paths.length) return;
    const settings = deps.getSettings();
    const defaultOutputDir =
      result.kind === "pixels" ? result.default_output_dir : null;

    if (queueStore.getState().active) {
      enqueueClipboardImages(paths, settings, defaultOutputDir);
      return;
    }
    if (paths.length > 1) {
      enqueueClipboardImages(paths, settings, defaultOutputDir);
      return;
    }
    const path = paths[0];
    if (!path) return;
    const item = {
      id: crypto.randomUUID(),
      inputPath: path,
      outputPath: deriveOutputPath(
        path,
        resolveOutputDir(settings.outputDir, defaultOutputDir),
        settings.mode,
      ),
      status: "ready" as const,
      progress: 0,
      stage: null,
      error: null,
      ...(defaultOutputDir ? { defaultOutputDir } : {}),
    };
    imageStore.getState().set(item);
  } catch (err) {
    console.error("paste images failed", err);
    showAppErrorNotice(err);
  } finally {
    pasteInFlight = false;
  }
}

export function resetPasteInFlightForTests(): void {
  pasteInFlight = false;
}
