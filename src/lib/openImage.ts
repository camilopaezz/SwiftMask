import { open } from "@tauri-apps/plugin-dialog";
import { isProcessBusy, type ProcessSettings } from "./currentImage";
import { loadSingleImage } from "./queue";
import { showAppErrorNotice } from "./showAppErrorNotice";

async function pickImagePath(): Promise<string | null> {
  const selected = await open({
    multiple: false,
    filters: [
      {
        name: "Images",
        extensions: ["png", "jpg", "jpeg", "webp", "bmp"],
      },
    ],
  });
  if (selected == null) return null;
  return Array.isArray(selected) ? (selected[0] ?? null) : selected;
}

/** Open the native picker and load the chosen image into classic single-image UI. */
export async function openImageFile(
  settings: ProcessSettings,
): Promise<boolean> {
  if (isProcessBusy()) return false;
  try {
    const path = await pickImagePath();
    if (!path) return false;
    if (isProcessBusy()) return false;
    return loadSingleImage(path, settings);
  } catch (err) {
    console.error("open image dialog failed", err);
    showAppErrorNotice(err);
    return false;
  }
}
