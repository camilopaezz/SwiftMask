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

  if (queueActive) {
    const n = queueItems.length;
    const folderLabel =
      source?.kind === "folder"
        ? folderDisplayName(source.path)
        : `${n} image${n === 1 ? "" : "s"} in queue`;
    return (
      <div className="file-block">
        <div
          className="file-block-name"
          title={
            source?.kind === "folder"
              ? `${source.path} → ${source.outputDir}`
              : `${n} images in queue`
          }
        >
          {folderLabel}
        </div>
        {source?.kind !== "folder" && (
          <div className="file-block-empty" style={{ marginTop: -4 }}>
            Drop more to append
          </div>
        )}
        {source?.kind === "folder" && (
          <label
            className={`watch-toggle${source.watch ? " is-on" : ""}${busy && !source.watch ? " is-disabled" : ""}`}
          >
            <input
              type="checkbox"
              role="switch"
              checked={source.watch}
              disabled={busy && !source.watch}
              onChange={(e) => {
                void setFolderWatch(e.target.checked);
              }}
            />
            <span className="watch-toggle-track" aria-hidden>
              <span className="watch-toggle-thumb" />
            </span>
            <span className="watch-toggle-label">Watch folder</span>
          </label>
        )}
        <div className="file-block-actions">
          <button
            type="button"
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

  if (!current) {
    return (
      <div className="file-block">
        <div className="file-block-empty">No image</div>
        <div className="file-block-actions">
          <button
            type="button"
            className="btn-primary"
            title="Select image (Ctrl+O)"
            onClick={() => void handleSelect()}
          >
            Select image
          </button>
          <button
            type="button"
            title="Open folder (Ctrl+Shift+O)"
            onClick={() => void handleOpenFolder()}
          >
            Open folder…
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="file-block">
      <div className="file-block-name" title={current.inputPath}>
        {fileNameFromPath(current.inputPath)}
      </div>
      <div className="file-block-actions">
        <button
          type="button"
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
        <button
          type="button"
          className="btn-danger"
          onClick={handleRemove}
          disabled={busy}
        >
          Remove
        </button>
      </div>
    </div>
  );
}
