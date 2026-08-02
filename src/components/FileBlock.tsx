import { clearCurrent, isProcessBusy } from "../lib/currentImage";
import { setFolderWatch } from "../lib/folderWatch";
import { openImageFile } from "../lib/openImage";
import { folderDisplayName, pickAndOpenFolder } from "../lib/queue";
import { isQueueRunActive } from "../lib/queueRunner";
import { useImageStore } from "../stores/imageStore";
import { fileNameFromPath, useQueueStore } from "../stores/queueStore";
import { useSettingsStore } from "../stores/settingsStore";

export function FileBlock() {
  const current = useImageStore((state) => state.current);
  const queueActive = useQueueStore((state) => state.active);
  const queueItems = useQueueStore((state) => state.items);
  const source = useQueueStore((state) => state.source);
  const queueRunning = useQueueStore((state) => state.running);
  const mode = useSettingsStore((state) => state.mode);
  const outputDir = useSettingsStore((state) => state.outputDir);
  const busy =
    current?.status === "processing" ||
    isProcessBusy() ||
    queueRunning ||
    isQueueRunActive();

  const handleSelect = async () => {
    await openImageFile({ mode, outputDir });
  };

  const handleOpenFolder = async () => {
    await pickAndOpenFolder({ mode, outputDir });
  };

  const handleRemove = () => {
    clearCurrent();
  };

  let title = "No image";
  let subtitle = "Select or open a folder";
  let titleMuted = true;
  let titleAttr: string | undefined;
  let showWatch = false;
  let watchOn = false;
  let watchDisabled = false;
  let emptyPrimary = true;
  let showRemove = false;

  if (queueActive) {
    emptyPrimary = false;
    titleMuted = false;
    const n = queueItems.length;
    if (source?.kind === "folder") {
      title = folderDisplayName(source.path);
      titleAttr = `${source.path} → ${source.outputDir}`;
      showWatch = true;
      watchOn = source.watch;
      watchDisabled = busy && !source.watch;
      subtitle = source.watch ? "Watching · top-level only" : "Folder session";
    } else {
      title = `${n} image${n === 1 ? "" : "s"} in queue`;
      titleAttr = `${n} images in queue`;
      subtitle = "Drop more to append";
    }
  } else if (current) {
    emptyPrimary = false;
    titleMuted = false;
    title = fileNameFromPath(current.inputPath);
    titleAttr = current.inputPath;
    subtitle = "Single image";
    showRemove = true;
  }

  return (
    <div className="file-block">
      <div className="file-block-source" title={titleAttr}>
        <div className="file-block-source-text">
          <strong className={titleMuted ? "is-muted" : undefined}>
            {title}
          </strong>
          <span>{subtitle}</span>
        </div>
        {showWatch && (
          <label
            className={`watch-toggle${watchOn ? " is-on" : ""}${watchDisabled ? " is-disabled" : ""}`}
          >
            <input
              type="checkbox"
              role="switch"
              aria-checked={watchOn}
              checked={watchOn}
              disabled={watchDisabled}
              onChange={(e) => {
                void setFolderWatch(e.target.checked);
              }}
            />
            <span className="watch-toggle-track" aria-hidden>
              <span className="watch-toggle-thumb" />
            </span>
            <span className="watch-toggle-label">Watch</span>
          </label>
        )}
        {showRemove && (
          <button
            type="button"
            className="file-block-remove btn-ghost"
            title="Remove image"
            aria-label="Remove image"
            onClick={handleRemove}
            disabled={busy}
          >
            Remove
          </button>
        )}
      </div>

      <div className="file-block-actions">
        <button
          type="button"
          className={emptyPrimary ? "btn-primary" : undefined}
          title="Select image (Ctrl+O)"
          onClick={() => void handleSelect()}
          disabled={busy}
        >
          Select image
        </button>
        <button
          type="button"
          title="Open folder (Ctrl+Shift+O)"
          onClick={() => void handleOpenFolder()}
          disabled={busy}
        >
          Open folder…
        </button>
      </div>
    </div>
  );
}
