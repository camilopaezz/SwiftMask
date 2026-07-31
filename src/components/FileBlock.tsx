import { clearCurrent, isProcessBusy } from "../lib/currentImage";
import { openImageFile } from "../lib/openImage";
import { clearQueue } from "../lib/queue";
import { useImageStore } from "../stores/imageStore";
import { fileNameFromPath, useQueueStore } from "../stores/queueStore";
import { useSettingsStore } from "../stores/settingsStore";

export function FileBlock() {
  const current = useImageStore((state) => state.current);
  const queueActive = useQueueStore((state) => state.active);
  const queueItems = useQueueStore((state) => state.items);
  const mode = useSettingsStore((state) => state.mode);
  const outputDir = useSettingsStore((state) => state.outputDir);
  const busy = current?.status === "processing" || isProcessBusy();

  const handleSelect = async () => {
    await openImageFile({ mode, outputDir });
  };

  const handleRemove = () => {
    clearCurrent();
  };

  const handleClearQueue = () => {
    clearQueue();
  };

  // Queue mode: source summary + open single / clear queue.
  if (queueActive) {
    const n = queueItems.length;
    return (
      <div className="file-block">
        <div className="file-block-name" title={`${n} images in queue`}>
          {n} image{n === 1 ? "" : "s"} in queue
        </div>
        <div className="file-block-empty" style={{ marginTop: -4 }}>
          Drop more to append
        </div>
        <div className="file-block-actions">
          <button
            type="button"
            className="btn-primary"
            title="Select image (Ctrl+O)"
            onClick={() => void handleSelect()}
            disabled={busy}
          >
            Select image
          </button>
          <button
            type="button"
            className="btn-danger"
            title="Clear queue"
            onClick={handleClearQueue}
            disabled={busy}
          >
            Clear queue
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
          <button type="button" title="Open folder (coming later)" disabled>
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
          title="Change image (Ctrl+O)"
          onClick={() => void handleSelect()}
          disabled={busy}
        >
          Change
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
